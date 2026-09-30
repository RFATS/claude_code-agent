// 설비 운영 매뉴얼을 3가지 방식으로 Chunking하고 비교 HTML을 생성
// 사용법: node scripts/test-chunking.js [입력 파일 경로]
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INPUT_PATH = process.argv[2] || path.join(ROOT, "documents", "설비운영매뉴얼_통합본.txt");
const OUTPUT_PATH = path.join(ROOT, "output", "chunking-comparison.html");
const FIXED_SIZE = 300;

const CHAPTER_RULE = /^=+$/;                // ===== 구분선
const CHAPTER_TITLE = /^제\d+장\s/;          // 제1장 ...
const SECTION_TITLE = /^\d+\.\d+\s/;         // 1.1 ...

// 1. 고정 길이: 문맥과 무관하게 FIXED_SIZE 글자씩 자르기
function chunkByFixedLength(text, size = FIXED_SIZE) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    const content = text.slice(i, i + size);
    // 앞뒤가 모두 공백이 아닌 글자면 단어/문장 중간에서 잘린 것
    const cutMid = i + size < text.length && /\S/.test(text[i + size - 1]) && /\S/.test(text[i + size]);
    chunks.push({ content, cutMid });
  }
  return chunks;
}

// 2. 구조 경계: 장 제목(제N장)과 소제목(N.N)을 기준으로 나누기
function chunkByStructure(text) {
  const chunks = [];
  let chapter = null;
  let current = { title: "머리말", chapter: null, lines: [] };

  const flush = () => {
    const content = current.lines.join("\n").trim();
    if (content) chunks.push({ title: current.title, chapter: current.chapter, content });
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (CHAPTER_RULE.test(trimmed)) continue;

    if (CHAPTER_TITLE.test(trimmed)) {
      flush();
      chapter = trimmed;
      current = { title: trimmed, chapter: null, lines: [line] };
    } else if (SECTION_TITLE.test(trimmed)) {
      flush();
      current = { title: trimmed, chapter, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return chunks;
}

// 3. 문단: 빈 줄로 구분된 덩어리 단위로 나누기
function chunkByParagraph(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((content) => ({ content }));
}

function stats(chunks) {
  const lengths = chunks.map((c) => c.content.length);
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    count: chunks.length,
    min: Math.min(...lengths),
    max: Math.max(...lengths),
    avg: Math.round(total / chunks.length),
  };
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderChunk(chunk, i, method) {
  const tags = [];
  if (method === "structure") {
    if (chunk.chapter) tags.push(`<span class="tag">${escapeHtml(chunk.chapter.replace(/\s—.*/, ""))}</span>`);
    tags.push(`<span class="tag tag-accent">${escapeHtml(chunk.title)}</span>`);
  }
  if (method === "fixed" && chunk.cutMid) tags.push(`<span class="tag tag-warn">단어 중간 잘림</span>`);

  return `
        <article class="chunk">
          <header class="chunk-head">
            <span class="chunk-no">#${i + 1}</span>
            <span class="chunk-len">${chunk.content.length}자</span>
          </header>
          ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
          <pre>${escapeHtml(chunk.content)}</pre>
        </article>`;
}

function renderHtml(sourceName, results) {
  const summaryRows = results
    .map(
      (r) => `
        <tr>
          <th scope="row">${r.label}</th>
          <td class="num strong">${r.stats.count}</td>
          <td class="num">${r.stats.avg}</td>
          <td class="num">${r.stats.min}</td>
          <td class="num">${r.stats.max}</td>
        </tr>`
    )
    .join("");

  const columns = results
    .map(
      (r) => `
      <section class="col" id="${r.key}">
        <header class="col-head">
          <h2>${r.label}</h2>
          <p>${r.desc}</p>
          <p class="col-count">${r.stats.count}개 · 평균 ${r.stats.avg}자</p>
        </header>
        <div class="chunks">${r.chunks.map((c, i) => renderChunk(c, i, r.key)).join("")}
        </div>
      </section>`
    )
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chunking 방식 비교</title>
<style>
  :root {
    --bg: #f6f5f2; --surface: #ffffff; --surface-2: #f0efeb; --border: #e2e0da;
    --text: #1d1c1a; --muted: #6b6862; --accent: #2f5bd3; --accent-bg: #e8eefc;
    --warn: #a4520b; --warn-bg: #fbeede;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #161615; --surface: #1f1f1d; --surface-2: #282826; --border: #353431;
      --text: #ecebe7; --muted: #a09d96; --accent: #8aa8f5; --accent-bg: #23304f;
      --warn: #f0b27a; --warn-bg: #3d2b1a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #161615; --surface: #1f1f1d; --surface-2: #282826; --border: #353431;
    --text: #ecebe7; --muted: #a09d96; --accent: #8aa8f5; --accent-bg: #23304f;
    --warn: #f0b27a; --warn-bg: #3d2b1a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.6 "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif;
  }
  main { max-width: 1400px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; margin-bottom: 32px;
          background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 14px; border-bottom: 1px solid var(--border); text-align: left; }
  thead th { font-size: 13px; color: var(--muted); font-weight: 600; background: var(--surface-2); }
  tbody tr:last-child > * { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .strong { font-weight: 700; color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; align-items: start; }
  .col { min-width: 0; }
  .col-head { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 8px 0 12px; }
  .col-head h2 { font-size: 18px; margin: 0; }
  .col-head p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .col-head .col-count { color: var(--text); font-weight: 600; }
  .chunks { display: flex; flex-direction: column; gap: 10px; }
  .chunk { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .chunk-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .chunk-no { font-weight: 700; color: var(--text); }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
  .tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); color: var(--muted); }
  .tag-accent { background: var(--accent-bg); color: var(--accent); }
  .tag-warn { background: var(--warn-bg); color: var(--warn); }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: 13px/1.6 inherit;
        font-family: inherit; background: var(--surface-2); border-radius: 6px; padding: 8px 10px; }
</style>
</head>
<body>
<main>
  <h1>Chunking 방식 비교</h1>
  <p class="sub">원본: ${escapeHtml(sourceName)}</p>
  <table>
    <thead><tr><th>방식</th><th class="num">Chunk 수</th><th class="num">평균 길이</th><th class="num">최소</th><th class="num">최대</th></tr></thead>
    <tbody>${summaryRows}
    </tbody>
  </table>
  <div class="grid">${columns}
  </div>
</main>
</body>
</html>
`;
}

function main() {
  const text = fs.readFileSync(INPUT_PATH, "utf8").replace(/\r\n/g, "\n");

  const results = [
    { key: "fixed", label: "1. 고정 길이", desc: `${FIXED_SIZE}자씩 기계적으로 자름`, chunks: chunkByFixedLength(text) },
    { key: "structure", label: "2. 구조 경계", desc: "장 제목(제N장) · 소제목(N.N) 기준", chunks: chunkByStructure(text) },
    { key: "paragraph", label: "3. 문단", desc: "빈 줄로 구분된 문단 기준", chunks: chunkByParagraph(text) },
  ];
  results.forEach((r) => (r.stats = stats(r.chunks)));

  console.log(`입력: ${INPUT_PATH} (${text.length}자)\n`);
  for (const r of results) {
    const s = r.stats;
    console.log(`${r.label.padEnd(8)} Chunk ${String(s.count).padStart(3)}개 | 평균 ${s.avg}자, 최소 ${s.min}자, 최대 ${s.max}자`);
  }
  const cutCount = results[0].chunks.filter((c) => c.cutMid).length;
  console.log(`\n고정 길이 방식에서 단어 중간이 잘린 경계: ${cutCount}곳`);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, renderHtml(path.basename(INPUT_PATH), results), "utf8");
  console.log(`\nHTML 저장: ${OUTPUT_PATH}`);
}

main();
