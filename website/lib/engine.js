// 엔진 — 요청한 지역·기간에 필요한 (시군구, 월)만 실시간으로 조회하고 분석해 API 응답을 만든다.
// analytics.js 의 순수 함수를 조합하며, 데이터는 MonthStore(메모리 캐시)에서만 읽는다. 디스크 적재 없음.
"use strict";
const fs = require("fs");
const path = require("path");
const A = require("./analytics");

const REGIONS_FILE = path.join(__dirname, "..", "data", "regions.json");
const STABLE_TRIM = 2; // 신고 지연(30일) 때문에 직전 2개월은 조회·분석에서 제외
const BASES = new Set(["all", "kook"]);
const MIN_FROM = "200601"; // 실거래가 공개 시작(2006-01)

// 해상도별 분석 파라미터. step=3 은 분기 샘플(호출 1/3): 표본 하나가 한 달치뿐이라 롤링 창은 1
const STEP_PARAMS = {
  1: { window: 3, lastN: 12, nowN: 3, detect: { minMonths: 3, maxGap: 1 }, rankMinMonths: 6 },
  // 표본 1개 = 한 달치라 노이즈가 커서, 표본 1개(≈3개월) 공백은 같은 구간으로 병합
  3: { window: 1, lastN: 4, nowN: 2, detect: { minMonths: 2, maxGap: 1 }, rankMinMonths: 3 },
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

class Engine {
  constructor(store, { now = () => new Date(), regions } = {}) {
    this.store = store;
    this.now = now;
    this.regions = regions || JSON.parse(fs.readFileSync(REGIONS_FILE, "utf8"));
    this.sggName = new Map(this.regions.sigungu.map((s) => [s.code, s.name]));
    this.resultCache = new Map(); // 완료된 분석 결과를 잠시 재사용 (키: 요청 파라미터)
  }

  // ---------- 시간축 ----------
  lastStable() {
    const d = this.now();
    return A.idxToYm(d.getFullYear() * 12 + d.getMonth() - STABLE_TRIM);
  }

  parseParams({ from, step }) {
    const st = Number(step ?? 3);
    if (!STEP_PARAMS[st]) throw httpError(400, "step 은 1(월별) 또는 3(분기 샘플)이어야 합니다.");
    const f = from || "201201";
    if (!/^\d{6}$/.test(f) || f < MIN_FROM) throw httpError(400, `from 은 ${MIN_FROM} 이후의 YYYYMM 이어야 합니다.`);
    const last = this.lastStable();
    if (f > last) throw httpError(400, "from 이 분석 기준월보다 늦습니다.");
    return { from: f, step: st, ...STEP_PARAMS[st] };
  }

  // 마지막 안정 월에서 step 간격으로 거슬러 올라가며 from 까지
  axis(from, step) {
    const out = [];
    for (let i = A.ymToIdx(this.lastStable()); i >= A.ymToIdx(from); i -= step) out.push(A.idxToYm(i));
    return out.reverse();
  }

  // ---------- 지역 해석 ----------
  resolveArea(id) {
    const [kind, ...rest] = String(id).split(":");
    if (kind === "zone") {
      const z = this.regions.zones.find((x) => x.id === rest[0]);
      if (!z) throw httpError(400, `알 수 없는 권역: ${id}`);
      return { id, name: z.name, parts: z.parts };
    }
    if (kind === "dong" && rest.length === 2) {
      const [sgg, dong] = rest;
      if (!/^\d{5}$/.test(sgg)) throw httpError(400, `잘못된 시군구 코드: ${sgg}`);
      const sggName = this.sggName.get(sgg) || sgg;
      // 'dong:41135:*' = 시군구 전체
      if (dong === "*") return { id, name: sggName, parts: [{ sgg }] };
      return { id, name: `${sggName} ${dong}`, parts: [{ sgg, dongs: [dong] }] };
    }
    throw httpError(400, `잘못된 지역 id: ${id}`);
  }

  sggOf(areas) {
    return [...new Set(areas.flatMap((a) => a.parts.map((p) => p.sgg)))];
  }

  // ---------- 조회 준비 ----------
  // 필요한 (시군구, 월) 요청 → 진행 상태 + 시군구별 정제된 행
  prepare(sggList, axis) {
    const items = sggList.flatMap((sgg) => axis.map((ym) => ({ sgg, ym })));
    const progress = this.store.request(items);
    const perSgg = new Map();
    for (const sgg of sggList) {
      const rows = [];
      for (const ym of axis) {
        const r = this.store.get(sgg, ym);
        if (r) for (const row of r) rows.push(row);
      }
      perSgg.set(sgg, A.removeOutliers(rows)); // { rows, removed }
    }
    return { progress, perSgg };
  }

  areaSeries(area, prep, axis, basis, P) {
    const match = A.makeAreaMatcher(area);
    let rows = [];
    let removed = 0;
    for (const sgg of new Set(area.parts.map((p) => p.sgg))) {
      const c = prep.perSgg.get(sgg);
      removed += c.removed;
      for (const r of c.rows) if (match(r)) rows.push(r);
    }
    const opt = { window: P.window, minN: 3 };
    const main = A.buildSeries(rows.filter(A.basisFilter(basis)), axis, opt);
    const kook = basis === "kook" ? main : A.buildSeries(rows.filter(A.basisFilter("kook")), axis, opt);
    return { area, main, kook, nTrades: rows.length, removed };
  }

  meta(progress) {
    const st = this.store.stats();
    const state = progress.blocked ? "blocked" : progress.pending > 0 ? "loading" : "ready";
    return { state, progress: { total: progress.total, done: progress.done, failed: progress.failed, pending: progress.pending }, blocked: progress.blocked, source: st.kind, quota: { used: st.callsToday, limit: st.dailyLimit } };
  }

  status() {
    const st = this.store.stats();
    return { ...st, lastStableMonth: this.lastStable(), minFrom: MIN_FROM };
  }

  areas() {
    return {
      presets: this.regions.presets,
      zones: this.regions.zones.map((z) => ({ id: `zone:${z.id}`, name: z.name })),
      sigungu: this.regions.sigungu.map((s) => ({ code: s.code, name: s.name, group: s.group, verified: s.verified })),
      groups: this.regions.rankingGroups.map((g) => ({ id: g.id, label: g.label, count: g.areas.length })),
    };
  }

  // 시군구의 법정동 목록: 최근 안정 월 3개만 조회해 거래가 있었던 동을 모은다
  dongs(sgg) {
    if (!/^\d{5}$/.test(sgg || "")) throw httpError(400, "sgg 는 5자리 시군구 코드여야 합니다.");
    const axis = this.axis(A.idxToYm(A.ymToIdx(this.lastStable()) - 2), 1);
    const prep = this.prepare([sgg], axis);
    const counts = new Map();
    for (const r of prep.perSgg.get(sgg).rows) counts.set(r.dong, (counts.get(r.dong) || 0) + 1);
    const dongs = [...counts].sort((a, b) => a[0].localeCompare(b[0], "ko")).map(([dong, n]) => ({ dong, n }));
    return { ...this.meta(prep.progress), sgg, name: this.sggName.get(sgg) || sgg, dongs };
  }

  // ---------- 쌍 분석 ----------
  analyzePair(idA, idB, basis, params) {
    if (!BASES.has(basis)) throw httpError(400, `basis 는 all|kook 중 하나여야 합니다: ${basis}`);
    if (idA === idB) throw httpError(400, "서로 다른 두 지역을 선택하세요.");
    const P = this.parseParams(params);
    const areaA = this.resolveArea(idA);
    const areaB = this.resolveArea(idB);
    const axis = this.axis(P.from, P.step);
    const prep = this.prepare(this.sggOf([areaA, areaB]), axis);
    const meta = this.meta(prep.progress);

    const cacheKey = `${idA}|${idB}|${basis}|${P.from}|${P.step}`;
    if (meta.state === "ready") {
      const hit = this.resultCache.get(cacheKey);
      if (hit && this.now().getTime() - hit.at < 10 * 60 * 1000) return { ...hit.result, ...meta };
    }
    const result = this.pairFromPrep(areaA, areaB, prep, axis, basis, P);
    if (meta.state === "ready") this.resultCache.set(cacheKey, { at: this.now().getTime(), result });
    return { ...result, ...meta };
  }

  // memo: 랭킹처럼 같은 지역이 여러 쌍에 나올 때 지역별 시계열을 한 번만 계산하기 위한 Map(선택)
  pairFromPrep(areaA, areaB, prep, axis, basis, P, memo) {
    const series = (area) => {
      if (!memo) return this.areaSeries(area, prep, axis, basis, P);
      if (!memo.has(area.id)) memo.set(area.id, this.areaSeries(area, prep, axis, basis, P));
      return memo.get(area.id);
    };
    const x = series(areaA);
    const y = series(areaB);
    const { upper, levelA, levelB } = A.decideUpper(x.main, y.main, P.lastN);
    const result = {
      basis,
      from: P.from,
      step: P.step,
      months: axis,
      a: pack(x, areaA.id),
      b: pack(y, areaB.id),
      levels: { a: levelA, b: levelB },
      upper,
      episodes: [],
      current: null,
      ratio: null,
      outliersRemoved: x.removed + y.removed,
    };
    if (!upper) return result;

    const [upX, loX] = upper === "a" ? [x, y] : [y, x];
    // 하급지 ÷ 상급지 − 1 (%; 양수 = 역전)
    result.ratio = axis.map((_, i) => {
      const a = upX.main.py[i];
      const b = loX.main.py[i];
      return a == null || b == null ? null : (b / a - 1) * 100;
    });

    const eps = A.detectInversions(upX.main, loX.main, P.detect);
    result.episodes = eps.map((e) => {
      const cfOpt = { nowN: P.nowN };
      return {
        ...e,
        durationMonths: A.ymToIdx(e.end) - A.ymToIdx(e.start) + 1,
        cf: {
          start: A.counterfactual(upX.kook, loX.kook, e.start, cfOpt),
          peak: A.counterfactual(upX.kook, loX.kook, e.peak, cfOpt),
          end: A.counterfactual(upX.kook, loX.kook, e.end, cfOpt),
        },
      };
    });

    // 현재 격차: 마지막 유효 표본
    for (let i = axis.length - 1; i >= 0; i--) {
      if (result.ratio[i] != null) {
        result.current = { gapPct: result.ratio[i], month: axis[i] };
        break;
      }
    }
    return result;
  }

  // ---------- 비교군 랭킹 ----------
  ranking(groupId, basis, params, { minPeakPct = 5 } = {}) {
    if (!BASES.has(basis)) throw httpError(400, `basis 는 all|kook 중 하나여야 합니다: ${basis}`);
    const g = this.regions.rankingGroups.find((x) => x.id === groupId);
    if (!g) throw httpError(400, `알 수 없는 비교군: ${groupId}`);
    const P0 = this.parseParams(params);
    const P = { ...P0, detect: { ...P0.detect, minMonths: P0.rankMinMonths } };
    const areas = g.areas.map((id) => this.resolveArea(id));
    const axis = this.axis(P.from, P.step);
    const prep = this.prepare(this.sggOf(areas), axis);
    const meta = this.meta(prep.progress);
    const base = { group: g, basis, filters: { minPeakPct, minMonths: P.rankMinMonths, step: P.step }, ...meta };
    if (meta.state !== "ready") return { ...base, episodes: [] };

    const other = basis === "kook" ? "all" : "kook";
    const memoMain = new Map();
    const memoOther = new Map();
    const overlaps = (x, y) => !(x.endIdx < y.startIdx || y.endIdx < x.startIdx);
    const list = [];
    for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        const r = this.pairFromPrep(areas[i], areas[j], prep, axis, basis, P, memoMain);
        if (!r.upper) continue;
        // 교차 확인: 다른 측정 기준에서도 같은 방향(같은 상급지)으로 시간이 겹치는 역전이 있는가
        const ro = this.pairFromPrep(areas[i], areas[j], prep, axis, other, P, memoOther);
        const otherEps = ro.upper === r.upper ? ro.episodes : [];
        const [up, lo] = r.upper === "a" ? [r.a, r.b] : [r.b, r.a];
        for (const e of r.episodes) {
          if (e.peakGapPct < minPeakPct) continue;
          list.push({
            upper: { id: up.id, name: up.name },
            lower: { id: lo.id, name: lo.name },
            start: e.start,
            end: e.end,
            ongoing: e.ongoing,
            durationMonths: e.durationMonths,
            peakGapPct: e.peakGapPct,
            edgePp: e.cf.peak ? e.cf.peak.edgePp : null,
            retUpper: e.cf.peak ? e.cf.peak.retA : null,
            retLower: e.cf.peak ? e.cf.peak.retB : null,
            confirmedBoth: otherEps.some((o) => overlaps(e, o)),
            otherBasis: other,
          });
        }
      }
    }
    // 두 기준에서 모두 확인된 사례를 먼저, 그 안에서는 (최대 격차 × 기간) 순
    list.sort((p, q) => Number(q.confirmedBoth) - Number(p.confirmedBoth) || q.peakGapPct * q.durationMonths - p.peakGapPct * p.durationMonths);
    return { ...base, episodes: list };
  }
}

function pack(s, id) {
  return { id, name: s.area.name, py: s.main.py, price: s.main.price, n: s.main.n, nTrades: s.nTrades };
}

module.exports = { Engine, httpError, STABLE_TRIM, STEP_PARAMS };
