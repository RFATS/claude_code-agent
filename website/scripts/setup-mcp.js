// real-estate-mcp(tae0y) 를 vendor/ 에 내려받고 의존성을 설치한다. 외부 코드를 받으므로 --yes 를 줘야 실행한다.
//   node scripts/setup-mcp.js          → 하려는 작업만 출력
//   node scripts/setup-mcp.js --yes    → 실행
// 고정 커밋: 조사 시점(2026-07-18)에 소스로 검증한 커밋. 저장소가 CLI 전환/폐기를 논의 중이라 최신이 아닌 검증본에 고정한다.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = "https://github.com/tae0y/real-estate-mcp.git";
const PIN = process.env.MCP_PIN || "1119eb1069d1b1bae15f7b38c6c0268fe07995c0"; // 태그 v0.1.0 도 사용 가능
const DIR = path.resolve(__dirname, "..", process.env.MCP_DIR || "vendor/real-estate-mcp");
const yes = process.argv.includes("--yes");

const steps = [
  ["git", ["clone", REPO, DIR]],
  ["git", ["-C", DIR, "checkout", PIN]],
  ["uv", ["sync", "--directory", DIR]], // 첫 실행 지연(.venv·Python 3.12 다운로드)을 미리 치른다
];

if (fs.existsSync(DIR)) {
  console.log(`이미 있습니다: ${DIR}\n다시 받으려면 폴더를 지우고 실행하세요.`);
  process.exit(0);
}
console.log("실행할 작업:");
for (const [cmd, args] of steps) console.log(`  ${cmd} ${args.join(" ")}`);
if (!yes) {
  console.log("\n외부 저장소를 내려받고 파이썬 의존성을 설치합니다. 진행하려면 --yes 를 붙여 다시 실행하세요.");
  process.exit(0);
}

for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`실패: ${cmd} ${args.join(" ")} (종료 코드 ${r.status})`);
    process.exit(1);
  }
}
const tool = path.join(DIR, "src", "real_estate", "mcp_server", "tools", "trade.py");
if (!fs.existsSync(tool)) {
  console.error(`검증 실패: ${tool} 가 없습니다. 고정 커밋(${PIN})의 구조가 조사 때와 다릅니다.`);
  process.exit(1);
}
console.log(`\n완료: ${DIR}\n다음: .env 에 DATA_GO_KR_API_KEY 를 넣고 node scripts/probe.js 를 실행하세요.`);
