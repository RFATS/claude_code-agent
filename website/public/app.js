// 급지 역전 탐지 — 프론트엔드 (바닐라 JS, DOM은 createElement + textContent 만 사용)
// 데이터는 서버가 요청마다 API 로 실시간 조회한다. 조회가 끝나기 전에는 state:"loading" 을 받아 폴링한다.
"use strict";

const BASIS_LABEL = { kook: "국평(전용 80~86㎡)", all: "전체 면적" };
const COLOR = { upper: "#1428A0", lower: "#C98A2E", band: "rgba(201,138,46,.16)", grid: "#F1F2F7", axis: "#DCE0E9", text: "#8B92A2" };
const SVG_NS = "http://www.w3.org/2000/svg";
const CUSTOM = "__custom__";
const POLL_MS = 900;

const state = { a: null, b: null, basis: "kook", from: "201201", step: 3, group: "default", areas: null, status: null, data: null, selected: 0 };
let runId = 0; // 최신 요청만 화면에 반영 (진행 중이던 이전 폴링은 버림)
let rankRun = 0;

// ---------- DOM 헬퍼 ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const $ = (id) => document.getElementById(id);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 포맷 ----------
const fmtYm = (ym) => (ym ? `${ym.slice(0, 4)}.${ym.slice(4)}` : "-");
const fmtPct = (v, d = 1) => (v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const fmtPp = (v) => (v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%p`);
function fmtMan(v) {
  if (v == null) return "-";
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  return a >= 10000 ? `${sign}${(a / 10000).toFixed(2)}억` : `${sign}${Math.round(a).toLocaleString()}만`;
}
const fmtPy = (v) => (v == null ? "-" : `${Math.round(v).toLocaleString()}만`);

// 조사: 마지막 글자의 받침 유무로 이/가·은/는·을/를 선택 (한글이 아니면 받침 없음으로 처리)
function hasBatchim(word) {
  const w = String(word).trim();
  const code = w.charCodeAt(w.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0;
}
const iga = (w) => `${w}${hasBatchim(w) ? "이" : "가"}`;
const eun = (w) => `${w}${hasBatchim(w) ? "은" : "는"}`;
const eul = (w) => `${w}${hasBatchim(w) ? "을" : "를"}`;

// 눈금: 목표 간격에 가장 가까운 1·2·5·10 × 10^k
function niceTicks(lo, hi, want = 5) {
  const raw = (hi - lo) / want || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).reduce((best, st) => (Math.abs(st - raw) < Math.abs(best - raw) ? st : best));
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

// ---------- URL 해시 상태 ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { a: p.get("a"), b: p.get("b"), basis: p.get("basis"), from: p.get("from"), step: p.get("step"), group: p.get("g") };
}
function writeHash() {
  const p = new URLSearchParams({ a: state.a, b: state.b, basis: state.basis, from: state.from, step: String(state.step), g: state.group });
  history.replaceState(null, "", `#${p.toString()}`);
}

// ---------- 초기화 ----------
async function init() {
  try {
    [state.status, state.areas] = await Promise.all([api("/api/status"), api("/api/areas")]);
  } catch (err) {
    $("sub").textContent = `초기화 실패: ${err.message}`;
    return;
  }
  renderHeader();
  const hash = readHash();
  const preset = state.areas.presets[0];
  const isArea = (id) => state.areas.zones.some((z) => z.id === id) || /^dong:\d{5}:.+$/.test(id || "");
  state.a = isArea(hash.a) ? hash.a : preset && preset.a;
  state.b = isArea(hash.b) ? hash.b : preset && preset.b;
  if (hash.basis === "all" || hash.basis === "kook") state.basis = hash.basis;
  if (/^\d{6}$/.test(hash.from || "") && [...$("selFrom").options].some((o) => o.value === hash.from)) state.from = hash.from;
  if (hash.step === "1" || hash.step === "3") state.step = Number(hash.step);
  if (state.areas.groups.some((g) => g.id === hash.group)) state.group = hash.group;
  buildPicker();
  buildControls();
  await refresh();
}

function renderHeader() {
  const st = state.status;
  const badge = $("badge");
  const live = st.kind === "live";
  badge.hidden = false;
  badge.textContent = live ? "실시간 API" : "샘플 데이터";
  badge.className = `badge ${live ? "real" : "sample"}`;
  updateSub(null);
  const banner = $("banner");
  banner.hidden = live;
  if (!live) banner.textContent = "이 화면의 모든 수치는 개발용 가상 샘플입니다(요청할 때마다 즉석 생성). 실제 시세가 아니며 지역·단지 이름도 가상입니다. API 키와 MCP 서버를 설정하면 국토교통부 실거래가를 실시간 조회합니다.";
}

function updateSub(data) {
  const st = state.status;
  const q = data && data.quota;
  const quota = q && st.kind === "live" ? ` · 오늘 API 호출 ${q.used.toLocaleString()}/${q.limit.toLocaleString()}건` : "";
  $("sub").textContent = `분석 기준월 ${fmtYm(st.lastStableMonth)} (직전 2개월은 신고 지연으로 조회 제외) · ${st.kind === "live" ? "국토교통부 API를 MCP로 실시간 조회" : "샘플 생성기"}${quota}`;
}

// 지역 선택: 권역(고정 목록) + "직접 지정"(시군구 → 법정동)
function buildPicker() {
  const { zones, presets, sigungu } = state.areas;
  for (const side of ["A", "B"]) {
    const sel = $(`sel${side}`);
    clear(sel);
    sel.append(
      h("optgroup", { label: "권역" }, zones.map((z) => h("option", { value: z.id }, z.name))),
      h("optgroup", { label: "직접 지정" }, h("option", { value: CUSTOM }, "시군구·법정동 직접 지정…"))
    );
    // 해시로 복원한 직접 지정 지역
    const id = state[side.toLowerCase()];
    if (id.startsWith("dong:")) sel.append(h("option", { value: id }, describeDong(id)));
    sel.value = id;

    const sgg = $(`sgg${side}`);
    clear(sgg);
    sgg.append(h("option", { value: "" }, "시군구 선택"));
    const GROUP_LABEL = { seoul: "서울", incheon: "인천", "gyeonggi-south": "경기 남부", "gyeonggi-north": "경기 북부" };
    for (const g of Object.keys(GROUP_LABEL)) {
      const items = sigungu.filter((x) => x.group === g);
      if (items.length) sgg.append(h("optgroup", { label: GROUP_LABEL[g] }, items.map((x) => h("option", { value: x.code }, `${x.name}${x.verified ? "" : " (거래 없음·미확인)"}`))));
    }
    clear($(`dong${side}`));

    sel.onchange = () => {
      const custom = $(`custom${side}`);
      if (sel.value === CUSTOM) {
        custom.hidden = false;
        return;
      }
      custom.hidden = true;
      state[side.toLowerCase()] = sel.value;
      state.selected = 0;
      refresh();
    };
    sgg.onchange = () => loadDongs(side);
    $(`dong${side}`).onchange = () => {
      const code = sgg.value;
      const dong = $(`dong${side}`).value;
      if (!code || !dong) return;
      const id = `dong:${code}:${dong}`;
      if (![...sel.options].some((o) => o.value === id)) sel.append(h("option", { value: id }, describeDong(id)));
      sel.value = id;
      state[side.toLowerCase()] = id;
      state.selected = 0;
      refresh();
    };
  }
  const box = $("presets");
  clear(box);
  for (const p of presets) {
    box.append(
      h("button", {
        type: "button", class: "chip", "data-a": p.a, "data-b": p.b,
        onclick: () => setPair(p.a, p.b),
      }, p.label)
    );
  }
}

function describeDong(id) {
  const [, code, dong] = id.split(":");
  const g = state.areas.sigungu.find((x) => x.code === code);
  return `${g ? g.name : code} ${dong === "*" ? "전체" : dong}`;
}

function setPair(a, b) {
  state.a = a; state.b = b; state.selected = 0;
  for (const [side, id] of [["A", a], ["B", b]]) {
    const sel = $(`sel${side}`);
    if (![...sel.options].some((o) => o.value === id) && id.startsWith("dong:")) sel.append(h("option", { value: id }, describeDong(id)));
    sel.value = id;
    $(`custom${side}`).hidden = true;
  }
  refresh();
}

// 시군구를 고르면 최근 3개월만 조회해 법정동 목록을 채운다
async function loadDongs(side) {
  const code = $(`sgg${side}`).value;
  const dongSel = $(`dong${side}`);
  clear(dongSel);
  if (!code) return;
  dongSel.append(h("option", { value: "" }, "법정동 조회 중…"));
  for (let i = 0; i < 120; i++) {
    let r;
    try { r = await api(`/api/dongs?sgg=${code}`); } catch (err) { clear(dongSel); dongSel.append(h("option", { value: "" }, err.message)); return; }
    if ($(`sgg${side}`).value !== code) return; // 그 사이 다른 시군구를 골랐음
    if (r.state === "blocked") { clear(dongSel); dongSel.append(h("option", { value: "" }, r.blocked.message)); return; }
    if (r.state === "ready") {
      clear(dongSel);
      if (!r.dongs.length) { dongSel.append(h("option", { value: "" }, "최근 거래가 없는 시군구")); return; }
      dongSel.append(h("option", { value: "" }, "법정동 선택"), h("option", { value: "*" }, `${r.name} 전체`), r.dongs.map((d) => h("option", { value: d.dong }, `${d.dong} (${d.n}건)`)));
      return;
    }
    await sleep(POLL_MS);
  }
}

function buildControls() {
  for (const btn of document.querySelectorAll("#basisTabs button")) {
    btn.onclick = () => { state.basis = btn.dataset.basis; state.selected = 0; refresh(); };
  }
  for (const btn of document.querySelectorAll("#stepTabs button")) {
    btn.onclick = () => { state.step = Number(btn.dataset.step); state.selected = 0; refresh(); };
  }
  const selGroup = $("selGroup");
  clear(selGroup);
  for (const g of state.areas.groups) selGroup.append(h("option", { value: g.id }, `${g.label} (${g.count}곳)`));
  selGroup.value = state.group;
  selGroup.onchange = () => { state.group = selGroup.value; writeHash(); loadRanking(); };
  $("selFrom").value = state.from;
  $("selFrom").onchange = () => { state.from = $("selFrom").value; state.selected = 0; refresh(); };
}

function syncControls() {
  for (const btn of document.querySelectorAll("#basisTabs button")) {
    btn.classList.toggle("on", btn.dataset.basis === state.basis);
    btn.setAttribute("aria-selected", String(btn.dataset.basis === state.basis));
  }
  for (const btn of document.querySelectorAll("#stepTabs button")) {
    btn.classList.toggle("on", Number(btn.dataset.step) === state.step);
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.step) === state.step));
  }
  for (const chip of document.querySelectorAll("#presets .chip")) {
    chip.classList.toggle("on", chip.dataset.a === state.a && chip.dataset.b === state.b);
  }
}

// ---------- 갱신 (폴링) ----------
async function refresh() {
  const my = ++runId;
  syncControls();
  writeHash();
  const q = new URLSearchParams({ a: state.a, b: state.b, basis: state.basis, from: state.from, step: String(state.step) });
  for (;;) {
    let data;
    try {
      data = await api(`/api/series?${q}`);
    } catch (err) {
      if (my === runId) { hideProgress(); showError(err.message); }
      return;
    }
    if (my !== runId) return;
    state.data = data;
    updateSub(data);
    renderProgress(data);
    if (data.state === "ready") {
      renderAll();
      break;
    }
    renderPartial(data);
    if (data.state === "blocked") return;
    await sleep(POLL_MS);
    if (my !== runId) return;
  }
  loadRanking();
}

function renderAll() {
  renderKpis();
  renderChart();
  renderEpisodes();
  renderSummary();
}

// 조회 중에는 차트만 부분 결과로 그리고 나머지는 자리표시
function renderPartial(d) {
  const kp = $("kpis");
  clear(kp);
  kp.append(h("div", { class: "card kpi" }, h("div", { class: "t" }, "집계 중"), h("div", { class: "big" }, `${d.progress.done}/${d.progress.total}`), h("div", { class: "d" }, "조회가 끝나면 상급지 판정·역전 구간이 계산됩니다.")));
  renderChart();
  clear($("episodes"));
  $("episodes").append(h("div", { class: "empty" }, "조회 중…"));
  clear($("summary"));
  $("summary").append(h("h2", {}, "요약"), h("div", { class: "ins" }, h("span", { class: "n" }, "…"), h("div", {}, h("b", {}, "API에서 데이터를 가져오는 중"), h("span", {}, "잠시만 기다려 주세요."))));
}

function renderProgress(d) {
  const box = $("progress");
  const p = d.progress;
  if (d.state === "ready" && !p.failed) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle("blocked", d.state === "blocked");
  if (d.state === "blocked") {
    $("ptext").textContent = `${d.blocked.message}${d.blocked.kind === "quota" ? " 이미 캐시된 달만으로 계산한 부분 결과를 보여줍니다. 내일 자동으로 재개됩니다." : ""}`;
    return;
  }
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
  $("pbar").style.width = `${pct}%`;
  const failed = p.failed ? ` · 조회 실패 ${p.failed}건(해당 월은 표본 없음으로 처리, 1분 뒤 재시도)` : "";
  $("ptext").textContent = d.state === "ready"
    ? `조회 완료${failed}`
    : `API 실시간 조회 중… ${p.done.toLocaleString()} / ${p.total.toLocaleString()}건 (${pct}%)${failed}`;
}

function hideProgress() { $("progress").hidden = true; }

function showError(msg) {
  for (const id of ["kpis", "chartMain", "chartRatio", "episodes", "summary"]) clear($(id));
  $("episodes").append(h("div", { class: "empty err" }, msg));
}

// 상급지·하급지 객체 (upper 는 'a'|'b')
function sides(d) {
  const up = d.upper === "a" ? d.a : d.b;
  const lo = d.upper === "a" ? d.b : d.a;
  return { up, lo };
}

// ---------- KPI ----------
function renderKpis() {
  const d = state.data;
  const box = $("kpis");
  clear(box);
  const card = (t, big, cls, note) => h("div", { class: "card kpi" }, h("div", { class: "t" }, t), h("div", { class: `big ${cls || ""}` }, big), h("div", { class: "d" }, note));
  if (!d.upper) {
    box.append(card("판정 불가", "데이터 부족", "warn", "두 지역 모두 최근 12개월에 표본이 충분해야 급지를 판정할 수 있습니다."));
    return;
  }
  const { up, lo } = sides(d);
  const eps = d.episodes;
  const longest = eps.reduce((m, e) => (e.durationMonths > (m ? m.durationMonths : 0) ? e : m), null);
  const widest = eps.reduce((m, e) => (e.peakGapPct > (m ? m.peakGapPct : -1) ? e : m), null);
  const cur = d.current;
  // cur.gapPct = 하급지 ÷ 상급지 − 1 (%, 현재는 보통 음수) → 상급지가 하급지보다 얼마나 높은지로 환산
  const upOverLo = cur ? (1 / (1 + cur.gapPct / 100) - 1) * 100 : null;
  box.append(
    card("현재 상급지", up.name, "blue", `최근 12개월 중위 평당가 ${fmtPy(d.upper === "a" ? d.levels.a : d.levels.b)}/평 · ${lo.name} ${fmtPy(d.upper === "a" ? d.levels.b : d.levels.a)}/평`),
    card("현재 격차", fmtPct(upOverLo), "", cur ? `${fmtYm(cur.month)} 기준 ${iga(up.name)} ${lo.name}보다 높은 정도 (${BASIS_LABEL[d.basis]})` : "표본 부족"),
    card("역전 구간", `${eps.length}회`, eps.length ? "warn" : "", eps.length ? `가장 길었던 구간 ${longest.durationMonths}개월 (${fmtYm(longest.start)}~${fmtYm(longest.end)})` : `${iga(lo.name)} ${up.name}보다 오래 비쌌던 적이 없습니다`),
    card("최대 역전 폭", widest ? fmtPct(widest.peakGapPct) : "-", widest ? "warn" : "", widest ? `${fmtYm(widest.peak)}에 ${iga(lo.name)} ${up.name}보다 그만큼 높았음` : "해당 없음")
  );
}

// ---------- 차트 ----------
function renderChart() {
  const d = state.data;
  $("chartTitle").textContent = `평당가 추이 · ${BASIS_LABEL[d.basis]}`;
  const res = d.step === 1 ? "월별 (직전 3개월 롤링 중위값)" : "분기 샘플 (3개월 간격, 해당 월 중위값)";
  $("chartHint").textContent = `전용면적 기준 만원/평 · ${res}. 표본: ${d.a.name} ${d.a.nTrades.toLocaleString()}건 · ${d.b.name} ${d.b.nTrades.toLocaleString()}건${d.outliersRemoved ? ` (이상치 ${d.outliersRemoved}건 제외)` : ""}`;
  const lg = $("legend");
  clear(lg);
  const upKey = d.upper || "a";
  const loKey = upKey === "a" ? "b" : "a";
  lg.append(
    h("span", {}, h("i", { style: `background:${COLOR.upper}` }), `${d[upKey].name}${d.upper ? " (현재 상급지)" : ""}`),
    h("span", {}, h("i", { style: `background:${COLOR.lower}` }), `${d[loKey].name}${d.upper ? " (현재 하급지)" : ""}`)
  );
  if (d.state === "ready") lg.append(h("span", {}, h("i", { class: "sq", style: `background:${COLOR.band}; border:1px solid ${COLOR.lower}` }), "역전 구간"));

  const episodes = d.state === "ready" ? d.episodes : [];
  drawLineChart($("chartMain"), {
    months: d.months,
    series: [
      { values: d[upKey].py, color: COLOR.upper, name: d[upKey].name },
      { values: d[loKey].py, color: COLOR.lower, name: d[loKey].name },
    ],
    episodes,
    fmt: (v) => `${Math.round(v).toLocaleString()}만/평`,
    axisFmt: (v) => Math.round(v).toLocaleString(),
    height: 300,
  });

  if (d.state === "ready" && d.upper && d.ratio) {
    drawLineChart($("chartRatio"), {
      months: d.months,
      series: [{ values: d.ratio, color: "#B0472F", name: "하급지 ÷ 상급지 격차" }],
      episodes,
      fmt: (v) => fmtPct(v),
      axisFmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`,
      zeroLine: true,
      height: 170,
    });
  } else clear($("chartRatio"));
}

function drawLineChart(container, opt) {
  clear(container);
  const W = 760;
  const H = opt.height;
  const padL = 54, padR = 12, padT = 10, padB = 26;
  const n = opt.months.length;
  const all = opt.series.flatMap((x) => x.values).filter((v) => v != null);
  if (!all.length) { container.append(h("div", { class: "empty" }, "표시할 데이터가 아직 없습니다.")); return; }
  let lo = Math.min(...all, opt.zeroLine ? 0 : Infinity);
  let hi = Math.max(...all, opt.zeroLine ? 0 : -Infinity);
  const span = hi - lo || 1;
  lo -= span * 0.06; hi += span * 0.06;
  if (!opt.zeroLine) lo = Math.max(0, lo);
  const x = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opt.series.map((z) => z.name).join(", ") + " 추이 차트" });

  for (const v of niceTicks(lo, hi)) {
    const yy = y(v);
    svg.append(s("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, stroke: COLOR.grid }));
    svg.append(s("text", { x: padL - 8, y: yy + 4, "text-anchor": "end", "font-size": 11, fill: COLOR.text }, opt.axisFmt(v)));
  }
  // x축: 해가 바뀌는 첫 표본에 연도 표시
  opt.months.forEach((ym, i) => {
    const yr = Number(ym.slice(0, 4));
    const isFirstOfYear = i === 0 || Number(opt.months[i - 1].slice(0, 4)) !== yr;
    if (isFirstOfYear && (n < 80 || yr % 2 === 1)) {
      svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle", "font-size": 11, fill: COLOR.text }, String(yr)));
    }
  });
  // 역전 구간 음영
  for (const e of opt.episodes) {
    svg.append(s("rect", { x: x(e.startIdx), y: padT, width: Math.max(2, x(e.endIdx) - x(e.startIdx)), height: H - padT - padB, fill: COLOR.band }));
  }
  if (opt.zeroLine) svg.append(s("line", { x1: padL, x2: W - padR, y1: y(0), y2: y(0), stroke: "#8B92A2", "stroke-dasharray": "4 3" }));
  svg.append(s("line", { x1: padL, x2: padL, y1: padT, y2: H - padB, stroke: "#E1E4EC" }));
  svg.append(s("line", { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, stroke: COLOR.axis }));

  // 선 (결측에서 끊김)
  for (const ser of opt.series) {
    let dStr = "";
    let pen = false;
    ser.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      dStr += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    svg.append(s("path", { d: dStr, fill: "none", stroke: ser.color, "stroke-width": 2, "stroke-linejoin": "round" }));
  }

  // 호버 툴팁
  const guide = s("line", { x1: 0, x2: 0, y1: padT, y2: H - padB, stroke: "#0A1547", "stroke-opacity": 0.35, visibility: "hidden" });
  const overlay = s("rect", { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: "transparent" });
  svg.append(guide, overlay);
  container.append(svg);
  const tip = h("div", { class: "tip", hidden: true });
  container.append(tip);

  overlay.addEventListener("mousemove", (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    const i = Math.min(n - 1, Math.max(0, Math.round(((px - padL) / (W - padL - padR)) * (n - 1))));
    guide.setAttribute("x1", x(i)); guide.setAttribute("x2", x(i)); guide.setAttribute("visibility", "visible");
    clear(tip);
    tip.append(h("div", {}, fmtYm(opt.months[i])));
    for (const ser of opt.series) tip.append(h("div", {}, `${ser.name}: ${ser.values[i] == null ? "표본 부족" : opt.fmt(ser.values[i])}`));
    tip.hidden = false;
    tip.style.left = `${Math.min((x(i) / W) * box.width + 12, box.width - tip.offsetWidth - 4)}px`;
    tip.style.top = "6px";
  });
  overlay.addEventListener("mouseleave", () => { guide.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

// ---------- 역전 구간 표 ----------
function renderEpisodes() {
  const d = state.data;
  const box = $("episodes");
  clear(box);
  if (!d.upper) { box.append(h("div", { class: "empty" }, "급지를 판정할 데이터가 부족합니다.")); return; }
  const { up, lo } = sides(d);
  if (!d.episodes.length) {
    box.append(h("div", { class: "empty" }, `${BASIS_LABEL[d.basis]} 기준으로는 ${iga(lo.name)} ${up.name}보다 오래 비쌌던 구간이 없습니다. 측정 기준 탭을 바꿔 보세요.`));
    return;
  }
  if (state.selected >= d.episodes.length) state.selected = 0;
  const pick = (i) => { state.selected = i; renderEpisodes(); renderSummary(); };
  const head = h("tr", {},
    h("th", {}, "역전 기간"), h("th", { class: "r" }, "기간(개월)"), h("th", { class: "r" }, "최대 격차"),
    h("th", { class: "r" }, `${up.name} 매수`), h("th", { class: "r" }, `${lo.name} 매수`), h("th", { class: "r" }, "수익률 격차"));
  const rows = d.episodes.map((e, i) => {
    const cf = e.cf.peak;
    return h("tr", {
      class: `row-click ${i === state.selected ? "on" : ""}`, tabindex: "0",
      onclick: () => pick(i),
      onkeydown: (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(i); } },
    },
      h("td", {}, `${fmtYm(e.start)} ~ ${e.ongoing ? "진행 중" : fmtYm(e.end)}`),
      h("td", { class: "r num" }, e.durationMonths),
      h("td", { class: "r num" }, fmtPct(e.peakGapPct)),
      h("td", { class: "r num" }, cf ? fmtPct(cf.retA, 0) : "-"),
      h("td", { class: "r num" }, cf ? fmtPct(cf.retB, 0) : "-"),
      h("td", { class: "r" }, cf ? h("span", { class: `pill ${cf.edgePp > 0 ? "ok" : "er"}` }, fmtPp(cf.edgePp)) : "-"));
  });
  box.append(h("table", {}, h("thead", {}, head), h("tbody", {}, rows)));
  box.append(h("div", { class: "hint" }, `수익률은 "최대 격차 시점(${fmtYm(d.episodes[state.selected].peak)})" 매수 → 현재 기준. 비교 대상 ${eun(up.name)} 당시 상대적 저평가 쪽입니다.`));
}

// ---------- 요약 (템플릿 문장, LLM 아님) ----------
function renderSummary() {
  const d = state.data;
  const box = $("summary");
  clear(box);
  box.append(h("h2", {}, "요약"));
  if (!d.upper) { box.append(h("div", { class: "ins" }, h("span", { class: "n" }, "!"), h("div", {}, h("b", {}, "판정 불가"), h("span", {}, "표본이 부족합니다.")))); return; }
  const { up, lo } = sides(d);
  const list = h("div", { class: "list" });
  const item = (n, title, body) => h("div", { class: "ins" }, h("span", { class: "n" }, n), h("div", {}, h("b", {}, title), h("span", {}, body)));

  list.append(item("01", `현재 상급지는 ${up.name}`, `최근 12개월 중위 평당가가 ${lo.name}보다 높습니다 (${BASIS_LABEL[d.basis]} 기준).`));
  if (!d.episodes.length) {
    list.append(item("02", "역전 구간 없음", `${iga(lo.name)} ${up.name}보다 오래 비싼 적은 없었습니다.`));
  } else {
    const e = d.episodes[state.selected];
    const cf = e.cf.peak;
    list.append(item("02", `${fmtYm(e.start)}~${e.ongoing ? "현재" : fmtYm(e.end)}, ${iga(lo.name)} 더 비쌌음`,
      `${e.durationMonths}개월 동안 하급지가 상급지보다 높았고, ${fmtYm(e.peak)}에 격차가 ${fmtPct(e.peakGapPct)}로 가장 컸습니다.`));
    if (cf) {
      const cheaper = cf.priceDiff < 0 ? "싸게" : "비싸게";
      list.append(item("03", `그때 ${lo.name} 대신 ${eul(up.name)} 샀다면`,
        `${up.name} 국평 중위가 ${fmtMan(cf.buyA)} → 현재 ${fmtMan(cf.nowA)} (${fmtPct(cf.retA, 0)}, 차익 ${fmtMan(cf.gainA)}), ` +
        `${lo.name} ${fmtMan(cf.buyB)} → ${fmtMan(cf.nowB)} (${fmtPct(cf.retB, 0)}, 차익 ${fmtMan(cf.gainB)}). ` +
        `수익률은 ${up.name} 쪽이 ${fmtPp(cf.edgePp)} ${cf.edgePp >= 0 ? "높았습니다" : "낮았습니다"}. 매수 당시 ${eun(up.name)} ${fmtMan(Math.abs(cf.priceDiff))} ${cheaper} 거래됐습니다.`));
    } else {
      list.append(item("03", "반사실 계산 불가", "해당 시점의 국평 표본이 부족합니다."));
    }
  }
  box.append(list);
  box.append(h("div", { class: "next" }, h("small", {}, "해석 주의"),
    h("div", {}, "결과를 알고 난 뒤의 비교입니다. 세금·대출·전세 갭을 반영하지 않았고, 단지 구성이 바뀌면 중위가도 달라집니다. 투자 판단의 근거가 아니라 가설을 점검하는 용도로 쓰세요.")));
}

// ---------- 랭킹 (같은 캐시를 쓰므로 시계열 조회가 끝난 뒤에는 대개 즉시 완료) ----------
async function loadRanking() {
  const my = ++rankRun;
  const box = $("ranking");
  const hint = $("rankHint");
  const q = new URLSearchParams({ group: state.group, basis: state.basis, from: state.from, step: String(state.step) });
  for (;;) {
    let r;
    try { r = await api(`/api/inversions?${q}`); } catch (err) { if (my === rankRun) { clear(box); box.append(h("div", { class: "empty err" }, err.message)); } return; }
    if (my !== rankRun) return;
    clear(box);
    if (r.state === "blocked") { box.append(h("div", { class: "empty err" }, r.blocked.message)); return; }
    if (r.state === "loading") {
      hint.textContent = `${r.group.label} 데이터를 조회하는 중… ${r.progress.done}/${r.progress.total}건`;
      box.append(h("div", { class: "empty" }, "조회 중…"));
      await sleep(POLL_MS);
      continue;
    }
    hint.textContent = `${r.group.label} 안의 모든 쌍 · ${BASIS_LABEL[r.basis]} · 최대 격차 ${r.filters.minPeakPct}% 이상, 역전 ${r.filters.step === 1 ? r.filters.minMonths + "개월" : r.filters.minMonths + "표본(≈" + r.filters.minMonths * 3 + "개월)"} 이상. 비교군은 data/regions.json 의 rankingGroups 에서 조정합니다(지리적으로 먼 지역끼리도 쌍이 만들어지니 해석에 유의).`;
    if (!r.episodes.length) { box.append(h("div", { class: "empty" }, "조건에 맞는 역전 사례가 없습니다.")); return; }
    const head = h("tr", {}, h("th", {}, "현재 상급지"), h("th", {}, "그때 더 비쌌던 곳"), h("th", {}, "역전 기간"), h("th", { class: "r" }, "기간(개월)"), h("th", { class: "r" }, "최대 격차"), h("th", { class: "r" }, "상급지 / 하급지 수익률"), h("th", { class: "r" }, "격차"), h("th", { class: "r" }, "교차 확인"));
    const rows = r.episodes.map((e) =>
      h("tr", {
        class: "row-click", tabindex: "0",
        onclick: () => { window.scrollTo({ top: 0, behavior: "smooth" }); setPair(e.upper.id, e.lower.id); },
        onkeydown: (ev) => { if (ev.key === "Enter") ev.currentTarget.click(); },
      },
        h("td", {}, e.upper.name), h("td", {}, e.lower.name),
        h("td", {}, `${fmtYm(e.start)} ~ ${e.ongoing ? "진행 중" : fmtYm(e.end)}`),
        h("td", { class: "r num" }, e.durationMonths), h("td", { class: "r num" }, fmtPct(e.peakGapPct)),
        h("td", { class: "r num" }, `${fmtPct(e.retUpper, 0)} / ${fmtPct(e.retLower, 0)}`),
        h("td", { class: "r" }, e.edgePp == null ? "-" : h("span", { class: `pill ${e.edgePp > 0 ? "ok" : "er"}` }, fmtPp(e.edgePp))),
        h("td", { class: "r" }, h("span", { class: `pill ${e.confirmedBoth ? "ok" : "wn"}`, title: e.confirmedBoth ? "국평 기준과 전체 면적 기준 모두에서 같은 시기에 역전이 나타남" : `${BASIS_LABEL[e.otherBasis]} 기준에서는 확인되지 않음 — 표본·단지 구성 차이일 수 있음` }, e.confirmedBoth ? "두 기준 모두" : "한 기준만"))));
    box.append(h("table", {}, h("thead", {}, head), h("tbody", {}, rows)));
    box.append(h("div", { class: "hint" }, "\"한 기준만\"은 국평 중위가가 단지 구성(재건축 신축과 구축의 비중)에 흔들렸을 가능성이 있는 사례입니다. 두 기준 모두에서 나타난 사례를 더 신뢰하세요."));
    return;
  }
}

init();
