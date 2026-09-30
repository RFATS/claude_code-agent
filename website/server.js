// 급지 역전 탐지 웹사이트 — 로컬 서버 (LLM 없음, 데이터 적재 없음)
// 사용법: node server.js  →  http://127.0.0.1:3000
//
// 데이터 소스
//   live   : DATA_GO_KR_API_KEY 와 MCP 저장소(vendor/real-estate-mcp)가 있으면, 요청마다 MCP 툴로 국토교통부 API 를 실시간 호출
//   sample : 그렇지 않으면 가상 샘플을 그 자리에서 생성 (화면에 '샘플 데이터' 배지)
//   SOURCE=live|sample 로 강제할 수 있다.
//
// API (모두 GET, JSON)
//   /api/status                                         소스·캐시·일일 호출 수
//   /api/areas                                          프리셋·권역·시군구 목록
//   /api/dongs?sgg=41135                                시군구의 법정동 목록 (최근 3개월 조회)
//   /api/series?a=&b=&basis=all|kook&from=YYYYMM&step=1|3   두 지역 시계열 + 역전 구간 + 반사실
//   /api/inversions?group=default&basis=&from=&step=    비교군 역전 사례 랭킹
//   조회가 끝나기 전에는 state:"loading" 과 progress 를 돌려주므로 클라이언트가 폴링한다.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Engine, httpError } = require("./lib/engine");
const { MonthStore } = require("./lib/month-store");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  /* .env 없음 — 환경변수만 사용 */
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// ---------- 소스 선택 ----------
function createSource() {
  const apiKey = (process.env.DATA_GO_KR_API_KEY || "").trim();
  const mcpDir = path.resolve(__dirname, process.env.MCP_DIR || "vendor/real-estate-mcp");
  const canLive = Boolean(apiKey) && fs.existsSync(mcpDir);
  const want = process.env.SOURCE || (canLive ? "live" : "sample");
  if (want === "live") {
    if (!canLive) {
      console.error("SOURCE=live 인데 DATA_GO_KR_API_KEY 또는 MCP 저장소(vendor/real-estate-mcp)가 없습니다. scripts/setup-mcp.js 를 먼저 실행하세요.");
      process.exit(1);
    }
    const { McpClient } = require("./lib/mcp-client");
    const { createMcpSource } = require("./lib/source-mcp");
    const client = new McpClient({ dir: mcpDir, apiKey });
    process.on("SIGINT", () => client.close().finally(() => process.exit(0)));
    return createMcpSource(client);
  }
  const { createSampleSource } = require("./lib/sample-source");
  return createSampleSource();
}

const store = new MonthStore(createSource(), {
  dailyLimit: Number(process.env.DAILY_LIMIT) || 9000,
  concurrency: Number(process.env.CONCURRENCY) || 3,
});
const engine = new Engine(store);

// ---------- HTTP ----------
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return sendJson(res, 404, { error: "Not Found" });
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== "GET") return sendJson(res, 405, { error: "GET 만 지원합니다." });
  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

  const q = (k, d) => url.searchParams.get(k) || d;
  const time = { from: q("from"), step: q("step") };
  try {
    let body;
    switch (url.pathname) {
      case "/api/status":
        body = engine.status();
        break;
      case "/api/areas":
        body = engine.areas();
        break;
      case "/api/dongs":
        body = engine.dongs(q("sgg"));
        break;
      case "/api/series":
        body = engine.analyzePair(q("a"), q("b"), q("basis", "kook"), time);
        break;
      case "/api/inversions":
        body = engine.ranking(q("group", "default"), q("basis", "kook"), time);
        break;
      default:
        throw httpError(404, "Not Found");
    }
    sendJson(res, 200, body);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(`[api] ${url.pathname} 실패:`, err);
    sendJson(res, status, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`급지 역전 서버 실행 중: http://${HOST}:${PORT}  (소스: ${store.source.kind})`);
});
