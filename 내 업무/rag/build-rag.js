// data/past_cases.csv(과거 fail 대응 이력)를 사례 1건 = Chunk 1개로 만들어 Embedding → SQLite(rag/rag.db) 저장
// 사용법: node rag/build-rag.js
// (Ch4_실습용/scripts/build-rag.js의 Embedding·SQLite 저장 방식을 차용)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // Node 22.5+ 내장 SQLite

const ROOT = __dirname;
const CSV_PATH = path.join(ROOT, "..", "data", "past_cases.csv");
const DB_PATH = path.join(ROOT, "rag.db");
const API_URL = "https://defect-rag-embedding-api.vercel.app/api/embed";
const BATCH_SIZE = 16;

process.loadEnvFile(path.join(ROOT, ".env"));
const apiKey = process.env.EMBED_API_KEY;
if (!apiKey) {
  console.error("EMBED_API_KEY가 rag/.env에 설정되어 있지 않습니다.");
  process.exit(1);
}

// 따옴표·줄바꿈을 지원하는 간단한 CSV 파서
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// 사례 1건을 하나의 Chunk 텍스트로 만든다. 검색에 필요한 핵심 정보를 모두 포함한다.
function toChunk(c) {
  return [
    `[${c.case_id} · ${c.date} · ${c.dag_id} / ${c.task_id}]`,
    `에러 유형: ${c.error_type}`,
    `에러 메시지: ${c.error_message}`,
    `판별 결과: ${c.judgment}`,
    `원인: ${c.root_cause}`,
    `조치 내용: ${c.fix_summary}`,
    `사람의 결정: ${c.human_decision}`,
    `검토 의견: ${c.reviewer_comment}`,
  ].join("\n");
}

// test-embedding.js와 동일한 방식: POST {texts} + Bearer 인증
async function embed(texts) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ texts }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Embedding API 요청 실패 (HTTP ${res.status}): ${body}`);

  const data = JSON.parse(body);
  if (data.embeddings?.length !== texts.length) {
    throw new Error(`요청 ${texts.length}개에 대해 임베딩 ${data.embeddings?.length}개가 반환되었습니다.`);
  }
  return data;
}

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id        TEXT    NOT NULL,
      case_date      TEXT    NOT NULL,
      dag_id         TEXT    NOT NULL,
      task_id        TEXT    NOT NULL,
      error_type     TEXT    NOT NULL,
      judgment       TEXT    NOT NULL,   -- 진성 / 가성
      human_decision TEXT    NOT NULL,   -- 승인 / 불승인
      content        TEXT    NOT NULL,
      embedding      TEXT    NOT NULL,   -- JSON 배열 문자열
      dims           INTEGER NOT NULL,
      model          TEXT    NOT NULL,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX idx_chunks_case ON chunks(case_id);
  `);
  return db;
}

async function main() {
  // 1. Chunking: 사례 1건 = Chunk 1개
  const text = fs.readFileSync(CSV_PATH, "utf8").replace(/^﻿/, "");
  const cases = parseCsv(text);
  const chunks = cases.map((c) => ({ meta: c, content: toChunk(c) }));
  console.log(`과거 사례 ${cases.length}건 → Chunk ${chunks.length}개`);

  // 2. Embedding (BATCH_SIZE씩 나눠서 요청)
  let model = null;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const data = await embed(batch.map((c) => c.content));
    model = data.model;
    batch.forEach((c, j) => (c.embedding = data.embeddings[j]));
    console.log(`Embedding ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} 완료`);
  }

  // 3. SQLite 저장
  const db = openDb();
  const insert = db.prepare(
    "INSERT INTO chunks (case_id, case_date, dag_id, task_id, error_type, judgment, human_decision, content, embedding, dims, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  for (const { meta: m, content, embedding } of chunks) {
    insert.run(m.case_id, m.date, m.dag_id, m.task_id, m.error_type, m.judgment, m.human_decision, content, JSON.stringify(embedding), embedding.length, model);
  }
  db.exec("COMMIT");

  const rows = db.prepare("SELECT human_decision, COUNT(*) AS n, MIN(dims) AS dims FROM chunks GROUP BY human_decision").all();
  console.log(`\n저장 완료: ${DB_PATH} (모델: ${model})`);
  console.table(rows);
  db.close();
}

main().catch((err) => {
  console.error("오류:", err.message);
  process.exit(1);
});
