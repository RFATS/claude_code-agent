# Airflow fail 대응 Agent 팀 (Head Agent)

## WHY
- 운영 Airflow DAG run fail 알림 1건마다 진성/가성을 판별하고, 진성이면 원인 분석·수정 코드·검증까지 마쳐 fail 대응 리포트 1개를 만든다. (SSD/eStorage 양산 테스트 데이터, 약식 실습)

## WHAT
- 입력: `data/alerts.txt`, `data/logs/`, `data/dags/`, `data/essd_ft_results_*.csv`, `data/past_cases.csv`(RAG: `rag/`)
- Sub Agent(`.claude/agents/`): `fail-classifier`(판별) · `root-cause-analyst`(원인·영향 범위) · `code-fixer`(수정 코드) · `report-writer`(리포트, `fail-report` Skill)
- 코드: `scripts/01_parse_alerts.py` · `scripts/02_search_similar.js` · `scripts/06_verify_fix.py`
- 결과: `output/alert-NN/report.html` (알림 1건당 1개, 중간 산출물도 같은 폴더)

## HOW
- 흐름은 `workflow.md`를 따른다. 알림마다 1(파싱)→2(RAG)→3 `fail-classifier` 순으로 진행한다.
- **Router**: 3단계 판별이 진성이면 4→5→6→7, 가성이면 바로 7(판별 섹션만)로 보낸다.
- 8단계(승인/불승인)는 사람이 한다. 리포트를 "승인 대기"로 두고 멈춘다.
- 공통 규칙
  - 원본 `data/`는 수정하지 않는다. 수정본은 `output/`에만 만든다.
  - 근거 없는 사실·수치를 쓰지 않는다. 확인하지 못한 것은 "확인 불가"로 남긴다.
  - 승인된 과거 사례는 적극 참고하고, 불승인 사례는 사유를 읽고 같은 방식을 피한다.
  - 승인/불승인 결정과 이력 기록은 사람의 확인 후에만 한다.
