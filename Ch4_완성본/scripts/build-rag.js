// 문서를 제목/소제목 구조로 Chunking → Embedding → SQLite(rag.db)에 저장
// 사용법: node scripts/build-rag.js
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // Node 22.5+ 내장 SQLite

const ROOT = path.join(__dirname, "..");
const DOCS_DIR = path.join(ROOT, "documents");
const DB_PATH = path.join(ROOT, "rag.db");
const API_URL = "https://defect-rag-embedding-api.vercel.app/api/embed";
const BATCH_SIZE = 16;
const MIN_BODY = 40; // 본문이 이보다 짧은 소제목은 단독 Chunk로 만들지 않고 인접 섹션과 합침

const FILES = [
  "설비운영매뉴얼_통합본.txt",
  "이슈보고서_CVD-01_챔버압력편차_20260814.txt",
  "이슈보고서_ETCH-02_냉각수온도상승_20260720.txt",
  "품질회의록_20260715_ETCH-02.txt",
  "품질회의록_20260818_CVD-01.txt",
];

const RULE_LINE = /^=+\s*$/;                     // ===== 구분선
const LEVEL1 = /^(제\d+장\s|\d+\.\s)/;            // 제1장 … / 1. 개요
const LEVEL2 = /^(\d+\.\d+\s|\[[^\]]+\]\s*$)/;   // 1.1 … / [정민재 - 설비기술팀]
const META_LINE = /^[^:]{1,15}:\s/;              // 문서번호: … 형태의 메타데이터 줄
const CONTEXT_KEYS = ["문서번호", "작성일", "회의일시", "관련 설비"];

process.loadEnvFile(path.join(ROOT, ".env"));
const apiKey = process.env.EMBED_API_KEY;
if (!apiKey) {
  console.error("EMBED_API_KEY가 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

const joinBody = (lines) => lines.join("\n").trim();

// 머리말 / 1단계 제목 / 2단계 제목으로 문서를 트리 형태로 파싱
function parse(text) {
  const preamble = [];
  const sections = [];
  let target = preamble;
  let l1 = null;

  for (const line of text.split("\n")) {
    if (RULE_LINE.test(line)) continue;
    if (LEVEL1.test(line)) {
      l1 = { heading: line.trim(), body: [], children: [] };
      sections.push(l1);
      target = l1.body;
    } else if (l1 && LEVEL2.test(line)) {
      const child = { heading: line.trim(), body: [] };
      l1.children.push(child);
      target = child.body;
    } else {
      target.push(line);
    }
  }
  return { preamble: joinBody(preamble), sections };
}

// 모든 Chunk 앞에 붙일 문서 정보 한 줄: [제목 · 문서번호 · 작성일 · 관련 설비]
function buildDocContext(fileName, preamble) {
  const [title, ...rest] = preamble.split("\n").map((l) => l.trim());
  const meta = rest.filter((l) => CONTEXT_KEYS.some((k) => l.startsWith(`${k}:`)));
  // 회의록은 본문에 설비 정보가 없으므로 파일명에서 설비 ID를 가져옴
  const equipment = fileName.match(/_([A-Z]+-\d+)[_.]/);
  if (equipment && !meta.some((l) => l.startsWith("관련 설비:"))) meta.push(`관련 설비: ${equipment[1]}`);
  return `[${[title, ...meta].join(" · ")}]`;
}

// 머리말이 제목·메타데이터로만 되어 있으면 짧은 내용이므로 첫 Chunk에 합침
function preambleHasProse(preamble) {
  return preamble.split("\n").slice(1).some((l) => l.trim() && !META_LINE.test(l.trim()));
}

function chunkDocument(fileName, text) {
  const { preamble, sections } = parse(text);
  const docContext = buildDocContext(fileName, preamble);

  // 1) 실제 본문을 가진 말단 섹션 목록 만들기
  const leaves = [];
  for (const l1 of sections) {
    if (l1.children.length === 0) {
      leaves.push({ l1, parts: [{ heading: l1.heading, body: joinBody(l1.body) }] });
    } else {
      for (const child of l1.children) {
        leaves.push({ l1, parts: [{ heading: child.heading, body: joinBody(child.body) }] });
      }
    }
  }

  // 2) 본문이 짧은 섹션은 같은 장의 앞 섹션(없으면 뒤 섹션)에 합치기
  const merged = [];
  let carry = null;
  for (const leaf of leaves) {
    if (carry && carry.l1 === leaf.l1) {
      leaf.parts.unshift(...carry.parts);
      carry = null;
    }
    const isShort = leaf.parts.every((p) => p.body.length < MIN_BODY);
    const prev = merged[merged.length - 1];
    if (isShort && prev && prev.l1 === leaf.l1) {
      prev.parts.push(...leaf.parts);
    } else if (isShort && leaves.some((l) => l !== leaf && l.l1 === leaf.l1 && leaves.indexOf(l) > leaves.indexOf(leaf))) {
      carry = leaf;
    } else {
      merged.push(leaf);
    }
  }

  // 3) Chunk 텍스트 구성: 문서 정보 + 상위 장 제목/본문 + 섹션 제목/본문
  const chunks = [];
  const mergePreamble = preamble && !preambleHasProse(preamble);
  if (preamble && !mergePreamble) {
    chunks.push({ section: "머리말", content: preamble });
  }

  merged.forEach((leaf, i) => {
    const blocks = [];
    blocks.push(mergePreamble && i === 0 ? preamble : docContext);

    const hasChildren = leaf.l1.children.length > 0;
    if (hasChildren) {
      const l1Body = joinBody(leaf.l1.body);
      blocks.push(l1Body ? `${leaf.l1.heading}\n${l1Body}` : leaf.l1.heading);
    }
    for (const p of leaf.parts) blocks.push(p.body ? `${p.heading}\n${p.body}` : p.heading);

    const section = [hasChildren ? leaf.l1.heading : null, leaf.parts.map((p) => p.heading).join(" + ")]
      .filter(Boolean)
      .join(" > ");
    chunks.push({ section, content: blocks.join("\n\n") });
  });

  return chunks;
}

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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name   TEXT    NOT NULL,
      chunk_index INTEGER NOT NULL,
      section     TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      embedding   TEXT    NOT NULL,  -- JSON 배열 문자열
      dims        INTEGER NOT NULL,
      model       TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX idx_chunks_file ON chunks(file_name);
  `);
  return db;
}

async function main() {
  // 1. Chunking
  const allChunks = [];
  for (const fileName of FILES) {
    const text = fs.readFileSync(path.join(DOCS_DIR, fileName), "utf8").replace(/\r\n/g, "\n");
    const chunks = chunkDocument(fileName, text);
    chunks.forEach((c, i) => allChunks.push({ fileName, chunkIndex: i, ...c }));
    console.log(`${fileName}: ${chunks.length}개 Chunk`);
    chunks.forEach((c, i) => console.log(`  #${i} (${c.content.length}자) ${c.section}`));
  }
  console.log(`\n총 ${allChunks.length}개 Chunk\n`);

  // 2. Embedding (BATCH_SIZE씩 나눠서 요청)
  let model = null;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const data = await embed(batch.map((c) => c.content));
    model = data.model;
    batch.forEach((c, j) => (c.embedding = data.embeddings[j]));
    console.log(`Embedding ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length} 완료`);
  }

  // 3. SQLite 저장
  const db = openDb();
  const insert = db.prepare(
    "INSERT INTO chunks (file_name, chunk_index, section, content, embedding, dims, model) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  for (const c of allChunks) {
    insert.run(c.fileName, c.chunkIndex, c.section, c.content, JSON.stringify(c.embedding), c.embedding.length, model);
  }
  db.exec("COMMIT");

  const rows = db.prepare("SELECT file_name, COUNT(*) AS n, MIN(dims) AS dims FROM chunks GROUP BY file_name").all();
  console.log(`\n저장 완료: ${DB_PATH} (모델: ${model})`);
  console.table(rows);
  db.close();
}

main().catch((err) => {
  console.error("오류:", err.message);
  process.exit(1);
});
