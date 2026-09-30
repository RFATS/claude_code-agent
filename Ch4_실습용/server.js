// 로컬 RAG 검색 서버
// 사용법: node server.js   →  http://localhost:3000
//   GET /                    rag-search.html
//   GET /api/search?q=질문&top=5   JSON 검색 결과
const http = require("http");
const fs = require("fs");
const path = require("path");
const { search } = require("./scripts/search-rag");

const PORT = Number(process.env.PORT) || 3000;
const HTML_PATH = path.join(__dirname, "rag-search.html");

const sendJson = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/rag-search.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(HTML_PATH));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return sendJson(res, 400, { error: "검색어(q)를 입력하세요." });
    const topK = Math.min(Math.max(Number(url.searchParams.get("top")) || 5, 1), 20);
    try {
      sendJson(res, 200, { query, results: await search(query, { topK }) });
    } catch (err) {
      console.error("검색 오류:", err.message);
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RAG 검색 서버 실행 중: http://localhost:${PORT}`);
});
