// 수도권(서울·인천·경기) 시군구 코드를 법정동코드표와 실제 API 로 검증하고 data/regions.json 을 갱신한다.
//   node scripts/verify-codes.js            → 검증만(표 출력)
//   node scripts/verify-codes.js --write    → regions.json 의 sigungu/unusable 갱신
// 판정 규칙
//   1) 법정동코드표(MCP 내장)에서 '존재' 인 시군구급 행을 기준 목록으로 삼는다.
//   2) 구가 있는 시의 상위 코드(예: 41590 화성시, 41110 수원시)는 API 가 모든 달에 0건 → unusable (구 코드를 쓴다).
//   3) 나머지는 3개 달(2026-07, 2020-01, 2015-01)을 조회해 한 번이라도 거래가 있으면 verified.
//      모두 0건이면 3개 달을 더 조회하고, 그래도 0건이면 verified:false (코드가 틀렸거나 거래가 거의 없는 지역).
// 호출량: 코드당 3~6회.
"use strict";
const fs = require("fs");
const path = require("path");
const { McpClient } = require("../lib/mcp-client");

try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch { /* 환경변수만 사용 */ }
const dir = path.resolve(__dirname, "..", process.env.MCP_DIR || "vendor/real-estate-mcp");
const TABLE = path.join(dir, "src", "real_estate", "resources", "region_codes.txt");
const REGIONS = path.join(__dirname, "..", "data", "regions.json");
const write = process.argv.includes("--write");

const PREFIX = { "11": "seoul", "28": "incheon", "41": "gyeonggi" };
const NORTH = /고양|파주|김포|의정부|양주|동두천|포천|연천|가평|남양주|구리|하남/;
const PROBE_1 = ["202607", "202001", "201501"];
const PROBE_2 = ["202512", "202306", "201801"];

function readAlive() {
  const out = [];
  for (const line of fs.readFileSync(TABLE, "utf8").split(/\r?\n/)) {
    const [code, name, status] = line.split("\t");
    if (!/^\d{10}$/.test(code || "") || status !== "존재") continue;
    if (code.slice(5) !== "00000" || code.slice(2, 5) === "000" || !PREFIX[code.slice(0, 2)]) continue;
    out.push({ code: code.slice(0, 5), name: name.trim() });
  }
  return out;
}

function shortName(full) {
  return full.replace(/^서울특별시 /, "서울 ").replace(/^인천광역시 /, "인천 ").replace(/^경기도 /, "").trim();
}

function groupOf(code, name) {
  const p = PREFIX[code.slice(0, 2)];
  if (p !== "gyeonggi") return p;
  return NORTH.test(name) ? "gyeonggi-north" : "gyeonggi-south";
}

async function main() {
  const apiKey = (process.env.DATA_GO_KR_API_KEY || "").trim();
  if (!apiKey) throw new Error("DATA_GO_KR_API_KEY 가 없습니다.");
  const alive = readAlive();
  const hasChildren = (c) => alive.some((d) => d.code !== c && d.code.slice(0, 4) === c.slice(0, 4) && c[4] === "0" && d.code[4] !== "0");
  const client = new McpClient({ dir, apiKey });

  async function count(code, ym) {
    const d = await client.callTool("get_apartment_trades", { region_code: code, year_month: ym, num_of_rows: 9999 });
    if (d.error && d.code !== "03") throw new Error(`${code} ${ym}: ${d.error} ${d.code ?? ""} ${d.message}`);
    return d.error ? 0 : d.total_count;
  }

  // 구가 있는 시의 상위 코드도 실제로 0건인지 확인(가정이 아니라 측정)
  const results = new Map();
  const queue = [...alive];
  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      const parent = hasChildren(r.code);
      const counts = {};
      for (const ym of PROBE_1) counts[ym] = await count(r.code, ym);
      let any = Object.values(counts).some((n) => n > 0);
      if (!any && !parent) {
        for (const ym of PROBE_2) counts[ym] = await count(r.code, ym);
        any = Object.values(counts).some((n) => n > 0);
      }
      results.set(r.code, { ...r, parent, counts, any });
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await client.close();

  const list = [...results.values()].sort((a, b) => a.code.localeCompare(b.code));
  console.log("코드    이름                      구있음  거래건수(월별)              판정");
  for (const r of list) {
    const verdict = r.parent ? (r.any ? "상위코드인데 거래 있음(!)" : "unusable(상위)") : r.any ? "verified" : "확인필요(0건)";
    console.log(`${r.code}  ${shortName(r.name).padEnd(18)}  ${r.parent ? "Y" : "-"}     ${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(" ").padEnd(40)} ${verdict}`);
  }
  const weird = list.filter((r) => r.parent && r.any);
  if (weird.length) console.log("\n주의: 상위 코드에서 거래가 나온 곳이 있어 자동 갱신에서 제외하지 않고 사람이 확인해야 합니다:", weird.map((r) => r.code).join(", "));

  if (!write) return;
  const regions = JSON.parse(fs.readFileSync(REGIONS, "utf8"));
  const existing = new Map(regions.sigungu.map((s) => [s.code, s]));
  const sigungu = [];
  const unusable = [];
  for (const r of list) {
    if (r.parent && !r.any) {
      unusable.push({ code: r.code, name: shortName(r.name), reason: "구가 있는 시의 상위 코드 — API 가 모든 달에 0건. 구 코드를 사용" });
      continue;
    }
    const prev = existing.get(r.code);
    sigungu.push({
      code: r.code,
      name: prev ? prev.name : shortName(r.name),
      group: prev ? (prev.group.startsWith("gyeonggi") ? groupOf(r.code, shortName(r.name)) : prev.group) : groupOf(r.code, shortName(r.name)),
      verified: r.any,
      ...(r.any ? {} : { note: "법정동코드표에는 있으나 조회한 6개 달 모두 0건 — 확인 필요" }),
    });
  }
  const order = { seoul: 0, incheon: 1, "gyeonggi-south": 2, "gyeonggi-north": 3 };
  sigungu.sort((a, b) => order[a.group] - order[b.group] || a.code.localeCompare(b.code));
  regions.sigungu = sigungu;
  regions.unusable = unusable;
  fs.writeFileSync(REGIONS, JSON.stringify(regions, null, 2) + "\n");
  console.log(`\nregions.json 갱신: 사용 가능 ${sigungu.length}곳(검증 ${sigungu.filter((s) => s.verified).length}), 사용 불가 상위코드 ${unusable.length}곳`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
