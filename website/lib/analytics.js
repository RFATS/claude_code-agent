// 급지 역전 분석 — 순수 함수 모음 (DB·네트워크 의존 없음, node:test 대상)
//
// 용어
//   A = 현재 상급지(직전 12개월 중위 평당가가 더 높은 쪽), B = 현재 하급지
//   역전 = B의 평당가가 A보다 높았던 구간 ("당시 A가 상대적으로 저평가")
//   평당가 = 거래금액(만원) / (전용면적㎡ / 3.3058)  ← 전용면적 기준
"use strict";

const PY = 3.3058; // 1평 = 3.3058㎡
const KOOK = { min: 80, max: 86 }; // 국평(전용 84㎡ 부근)

// ---------- 기본 유틸 ----------
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const pricePerPy = (row) => row.priceMan / (row.areaSqm / PY);

// 'YYYYMM' ↔ 월 인덱스
const ymToIdx = (ym) => Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(4, 6)) - 1);
const idxToYm = (i) => `${Math.floor(i / 12)}${String((i % 12) + 1).padStart(2, "0")}`;

function monthRange(from, to) {
  const out = [];
  for (let i = ymToIdx(from); i <= ymToIdx(to); i++) out.push(idxToYm(i));
  return out;
}

// ---------- 이상치 제거 ----------
// (시군구, 단지, 면적대(5㎡), 연도) 그룹 중위 가격 대비 ±50% 밖이고 그룹 표본이 3건 이상이면 제외
// 예) 앱 오류로 신고된 25.7억(실제 14.35억) 같은 건
function removeOutliers(rows, { band = 0.5, minGroup = 3 } = {}) {
  const key = (r) => `${r.sgg}|${r.apt}|${Math.round(r.areaSqm / 5) * 5}|${r.ym.slice(0, 4)}`;
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r.priceMan);
  }
  const med = new Map();
  for (const [k, arr] of groups) if (arr.length >= minGroup) med.set(k, median(arr));

  const kept = [];
  let removed = 0;
  for (const r of rows) {
    const m = med.get(key(r));
    if (m && (r.priceMan < m * (1 - band) || r.priceMan > m * (1 + band))) removed++;
    else kept.push(r);
  }
  return { rows: kept, removed };
}

// ---------- 권역 필터 ----------
// area = { parts:[{ sgg, dongs?:[..], aptRegex?:string, aptExact?:string, minBuildYear?:number, maxBuildYear?:number }] }
// 한 part 안의 조건은 모두(AND) 만족해야 하고, part 들은 하나라도(OR) 맞으면 권역에 든다.
// 준공연도 조건이 있는데 행에 준공연도가 없으면 그 part 에는 맞지 않는 것으로 본다.
function makeAreaMatcher(area) {
  const parts = area.parts.map((p) => ({
    sgg: p.sgg,
    dongs: p.dongs ? new Set(p.dongs) : null,
    re: p.aptRegex ? new RegExp(p.aptRegex) : null,
    exact: p.aptExact || null,
    minBy: p.minBuildYear ?? null,
    maxBy: p.maxBuildYear ?? null,
  }));
  return (r) =>
    parts.some((p) => {
      if (r.sgg !== p.sgg) return false;
      if (p.dongs && !p.dongs.has(r.dong)) return false;
      if (p.re && !p.re.test(r.apt)) return false;
      if (p.exact && r.apt !== p.exact) return false;
      if (p.minBy != null || p.maxBy != null) {
        const by = Number(r.buildYear);
        if (!Number.isFinite(by) || by <= 0) return false;
        if (p.minBy != null && by < p.minBy) return false;
        if (p.maxBy != null && by > p.maxBy) return false;
      }
      return true;
    });
}

// 측정기준: all = 전체, kook = 국평(80~86㎡)만
function basisFilter(basis) {
  if (basis === "kook") return (r) => r.areaSqm >= KOOK.min && r.areaSqm <= KOOK.max;
  return () => true;
}

// ---------- 월별 시계열 ----------
// 각 달 m에 대해 [m-window+1, m] 구간 거래의 중위값. 표본 < minN이면 null(결측).
// 반환: { months, py:[..], price:[..], n:[..] }  (price = 중위 거래가, 만원)
function buildSeries(rows, months, { window = 3, minN = 3 } = {}) {
  const byMonth = new Map(months.map((m) => [m, []]));
  for (const r of rows) {
    const bucket = byMonth.get(r.ym);
    if (bucket) bucket.push(r);
  }
  const py = [];
  const price = [];
  const n = [];
  for (let i = 0; i < months.length; i++) {
    const pool = [];
    for (let j = Math.max(0, i - window + 1); j <= i; j++) pool.push(...byMonth.get(months[j]));
    n.push(pool.length);
    if (pool.length < minN) {
      py.push(null);
      price.push(null);
    } else {
      py.push(median(pool.map(pricePerPy)));
      price.push(median(pool.map((r) => r.priceMan)));
    }
  }
  return { months, py, price, n };
}

// ---------- 급지 판정 ----------
// 시계열의 마지막 lastN개월 중 유효값의 중위 평당가
function trailingLevel(series, lastN = 12) {
  const vals = series.py.slice(-lastN).filter((v) => v != null);
  return vals.length ? median(vals) : null;
}

// 두 시계열 중 현재 상급지 반환: { upper:'a'|'b'|null, levelA, levelB }
function decideUpper(seriesA, seriesB, lastN = 12) {
  const levelA = trailingLevel(seriesA, lastN);
  const levelB = trailingLevel(seriesB, lastN);
  if (levelA == null || levelB == null) return { upper: null, levelA, levelB };
  return { upper: levelA >= levelB ? "a" : "b", levelA, levelB };
}

// ---------- 역전 구간 탐지 ----------
// upperSeries(A)·lowerSeries(B): buildSeries 결과. B>A 인 달이 연속(공백 maxGap 이내 병합)해
// 실제 역전 달 수가 minMonths 이상이면 구간으로 인정.
function detectInversions(upper, lower, { minMonths = 3, maxGap = 1, minGapPct = 0 } = {}) {
  const months = upper.months;
  const flag = months.map((_, i) => {
    const a = upper.py[i];
    const b = lower.py[i];
    if (a == null || b == null) return null;
    return b / a - 1 > minGapPct / 100 ? true : false;
  });

  // 1) true 연속 구간(run) 수집
  const runs = [];
  let start = -1;
  for (let i = 0; i <= flag.length; i++) {
    if (i < flag.length && flag[i] === true) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }

  // 2) 간격이 maxGap 이하인 run 병합
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] - 1 <= maxGap) last[1] = run[1];
    else merged.push([...run]);
  }

  // 3) 실제 역전 달 수·최대 격차 계산 후 필터
  const episodes = [];
  for (const [s, e] of merged) {
    let invMonths = 0;
    let peakGap = -Infinity;
    let peakIdx = s;
    let sumGap = 0;
    for (let i = s; i <= e; i++) {
      if (flag[i] === true) {
        invMonths++;
        const gap = lower.py[i] / upper.py[i] - 1;
        sumGap += gap;
        if (gap > peakGap) {
          peakGap = gap;
          peakIdx = i;
        }
      }
    }
    if (invMonths < minMonths) continue;
    episodes.push({
      startIdx: s,
      endIdx: e,
      peakIdx,
      start: months[s],
      end: months[e],
      peak: months[peakIdx],
      spanMonths: e - s + 1,
      invertedMonths: invMonths,
      peakGapPct: peakGap * 100,
      avgGapPct: (sumGap / invMonths) * 100,
      ongoing: e === months.length - 1 || flag.slice(e + 1).every((f) => f === null),
    });
  }
  return episodes;
}

// ---------- 반사실 수익 ----------
// ym 시점에 B 대신 A를 샀다면 (둘 다 국평 중위 거래가 기준 series.price 사용)
// 현재가 = 마지막 nowN개월 유효값의 중위
function counterfactual(upper, lower, ym, { nowN = 3 } = {}) {
  const i = upper.months.indexOf(ym);
  if (i < 0) return null;
  const buyA = upper.price[i];
  const buyB = lower.price[i];
  if (buyA == null || buyB == null) return null;
  const nowA = median(upper.price.slice(-nowN));
  const nowB = median(lower.price.slice(-nowN));
  if (nowA == null || nowB == null) return null;
  const retA = nowA / buyA - 1;
  const retB = nowB / buyB - 1;
  return {
    ym,
    buyA, buyB, nowA, nowB,
    retA: retA * 100,
    retB: retB * 100,
    gainA: nowA - buyA, // 절대 차익(만원)
    gainB: nowB - buyB,
    edgePp: (retA - retB) * 100, // A가 B보다 수익률이 몇 %p 높았는지
    priceDiff: buyA - buyB, // 매수 당시 가격 차(만원, 음수면 A가 더 쌌음)
  };
}

module.exports = {
  PY, KOOK, median, pricePerPy, ymToIdx, idxToYm, monthRange,
  removeOutliers, makeAreaMatcher, basisFilter,
  buildSeries, trailingLevel, decideUpper, detectInversions, counterfactual,
};
