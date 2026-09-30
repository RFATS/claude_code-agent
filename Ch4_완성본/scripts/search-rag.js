// rag.db 벡터 검색: 질문을 임베딩하고 코사인 유사도가 높은 Chunk를 반환
//
// CLI:    node scripts/search-rag.js "질문" [--top 5] [--json]
// 모듈:   const { search } = require("./scripts/search-rag");
//         const results = await search("질문", { topK: 5 });
//         // → [{ rank, fileName, chunkIndex, section, similarity, content }]
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const DB_PATH = path.join(ROOT, "rag.db");
const API_URL = "https://defect-rag-embedding-api.vercel.app/api/embed";
const DEFAULT_TOP_K = 5;

// rag.db의 Chunk와 벡터를 메모리에 올려두고, 파일이 바뀌면 다시 읽음
let cache = { mtimeMs: 0, rows: [] };

function loadIndex() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`${DB_PATH}가 없습니다. 먼저 node scripts/build-rag.js를 실행하세요.`);
  }
  const { mtimeMs } = fs.statSync(DB_PATH);
  if (mtimeMs === cache.mtimeMs) return cache.rows;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare("SELECT file_name, chunk_index, section, content, embedding FROM chunks ORDER BY id")
    .all()
    .map((r) => {
      const vector = JSON.parse(r.embedding);
      return {
        fileName: r.file_name,
        chunkIndex: r.chunk_index,
        section: r.section,
        content: r.content,
        vector,
        norm: Math.hypot(...vector),
      };
    });
  db.close();

  cache = { mtimeMs, rows };
  return rows;
}

function getApiKey() {
  if (!process.env.EMBED_API_KEY) {
    try {
      process.loadEnvFile(path.join(ROOT, ".env"));
    } catch {
      // 아래에서 키 유무로 처리
    }
  }
  const apiKey = process.env.EMBED_API_KEY;
  if (!apiKey) throw new Error("EMBED_API_KEY가 .env에 설정되어 있지 않습니다.");
  return apiKey;
}

async function embedQuery(query) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ texts: [query] }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Embedding API 요청 실패 (HTTP ${res.status}): ${body}`);
  return JSON.parse(body).embeddings[0];
}

function cosine(a, normA, b, normB) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

async function search(query, { topK = DEFAULT_TOP_K } = {}) {
  query = String(query ?? "").trim();
  if (!query) throw new Error("검색어가 비어 있습니다.");

  const rows = loadIndex();
  const queryVector = await embedQuery(query);
  const queryNorm = Math.hypot(...queryVector);

  return rows
    .map((r) => ({ row: r, similarity: cosine(queryVector, queryNorm, r.vector, r.norm) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map(({ row, similarity }, i) => ({
      rank: i + 1,
      fileName: row.fileName,
      chunkIndex: row.chunkIndex,
      section: row.section,
      similarity: Number(similarity.toFixed(4)),
      content: row.content,
    }));
}

module.exports = { search };

// CLI로 직접 실행한 경우
if (require.main === module) {
  let json = false;
  let topK = DEFAULT_TOP_K;
  const words = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--top") topK = Number(args[++i]) || DEFAULT_TOP_K;
    else words.push(args[i]);
  }
  const query = words.join(" ");

  if (!query) {
    console.error('사용법: node scripts/search-rag.js "질문" [--top 5] [--json]');
    process.exit(1);
  }

  search(query, { topK })
    .then((results) => {
      if (json) {
        console.log(JSON.stringify({ query, results }, null, 2));
        return;
      }
      console.log(`질문: ${query}\n`);
      for (const r of results) {
        console.log(`#${r.rank}  유사도 ${r.similarity.toFixed(4)}  ${r.fileName}  (${r.section})`);
        console.log(r.content.replace(/^/gm, "    "));
        console.log();
      }
    })
    .catch((err) => {
      console.error("오류:", err.message);
      process.exit(1);
    });
}
