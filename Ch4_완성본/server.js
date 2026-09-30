// 로컬 RAG 검색 서버
// 사용법: node server.js  →  http://localhost:3000
//   GET /                       검색 화면 (rag-search.html)
//   GET /api/search?q=질문&k=5   검색 결과 JSON
const http = require("http");
const fs = require("fs");
const path = require("path");
const { search } = require("./scripts/search-rag");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const PAGE_PATH = path.join(__dirname, "rag-search.html");
const MAX_TOP_K = 20;

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/rag-search.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(PAGE_PATH).pipe(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") || "";
    const topK = Math.min(Math.max(Number(url.searchParams.get("k")) || 5, 1), MAX_TOP_K);
    if (!query.trim()) return sendJson(res, 400, { error: "검색어(q)를 입력하세요." });

    const started = Date.now();
    try {
      const results = await search(query, { topK });
      console.log(`[search] "${query}" → ${results.length}건 (${Date.now() - started}ms)`);
      sendJson(res, 200, { query, topK, elapsedMs: Date.now() - started, results });
    } catch (err) {
      console.error(`[search] "${query}" 실패:`, err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, HOST, () => {
  console.log(`RAG 검색 서버 실행 중: http://localhost:${PORT}`);
});
