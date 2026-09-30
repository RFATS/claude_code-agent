// 샘플 소스 — 키 발급 전 UI·알고리즘 개발용 "가상" 데이터 생성기.
// 실시간 소스(source-mcp.js)와 같은 인터페이스: fetchMonth(sgg, ym) → { rows, totalCount }
// 요청받은 (시군구, 월)의 거래를 그 자리에서 결정적으로 만들어 낼 뿐, 어디에도 저장하지 않는다.
// 실제 시세가 아니며 단지명도 [샘플] 표기의 가상 이름이다. 화면에 '샘플 데이터' 배지가 상시 표시된다.
"use strict";
const { PY } = require("./analytics");

// FNV-1a 문자열 해시 → 시드
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 결정적 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 연도 앵커 사이를 선형 보간한 평당가(만원) 곡선
function curve(anchors) {
  const ys = Object.keys(anchors).map(Number).sort((a, b) => a - b);
  return (ym) => {
    const t = Number(ym.slice(0, 4)) + (Number(ym.slice(4, 6)) - 1) / 12;
    if (t <= ys[0]) return anchors[ys[0]];
    if (t >= ys[ys.length - 1]) return anchors[ys[ys.length - 1]];
    for (let i = 0; i < ys.length - 1; i++) {
      if (t >= ys[i] && t <= ys[i + 1]) {
        const k = (t - ys[i]) / (ys[i + 1] - ys[i]);
        return anchors[ys[i]] * (1 - k) + anchors[ys[i + 1]] * k;
      }
    }
  };
}

// 광교 고평가 → 분당 금곡동 역전 같은 '모양'을 시험하기 위한 가상 곡선. 실제와 무관하다.
const AREAS = [
  {
    sgg: "41117", dong: "이의동", apts: ["[샘플]광교A", "[샘플]광교B", "[샘플]광교C"], vol: [14, 22],
    py: curve({ 2011: 1250, 2013: 1450, 2014: 1550, 2016: 2300, 2018: 3100, 2020: 3900, 2021: 4900, 2022: 4100, 2023: 3900, 2024: 4300, 2025: 4900, 2026: 5300 }),
    sizes: [59, 84, 84, 84, 101],
  },
  {
    sgg: "41117", dong: "하동", apts: ["[샘플]광교D", "[샘플]광교E"], vol: [12, 20],
    py: curve({ 2011: 1200, 2013: 1400, 2014: 1500, 2016: 2150, 2018: 2900, 2020: 3650, 2021: 4600, 2022: 3900, 2023: 3700, 2024: 4050, 2025: 4600, 2026: 5000 }),
    sizes: [59, 84, 84, 101],
  },
  {
    sgg: "41117", dong: "영통동", apts: ["[샘플]영통주공"], vol: [10, 16],
    py: curve({ 2011: 1100, 2016: 1350, 2020: 2100, 2021: 2800, 2023: 2500, 2026: 3000 }),
    sizes: [59, 84],
  },
  {
    sgg: "41465", dong: "상현동", apts: ["[샘플]광교F", "[샘플]상현마을"], vol: [10, 16],
    py: curve({ 2011: 1180, 2014: 1400, 2018: 2500, 2021: 3900, 2022: 3300, 2024: 3500, 2026: 4200 }),
    sizes: [59, 84, 84],
  },
  {
    sgg: "41135", dong: "금곡동", apts: ["[샘플]금곡청솔A", "[샘플]금곡청솔B", "[샘플]금곡위브"], vol: [16, 26],
    py: curve({ 2011: 1650, 2014: 1700, 2016: 1900, 2018: 2400, 2020: 3100, 2021: 3900, 2022: 4300, 2023: 4200, 2024: 4800, 2025: 5700, 2026: 6300 }),
    sizes: [42, 50, 59, 59, 84, 84, 84], // 재건축 기대 소형이 섞여 '전체'가 국평보다 높게 나오는 구조
    smallPremium: true,
  },
  {
    sgg: "41135", dong: "구미동", apts: ["[샘플]구미까치A", "[샘플]구미까치B"], vol: [12, 20],
    py: curve({ 2011: 1700, 2014: 1750, 2018: 2500, 2020: 3200, 2021: 4000, 2022: 4500, 2024: 5000, 2026: 6400 }),
    sizes: [59, 84, 84, 101],
  },
  {
    sgg: "41135", dong: "정자동", apts: ["[샘플]정자A", "[샘플]정자B", "[샘플]정자C"], vol: [14, 22],
    py: curve({ 2011: 2000, 2014: 2050, 2018: 3000, 2020: 3900, 2021: 5000, 2022: 5400, 2024: 6200, 2026: 7600 }),
    sizes: [59, 84, 101, 114],
  },
];

function createSampleSource({ delayMs = Number(process.env.SAMPLE_DELAY_MS ?? 30) } = {}) {
  return {
    kind: "sample",
    async fetchMonth(sgg, ym) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs)); // 실시간 호출의 지연을 흉내
      const rows = [];
      const year = Number(ym.slice(0, 4));
      for (const area of AREAS) {
        if (area.sgg !== sgg) continue;
        const random = rng(hash(`${area.sgg}|${area.dong}|${ym}`));
        const n = area.vol[0] + Math.floor(random() * (area.vol[1] - area.vol[0] + 1));
        const base = area.py(ym);
        for (let i = 0; i < n; i++) {
          const size = area.sizes[Math.floor(random() * area.sizes.length)];
          const areaSqm = size - random() * 0.6; // 84 → 83.4~84
          let py = base * (0.94 + random() * 0.12);
          if (area.smallPremium && size <= 60) {
            const ramp = Math.min(1, Math.max(0, (year - 2019) / 6)); // 2019→2025 소형 프리미엄 최대 +30%
            py *= 1 + 0.3 * ramp;
          }
          rows.push({
            sgg,
            ym,
            dong: area.dong,
            apt: area.apts[Math.floor(random() * area.apts.length)],
            areaSqm: Math.round(areaSqm * 100) / 100,
            floor: 1 + Math.floor(random() * 25),
            priceMan: Math.round((py * (areaSqm / PY)) / 10) * 10,
            date: `${ym.slice(0, 4)}-${ym.slice(4)}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
            buildYear: 2008 + Math.floor(random() * 8),
            dealType: year >= 2022 ? "중개거래" : "",
          });
        }
      }
      return { rows, totalCount: rows.length };
    },
  };
}

module.exports = { createSampleSource };
