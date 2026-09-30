// 키 발급 직후 1회 실행하는 프로브 — 실제 API 로 "미확인 항목"을 확정한다.
//   node scripts/probe.js [--bad-key]
// 확인 내용: 서버 기동 시간 · 툴 목록 · 응답 형태 · num_of_rows 상한 · 2011년 월 응답 · 데이터 없는 월 · (선택) 잘못된 키의 오류 코드
// 호출은 10회 안팎이다. API 키는 출력하지 않는다.
"use strict";
const path = require("path");
const { McpClient } = require("../lib/mcp-client");
const { STABLE_TRIM } = require("../lib/engine");
const { idxToYm } = require("../lib/analytics");

try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch { /* 환경변수만 사용 */ }

const dir = path.resolve(__dirname, "..", process.env.MCP_DIR || "vendor/real-estate-mcp");
const apiKey = (process.env.DATA_GO_KR_API_KEY || "").trim();
if (!apiKey) { console.error("DATA_GO_KR_API_KEY 가 없습니다 (.env 확인)."); process.exit(1); }

const d = new Date();
const lastStable = idxToYm(d.getFullYear() * 12 + d.getMonth() - STABLE_TRIM);
const SGG = "41135"; // 성남시 분당구
const client = new McpClient({ dir, apiKey });

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  [${label}] ${Date.now() - t0}ms`);
    return r;
  } catch (err) {
    console.log(`  [${label}] 예외 ${Date.now() - t0}ms: ${err.message}`);
    return null;
  }
}

function brief(data) {
  if (!data) return "(응답 없음)";
  if (data.error) return `error=${data.error} code=${data.code ?? "-"} message=${String(data.message).slice(0, 120)}`;
  return `total_count=${data.total_count} items=${data.items ? data.items.length : "-"} summary=${JSON.stringify(data.summary)}`;
}

(async () => {
  console.log(`1) 서버 기동·툴 목록 (첫 실행은 .venv 생성으로 오래 걸릴 수 있음)`);
  const tools = await timed("connect+listTools", () => client.listTools());
  if (!tools) { console.log("서버를 띄우지 못했습니다. scripts/setup-mcp.js 를 먼저 실행했는지 확인하세요."); process.exit(1); }
  const names = tools.map((t) => t.name);
  console.log(`  툴 ${names.length}개, get_apartment_trades ${names.includes("get_apartment_trades") ? "있음" : "없음(!)"}`);
  const trade = tools.find((t) => t.name === "get_apartment_trades");
  if (trade) console.log(`  입력 스키마: ${JSON.stringify(trade.inputSchema.properties)}`);

  console.log(`2) 최근 안정 월(${lastStable}) ${SGG} 응답 형태`);
  const sample = await timed("call", () => client.callTool("get_apartment_trades", { region_code: SGG, year_month: lastStable, num_of_rows: 100 }));
  console.log(`  ${brief(sample)}`);
  if (sample && sample.items && sample.items[0]) console.log(`  첫 행 키: ${Object.keys(sample.items[0]).join(", ")}`);

  console.log("3) num_of_rows 상한 — 같은 달을 크기만 바꿔 호출 (items 가 total_count 에 못 미치면 잘림)");
  for (const n of [1000, 3000, 9999, 99999]) {
    const r = await timed(`num_of_rows=${n}`, () => client.callTool("get_apartment_trades", { region_code: SGG, year_month: lastStable, num_of_rows: n }));
    console.log(`  ${brief(r)}`);
    if (r && r.error) break;
  }

  console.log("4) 오래된 달 — 2011-01, 2006-01");
  for (const ym of ["201101", "200601"]) {
    const r = await timed(ym, () => client.callTool("get_apartment_trades", { region_code: SGG, year_month: ym, num_of_rows: 3000 }));
    console.log(`  ${ym}: ${brief(r)}`);
  }

  console.log("5) 데이터가 없을 만한 조합 — 존재하지 않는 시군구 코드 99999");
  const none = await timed("99999", () => client.callTool("get_apartment_trades", { region_code: "99999", year_month: lastStable, num_of_rows: 100 }));
  console.log(`  ${brief(none)}`);

  await client.close();

  if (process.argv.includes("--bad-key")) {
    console.log("6) 잘못된 키 — code 30 으로 분류되는지");
    const bad = new McpClient({ dir, apiKey: "invalid-key-for-probe" });
    const r = await timed("bad-key", () => bad.callTool("get_apartment_trades", { region_code: SGG, year_month: lastStable, num_of_rows: 10 }));
    console.log(`  ${brief(r)}`);
    await bad.close();
  }
  console.log("\n결과를 lib/source-mcp.js 의 FIRST_ROWS/MAX_ROWS 와 lib/engine.js 의 MIN_FROM 에 반영하세요.");
})().catch((err) => { console.error(err); process.exit(1); });
