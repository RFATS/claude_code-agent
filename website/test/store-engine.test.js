"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MonthStore } = require("../lib/month-store");
const { Engine } = require("../lib/engine");
const { createSampleSource } = require("../lib/sample-source");
const { classify, createMcpSource } = require("../lib/source-mcp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOW = () => new Date(2026, 8, 30); // 2026-09-30 고정 → 분석 기준월 202607
async function until(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("until: 시간 초과");
    await sleep(5);
  }
}

// 호출을 기록하는 가짜 소스
function fakeSource(impl) {
  const calls = [];
  return {
    kind: "fake",
    calls,
    async fetchMonth(sgg, ym) {
      calls.push(`${sgg}|${ym}`);
      return impl ? impl(sgg, ym, calls) : { rows: [{ sgg, ym, dong: "가동", apt: "A", areaSqm: 84, priceMan: 50000 }], totalCount: 1 };
    },
  };
}

test("MonthStore: 요청한 달만 호출하고, 같은 달은 다시 호출하지 않는다", async () => {
  const src = fakeSource();
  const store = new MonthStore(src, { now: NOW });
  const items = [{ sgg: "11", ym: "202401" }, { sgg: "11", ym: "202402" }];
  assert.deepEqual(store.request(items), { total: 2, done: 0, failed: 0, pending: 2, blocked: null });
  await until(() => store.request(items).done === 2);
  const before = src.calls.length;
  store.request(items);
  await sleep(20);
  assert.equal(src.calls.length, before); // 캐시 적중 — 추가 호출 없음
  assert.equal(before, 2);
  assert.equal(store.get("11", "202401")[0].dong, "가동");
});

test("MonthStore: 같은 키를 동시에 요청해도 한 번만 호출(중복 합치기)", async () => {
  const src = fakeSource(async () => { await sleep(30); return { rows: [], totalCount: 0 }; });
  const store = new MonthStore(src, { now: NOW });
  const items = [{ sgg: "11", ym: "202401" }];
  store.request(items); store.request(items); store.request(items);
  await until(() => store.request(items).done === 1);
  assert.equal(src.calls.length, 1);
});

test("MonthStore: 동시 호출 수를 concurrency 로 제한", async () => {
  let active = 0;
  let peak = 0;
  const src = fakeSource(async () => {
    active++; peak = Math.max(peak, active);
    await sleep(15);
    active--;
    return { rows: [], totalCount: 0 };
  });
  const store = new MonthStore(src, { concurrency: 2, now: NOW });
  const items = Array.from({ length: 8 }, (_, i) => ({ sgg: "11", ym: `2024${String(i + 1).padStart(2, "0")}` }));
  store.request(items);
  await until(() => store.request(items).done === 8);
  assert.equal(peak, 2);
});

test("MonthStore: 쿼터 오류(code 22)면 차단하고 대기 중인 호출을 버린다", async () => {
  const src = fakeSource(async (sgg, ym) => {
    if (ym === "202402") { const e = new Error("한도 초과"); e.kind = "quota"; throw e; }
    await sleep(5);
    return { rows: [], totalCount: 0 };
  });
  const store = new MonthStore(src, { concurrency: 1, now: NOW });
  const items = Array.from({ length: 6 }, (_, i) => ({ sgg: "11", ym: `2024${String(i + 1).padStart(2, "0")}` }));
  store.request(items);
  await until(() => store.blocked);
  assert.equal(store.blocked.kind, "quota");
  assert.ok(src.calls.length < 6, `차단 후 호출이 멈춰야 함: ${src.calls.length}`);
  const st = store.request(items);
  assert.ok(st.blocked);
  assert.ok(st.pending > 0);
});

test("MonthStore: 일시 오류는 재시도, 계속 실패하면 failed 로 기록", async () => {
  let n = 0;
  const src = fakeSource(async () => {
    n++;
    const e = new Error("네트워크"); e.kind = "transient"; throw e;
  });
  const store = new MonthStore(src, { retryDelays: [1, 1], now: NOW });
  const items = [{ sgg: "11", ym: "202401" }];
  store.request(items);
  await until(() => store.request(items).failed === 1);
  assert.equal(n, 3); // 최초 1 + 재시도 2
  assert.equal(store.request(items).done, 0);
});

test("MonthStore: 일일 호출 상한을 넘으면 quota 로 차단", async () => {
  const src = createMcpSource({ callTool: async () => ({ total_count: 0, items: [] }) });
  const store = new MonthStore(src, { dailyLimit: 3, concurrency: 1, now: NOW });
  const items = Array.from({ length: 6 }, (_, i) => ({ sgg: "11", ym: `2024${String(i + 1).padStart(2, "0")}` }));
  store.request(items);
  await until(() => store.blocked);
  assert.equal(store.blocked.kind, "quota");
  assert.equal(store.stats().callsToday, 3);
});

test("MonthStore: 최근 월은 TTL 이 지나면 다시 조회", async () => {
  let t = new Date(2026, 8, 30).getTime();
  const src = fakeSource();
  const store = new MonthStore(src, { recentTtlMs: 1000, now: () => new Date(t) });
  const recent = [{ sgg: "11", ym: "202607" }];
  const old = [{ sgg: "11", ym: "202001" }];
  store.request(recent); store.request(old);
  await until(() => store.request(recent).done === 1 && store.request(old).done === 1);
  t += 5000;
  assert.equal(store.get("11", "202607"), undefined); // 최근 월 → 만료
  assert.ok(store.get("11", "202001")); // 오래된 월 → 유지
});

test("MonthStore: LRU 상한을 넘으면 오래 안 쓴 항목부터 제거", async () => {
  const store = new MonthStore(fakeSource(), { maxEntries: 3, now: NOW });
  const items = ["202001", "202002", "202003", "202004"].map((ym) => ({ sgg: "11", ym }));
  store.request(items);
  await until(() => store.entries.size === 3 && store.inflight.size === 0);
  assert.equal(store.get("11", "202001"), undefined); // 가장 먼저 들어온 항목이 밀려남
});

test("classify: MCP 오류 코드 → 종류", () => {
  assert.equal(classify({ error: "api_error", code: "22", message: "" }).kind, "quota");
  assert.equal(classify({ error: "api_error", code: "30", message: "" }).kind, "auth");
  assert.equal(classify({ error: "config_error", message: "키 없음" }).kind, "auth");
  assert.equal(classify({ error: "network_error", message: "" }).kind, "transient");
  assert.equal(classify({ error: "network_error", message: "HTTP error: 403" }).kind, "auth"); // 실측: 잘못된 키
  assert.equal(classify({ error: "network_error", message: "HTTP error: 503" }).kind, "transient");
  assert.equal(classify({ error: "parse_error", message: "" }).kind, "fatal");
});

test("source-mcp: 정규화·데이터없음(03)·잘림 시 재호출", async () => {
  const seen = [];
  const client = {
    async callTool(name, args) {
      seen.push(args.num_of_rows);
      if (args.year_month === "202001") return { error: "api_error", code: "03", message: "no data" };
      if (args.year_month === "202002" && args.num_of_rows === 3000) return { total_count: 5000, items: [] }; // 잘림 → 재호출
      return {
        total_count: 1,
        items: [{ apt_name: "A", dong: "금곡동", area_sqm: 84.9, floor: 5, price_10k: 120000, trade_date: "2020-02-11", build_year: 1995, deal_type: "중개거래" }],
      };
    },
  };
  const src = createMcpSource(client);
  assert.deepEqual(await src.fetchMonth("41135", "202001"), { rows: [], totalCount: 0 });
  const r = await src.fetchMonth("41135", "202002");
  assert.deepEqual(seen, [3000, 3000, 9999]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { sgg: "41135", ym: "202002", dong: "금곡동", apt: "A", areaSqm: 84.9, floor: 5, priceMan: 120000, date: "2020-02-11", buildYear: 1995, dealType: "중개거래" });
  await assert.rejects(() => createMcpSource({ callTool: async () => ({ error: "api_error", code: "22", message: "" }) }).fetchMonth("11", "202001"), (e) => e.kind === "quota");
});

test("sample-source: 같은 (시군구, 월)은 항상 같은 결과, 없는 시군구는 빈 결과", async () => {
  const src = createSampleSource({ delayMs: 0 });
  const a = await src.fetchMonth("41135", "202101");
  const b = await src.fetchMonth("41135", "202101");
  assert.deepEqual(a, b);
  assert.ok(a.rows.length > 10);
  assert.ok(a.rows.every((r) => r.sgg === "41135" && r.ym === "202101" && r.dong));
  assert.deepEqual(await src.fetchMonth("99999", "202101"), { rows: [], totalCount: 0 });
});

test("Engine: 로딩 → 준비 상태 전이, 광교·금곡동 역전 구간 탐지, 캐시 재사용", async () => {
  const src = createSampleSource({ delayMs: 0 });
  const store = new MonthStore(src, { now: NOW });
  const engine = new Engine(store, { now: NOW });
  const run = () => engine.analyzePair("zone:gwanggyo", "zone:geumgok", "kook", { from: "201201", step: "3" });

  const first = run();
  assert.equal(first.state, "loading");
  assert.equal(first.progress.total, 3 * 59); // 시군구 3곳 × 분기 샘플 59개월
  await until(() => run().state === "ready");
  const r = run();
  assert.equal(r.upper, "b"); // 샘플 곡선에서 금곡동이 현재 상급지
  assert.equal(r.months.at(-1), "202607");
  assert.equal(r.months.length, 59);
  assert.ok(r.episodes.length >= 1);
  assert.ok(r.episodes[0].start >= "201412" && r.episodes[0].end <= "202201");
  assert.ok(r.episodes[0].cf.peak && r.episodes[0].cf.peak.edgePp > 0);

  // 월별로 바꾸면 이미 캐시된 분기 샘플 달은 다시 조회하지 않는다
  const monthly = engine.analyzePair("zone:gwanggyo", "zone:geumgok", "kook", { from: "201201", step: "1" });
  assert.equal(monthly.progress.total, 3 * 175);
  assert.equal(monthly.progress.done, 3 * 59);
});

test("Engine 랭킹: 두 측정 기준 교차 확인(confirmedBoth)이 붙고 확인된 사례가 먼저 나온다", async () => {
  const store = new MonthStore(createSampleSource({ delayMs: 0 }), { now: NOW });
  const engine = new Engine(store, { now: NOW });
  const run = () => engine.ranking("default", "kook", { from: "201201", step: "3" });
  run();
  await until(() => run().state === "ready");
  const r = run();
  assert.ok(r.episodes.length >= 1);
  for (const e of r.episodes) {
    assert.equal(typeof e.confirmedBoth, "boolean");
    assert.equal(e.otherBasis, "all");
  }
  // 샘플 곡선의 광교↔금곡동 역전은 국평·전체 면적 모두에서 나타남
  assert.ok(r.episodes.some((e) => e.confirmedBoth), "교차 확인된 사례가 있어야 함");
  // 정렬: confirmedBoth=true 가 false 보다 앞
  const firstFalse = r.episodes.findIndex((e) => !e.confirmedBoth);
  if (firstFalse >= 0) assert.ok(r.episodes.slice(firstFalse).every((e) => !e.confirmedBoth), "미확인 사례가 확인 사례 사이에 끼면 안 됨");
  // 기본 비교군은 권역이 7개, 새 비교군은 id 로 조회 가능
  assert.ok(engine.areas().groups.some((g) => g.id === "gi1") && engine.areas().groups.some((g) => g.id === "newtown"));
});

test("Engine: 잘못된 입력은 400", () => {
  const engine = new Engine(new MonthStore(fakeSource(), { now: NOW }), { now: NOW });
  const bad = (fn) => assert.throws(fn, (e) => e.status === 400);
  bad(() => engine.analyzePair("zone:gwanggyo", "zone:gwanggyo", "kook", {}));
  bad(() => engine.analyzePair("zone:nope", "zone:geumgok", "kook", {}));
  bad(() => engine.analyzePair("zone:gwanggyo", "zone:geumgok", "zzz", {}));
  bad(() => engine.analyzePair("zone:gwanggyo", "zone:geumgok", "kook", { step: "2" }));
  bad(() => engine.analyzePair("zone:gwanggyo", "zone:geumgok", "kook", { from: "200001" }));
  bad(() => engine.analyzePair("zone:gwanggyo", "zone:geumgok", "kook", { from: "209912" }));
  bad(() => engine.analyzePair("dong:abc:x", "zone:geumgok", "kook", {}));
  bad(() => engine.dongs("12"));
});
