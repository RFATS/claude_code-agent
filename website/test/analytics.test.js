"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../lib/analytics");

// 해당 월에 평당가 py(만원)인 84㎡ 거래 n건 생성
function mk(sgg, dong, apt, ym, py, n = 5, area = 84) {
  const price = Math.round(py * (area / A.PY));
  return Array.from({ length: n }, () => ({ sgg, dong, apt, ym, areaSqm: area, priceMan: price, floor: 10, dealType: "" }));
}

// 2014-01 ~ 2020-12: 하급지(B)는 항상 2000, 상급지(A)는 2014~2015 3000, 2016~2017 1500(저평가=B가 더 비쌈), 2018~ 3000
function scenario() {
  const months = A.monthRange("201401", "202012");
  const rowsA = [];
  const rowsB = [];
  for (const ym of months) {
    const y = Number(ym.slice(0, 4));
    const pyA = y >= 2016 && y <= 2017 ? 1500 : 3000;
    rowsA.push(...mk("11", "가동", "A아파트", ym, pyA));
    rowsB.push(...mk("22", "나동", "B아파트", ym, 2000));
  }
  return { months, rowsA, rowsB };
}

test("median: 홀수/짝수/빈 배열/NaN 무시", () => {
  assert.equal(A.median([3, 1, 2]), 2);
  assert.equal(A.median([1, 2, 3, 4]), 2.5);
  assert.equal(A.median([]), null);
  assert.equal(A.median([NaN, 5]), 5);
});

test("monthRange: 연도 경계", () => {
  assert.deepEqual(A.monthRange("201411", "201502"), ["201411", "201412", "201501", "201502"]);
});

test("buildSeries: 표본 부족 달은 null, 롤링 윈도우 적용", () => {
  const months = A.monthRange("201801", "201804");
  const rows = [...mk("11", "가동", "x", "201801", 3000, 2), ...mk("11", "가동", "x", "201802", 3000, 2)];
  const s = A.buildSeries(rows, months, { window: 3, minN: 3 });
  assert.equal(s.py[0], null); // 2건 < 3
  assert.ok(Math.abs(s.py[1] - 3000) < 5); // 1~2월 합 4건
  assert.equal(s.py[3], null); // 4월 롤링 창 [2,3,4월] = 2건(<3) → 결측
});

test("buildSeries: 롤링 창 밖 거래는 제외", () => {
  const months = A.monthRange("201801", "201805");
  const rows = [...mk("11", "가동", "x", "201801", 1000, 5), ...mk("11", "가동", "x", "201805", 2000, 5)];
  const s = A.buildSeries(rows, months, { window: 3, minN: 3 });
  assert.ok(Math.abs(s.py[4] - 2000) < 5); // 5월 창 = [3,4,5월] → 1월 거래 제외
});

test("detectInversions: 알려진 24개월 역전 구간을 정확히 찾는다", () => {
  const { months, rowsA, rowsB } = scenario();
  const a = A.buildSeries(rowsA, months);
  const b = A.buildSeries(rowsB, months);
  // 현재(2020) A가 상급지
  assert.equal(A.decideUpper(a, b).upper, "a");
  const eps = A.detectInversions(a, b);
  assert.equal(eps.length, 1);
  const ep = eps[0];
  // 롤링 3개월 평활 때문에 시작은 2016-01, 종료는 2017-12 (A가 1500인 달부터 B>A: 1500 창이 채워지는 시점 이후)
  assert.ok(ep.start >= "201601" && ep.start <= "201603", `start=${ep.start}`);
  assert.ok(ep.end >= "201712" && ep.end <= "201802", `end=${ep.end}`);
  assert.ok(ep.peakGapPct > 30 && ep.peakGapPct < 34, `peak=${ep.peakGapPct}`); // 2000/1500-1 = 33.3%
  assert.equal(ep.ongoing, false);
});

test("detectInversions: 2개월짜리 짧은 역전은 minMonths=3 에서 제외", () => {
  const months = A.monthRange("201801", "201812");
  const rowsA = [];
  const rowsB = [];
  for (const ym of months) {
    rowsA.push(...mk("11", "가동", "A", ym, ym === "201806" || ym === "201807" ? 1800 : 3000, 10));
    rowsB.push(...mk("22", "나동", "B", ym, 2000, 10));
  }
  const a = A.buildSeries(rowsA, months, { window: 1 });
  const b = A.buildSeries(rowsB, months, { window: 1 });
  assert.equal(A.detectInversions(a, b, { minMonths: 3 }).length, 0);
  assert.equal(A.detectInversions(a, b, { minMonths: 2 }).length, 1);
});

test("detectInversions: 1개월 공백은 병합, 2개월 공백은 분리", () => {
  const months = A.monthRange("201801", "201812");
  const build = (invMonths) => {
    const rowsA = [];
    const rowsB = [];
    for (const ym of months) {
      rowsA.push(...mk("11", "가동", "A", ym, invMonths.includes(ym) ? 1800 : 3000, 10));
      rowsB.push(...mk("22", "나동", "B", ym, 2000, 10));
    }
    return [A.buildSeries(rowsA, months, { window: 1 }), A.buildSeries(rowsB, months, { window: 1 })];
  };
  // 202803,04,05 / (06 공백) / 07,08,09 → 병합 1건
  let [a, b] = build(["201803", "201804", "201805", "201807", "201808", "201809"]);
  assert.equal(A.detectInversions(a, b, { maxGap: 1 }).length, 1);
  // 03,04,05 / (06,07 공백) / 08,09,10 → 분리 2건
  [a, b] = build(["201803", "201804", "201805", "201808", "201809", "201810"]);
  assert.equal(A.detectInversions(a, b, { maxGap: 1 }).length, 2);
});

test("detectInversions: 결측(null) 달은 역전으로 세지 않는다", () => {
  const months = A.monthRange("201801", "201806");
  const nul = { months, py: [null, null, null, null, null, null], price: [], n: [] };
  const b = { months, py: [1, 1, 1, 1, 1, 1], price: [], n: [] };
  assert.equal(A.detectInversions(nul, b).length, 0);
});

test("counterfactual: A를 샀다면 수익률·차익·가격차", () => {
  const months = A.monthRange("201401", "202012");
  const mkS = (f) => ({ months, py: months.map(() => 1), price: months.map((ym) => f(ym)), n: [] });
  const upper = mkS((ym) => (ym <= "201612" ? 50000 : 100000)); // 5억 → 10억
  const lower = mkS((ym) => (ym <= "201612" ? 60000 : 90000)); // 6억 → 9억
  const cf = A.counterfactual(upper, lower, "201606");
  assert.equal(cf.buyA, 50000);
  assert.equal(cf.buyB, 60000);
  assert.equal(cf.nowA, 100000);
  assert.equal(cf.retA, 100);
  assert.equal(cf.retB, 50);
  assert.equal(cf.gainA, 50000);
  assert.equal(cf.edgePp, 50);
  assert.equal(cf.priceDiff, -10000); // 당시 A가 1억 저렴
  assert.equal(A.counterfactual(upper, lower, "199901"), null);
});

test("removeOutliers: 그룹 중위 대비 ±50% 밖 건 제거, 표본 부족 그룹은 유지", () => {
  const rows = [
    ...mk("41", "광교", "자이", "202512", 4000, 3, 84), // 14.35억 부근 3건
    { sgg: "41", dong: "광교", apt: "자이", ym: "202512", areaSqm: 84, priceMan: 257000, floor: 5, dealType: "" }, // 25.7억 오신고
    ...mk("41", "광교", "소단지", "202512", 4000, 2, 84), // 그룹 2건 → 검사 안 함
  ];
  const { rows: kept, removed } = A.removeOutliers(rows);
  assert.equal(removed, 1);
  assert.equal(kept.length, rows.length - 1);
});

test("makeAreaMatcher: 동·단지 정규식 조합", () => {
  const m = A.makeAreaMatcher({
    parts: [
      { sgg: "41117", dongs: ["이의동", "하동"] },
      { sgg: "41465", dongs: ["상현동"], aptRegex: "광교" },
    ],
  });
  assert.ok(m({ sgg: "41117", dong: "이의동", apt: "아무거나" }));
  assert.ok(!m({ sgg: "41117", dong: "영통동", apt: "x" }));
  assert.ok(m({ sgg: "41465", dong: "상현동", apt: "광교자이더클래스" }));
  assert.ok(!m({ sgg: "41465", dong: "상현동", apt: "상현마을" }));
});

test("makeAreaMatcher: 준공연도 조건(AND)과 part 간 OR, 준공연도 없는 행 처리", () => {
  const m = A.makeAreaMatcher({
    parts: [
      { sgg: "41131", dongs: ["신흥동"], minBuildYear: 2016 },
      { sgg: "41410", dongs: ["금정동"], minBuildYear: 1992, maxBuildYear: 1996 },
    ],
  });
  const r = (sgg, dong, by) => ({ sgg, dong, apt: "x", buildYear: by });
  assert.ok(m(r("41131", "신흥동", 2016)) && m(r("41131", "신흥동", 2024)));
  assert.ok(!m(r("41131", "신흥동", 2015)), "하한 미만");
  assert.ok(m(r("41410", "금정동", 1992)) && m(r("41410", "금정동", 1996)));
  assert.ok(!m(r("41410", "금정동", 1991)) && !m(r("41410", "금정동", 1997)), "범위 밖");
  assert.ok(!m(r("41131", "신흥동", undefined)) && !m(r("41131", "신흥동", null)) && !m(r("41131", "신흥동", 0)), "준공연도 없으면 제외");
  assert.ok(!m(r("41131", "태평동", 2020)), "다른 동");
  // 준공연도 조건이 없는 part 는 준공연도가 없어도 통과
  assert.ok(A.makeAreaMatcher({ parts: [{ sgg: "41135" }] })({ sgg: "41135", dong: "x", apt: "y" }));
});

test("basisFilter: 국평 80~86㎡ 경계", () => {
  const f = A.basisFilter("kook");
  assert.ok(f({ areaSqm: 84.97 }) && f({ areaSqm: 80 }) && f({ areaSqm: 86 }));
  assert.ok(!f({ areaSqm: 79.9 }) && !f({ areaSqm: 86.1 }));
  assert.ok(A.basisFilter("all")({ areaSqm: 42 }));
});
