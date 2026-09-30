// 임베딩 API 호출 테스트 (코사인 유사도 포함)
// 사용법: node scripts/test-embedding.js ["임베딩할 문장" ...]
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env");
const API_URL = "https://defect-rag-embedding-api.vercel.app/api/embed";

try {
  process.loadEnvFile(ENV_PATH); // Node 20.12+ 내장 .env 로더
} catch (err) {
  console.error(`.env 파일을 읽을 수 없습니다: ${ENV_PATH}`);
  process.exit(1);
}

const apiKey = process.env.EMBED_API_KEY;
if (!apiKey) {
  console.error("EMBED_API_KEY가 .env에 설정되어 있지 않습니다.");
  process.exit(1);
}

const texts = process.argv.slice(2);
if (texts.length === 0) {
  texts.push(
    "웨이퍼 표면에 스크래치 결함이 발견되었습니다.",
    "웨이퍼 표면에서 긁힘 불량이 검출되었습니다.",
    "Particle contamination on the wafer edge",
    "오늘 점심 메뉴는 김치찌개입니다."
  );
}

async function main() {
  console.log(`POST ${API_URL}`);
  console.log(`입력 문장 ${texts.length}개:`, texts);

  const started = Date.now();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ texts }),
  });
  const elapsed = Date.now() - started;

  const body = await res.text();
  if (!res.ok) {
    console.error(`요청 실패 (HTTP ${res.status}, ${elapsed}ms):`, body);
    process.exit(1);
  }

  const { model, dims, embeddings } = JSON.parse(body);
  console.log(`\n성공 (HTTP ${res.status}, ${elapsed}ms)`);
  console.log(`모델: ${model}`);
  console.log(`차원: ${dims}`);
  console.log(`임베딩 개수: ${embeddings.length}`);

  embeddings.forEach((vec, i) => {
    const preview = vec.slice(0, 5).map((v) => v.toFixed(4)).join(", ");
    console.log(`  [${i}] "${texts[i]}" → 길이 ${vec.length}, [${preview}, ...]`);
  });

  if (embeddings.length >= 2) {
    console.log("\n코사인 유사도 (모든 쌍):");
    for (let i = 0; i < embeddings.length; i++) {
      for (let j = i + 1; j < embeddings.length; j++) {
        const sim = cosine(embeddings[i], embeddings[j]);
        console.log(`  [${i}] ↔ [${j}]: ${sim.toFixed(4)}`);
      }
    }
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

main().catch((err) => {
  console.error("오류:", err.message);
  process.exit(1);
});
