// Task 2: 유사 과거 사례 검색 (RAG)
// output/alert-NN/context.json으로 검색어를 만들고, rag/search-rag.js로 승인 사례·불승인 사례를 각각 검색해
// output/alert-NN/similar_cases.json으로 저장한다.
// 사용법: node scripts/02_search_similar.js [--top 3]
const fs = require("fs");
const path = require("path");
const { search } = require("../rag/search-rag");

const OUT = path.join(__dirname, "..", "output");
const topArg = process.argv.indexOf("--top");
const TOP_K = topArg > -1 ? Number(process.argv[topArg + 1]) || 3 : 3;

function buildQuery(ctx) {
  const outcome = ctx.retry_succeeded ? "재시도 성공" : ctx.final_outcome === "FAILED" ? "재시도 모두 실패" : "";
  return [
    `${ctx.dag_id} ${ctx.task_id}`,
    `에러 유형: ${ctx.error_type}`,
    `에러 메시지: ${ctx.error_message}`,
    outcome,
    ctx.error_location ? `위치: ${ctx.error_location.function} ${ctx.error_location.code}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const dirs = fs.readdirSync(OUT).filter((d) => /^alert-\d+$/.test(d)).sort();
  for (const d of dirs) {
    const ctx = JSON.parse(fs.readFileSync(path.join(OUT, d, "context.json"), "utf8"));
    const query = buildQuery(ctx);
    const [approved, rejected] = await Promise.all([
      search(query, { topK: TOP_K, decision: "승인" }),
      search(query, { topK: TOP_K, decision: "불승인" }),
    ]);
    const slim = (r) => ({
      case_id: r.caseId,
      similarity: r.similarity,
      date: r.date,
      dag_id: r.dagId,
      task_id: r.taskId,
      error_type: r.errorType,
      judgment: r.judgment,
      decision: r.decision,
      content: r.content,
    });
    const result = { alert_id: ctx.alert_id, query, approved: approved.map(slim), rejected: rejected.map(slim) };
    fs.writeFileSync(path.join(OUT, d, "similar_cases.json"), JSON.stringify(result, null, 2), "utf8");
    console.log(
      `${d}: 승인 ${approved.map((r) => `${r.caseId}(${r.similarity})`).join(", ")} | 불승인 ${rejected.map((r) => `${r.caseId}(${r.similarity})`).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error("오류:", err.message);
  process.exit(1);
});
