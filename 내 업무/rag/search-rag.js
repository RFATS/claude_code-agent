// rag/rag.db 벡터 검색: 알림/에러 설명을 임베딩하고 코사인 유사도가 높은 과거 사례를 반환
// (Ch4_실습용/scripts/search-rag.js를 차용해 과거 fail 대응 이력용으로 조정)
//
// CLI:  node rag/search-rag.js "질문" [--top 5] [--decision 승인|불승인] [--json]
// 모듈: const { search } = require("./rag/search-rag");
//       const results = await search("질문", { topK: 5, decision: "승인" });
//       // → [{ rank, caseId, date, dagId, taskId, errorType, judgment, decision, similarity, content }]
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // Node 22.5+ 내장 SQLite

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "rag.db");
const API_URL = "https://defect-rag-embedding-api.vercel.app/api/embed";
const DEFAULT_TOP_K = 5;

// Chunk와 벡터를 메모리에 올려두고, rag.db가 다시 만들어지면 새로 읽음
let cache = { mtimeMs: 0, rows: [] };

function loadIndex() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`${DB_PATH}가 없습니다. 먼저 node rag/build-rag.js를 실행하세요.`);
  }
  const { mtimeMs } = fs.statSync(DB_PATH);
  if (mtimeMs === cache.mtimeMs) return cache.rows;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare("SELECT case_id, case_date, dag_id, task_id, error_type, judgment, human_decision, content, embedding FROM chunks ORDER BY id")
    .all()
    .map((r) => {
      const vector = JSON.parse(r.embedding);
      return {
        caseId: r.case_id,
        date: r.case_date,
        dagId: r.dag_id,
        taskId: r.task_id,
        errorType: r.error_type,
        judgment: r.judgment,
        decision: r.human_decision,
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
  if (!apiKey) throw new Error("EMBED_API_KEY가 rag/.env에 설정되어 있지 않습니다.");
  return apiKey;
}

// test-embedding.js와 동일한 방식: POST {texts} + Bearer 인증
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

// decision: "승인" 또는 "불승인"을 주면 해당 결정의 사례만 검색
async function search(query, { topK = DEFAULT_TOP_K, decision } = {}) {
  query = String(query ?? "").trim();
  if (!query) throw new Error("검색어가 비어 있습니다.");

  const rows = loadIndex().filter((r) => !decision || r.decision === decision);
  const queryVector = await embedQuery(query);
  const queryNorm = Math.hypot(...queryVector);

  return rows
    .map((row) => ({ row, similarity: cosine(queryVector, queryNorm, row.vector, row.norm) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map(({ row, similarity }, i) => ({
      rank: i + 1,
      caseId: row.caseId,
      date: row.date,
      dagId: row.dagId,
      taskId: row.taskId,
      errorType: row.errorType,
      judgment: row.judgment,
      decision: row.decision,
      similarity: Number(similarity.toFixed(4)),
      content: row.content,
    }));
}

module.exports = { search };

// CLI로 직접 실행한 경우
if (require.main === module) {
  let json = false;
  let topK = DEFAULT_TOP_K;
  let decision;
  const words = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--top") topK = Number(args[++i]) || DEFAULT_TOP_K;
    else if (args[i] === "--decision") decision = args[++i];
    else words.push(args[i]);
  }
  const query = words.join(" ");

  if (!query) {
    console.error('사용법: node rag/search-rag.js "질문" [--top 5] [--decision 승인|불승인] [--json]');
    process.exit(1);
  }

  search(query, { topK, decision })
    .then((results) => {
      if (json) {
        console.log(JSON.stringify({ query, results }, null, 2));
        return;
      }
      console.log(`질문: ${query}\n`);
      for (const r of results) {
        console.log(`#${r.rank}  유사도 ${r.similarity.toFixed(4)}  ${r.caseId}  [${r.judgment} / ${r.decision}]`);
        console.log(r.content.replace(/^/gm, "    "));
        console.log();
      }
    })
    .catch((err) => {
      console.error("오류:", err.message);
      process.exit(1);
    });
}
