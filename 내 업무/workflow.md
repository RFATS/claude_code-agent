# Workflow

업무설계서.md의 8개 Task를 Router 패턴으로 연결한 전체 흐름입니다. 알림 1건마다 아래 흐름을 한 번 실행합니다.

## Task 목록

| 단계 | Task | 실행 주체 | Sub Agent / 실행 수단 |
|---|---|---|---|
| 1 | 알림 메시지 분리 및 Task 로그 매칭·파싱 | 코드 | `scripts/01_parse_alerts.py` |
| 2 | 유사 과거 사례 검색 (승인/불승인 구분) | 코드 (RAG) | `scripts/02_search_similar.js` (`rag/search-rag.js` 사용) |
| 3 | 진성/가성 판별 및 판별 근거 작성 | AI | `fail-classifier` |
| 4 | 진성 fail 원인 분석 및 영향 범위 파악 | AI | `root-cause-analyst` |
| 5 | 수정 코드 작성 | AI | `code-fixer` |
| 6 | 수정 코드 검증 실행 | 코드 | `scripts/06_verify_fix.py` |
| 7 | 알림별 fail 대응 리포트 작성 | AI (Skill) | `report-writer` + `.claude/skills/fail-report` |
| 8 | 리포트 검토 및 승인/불승인 결정 | 사람 | 담당자 (Head Agent는 승인 대기까지만 진행) |

## 적용한 패턴

- **Router**: 3단계 `fail-classifier`의 판단 결과(진성 / 가성)에 따라 다음 경로를 선택합니다.
  - 진성 → 4 → 5 → 6 → 7(전체 섹션) → 8
  - 가성 → 7(판별 섹션만, 나머지는 "해당 없음") → 8
- Parallel, Gen-Eval은 적용하지 않습니다.

## 실행 흐름

```
알림 1건 (alerts.txt + logs/)
        │
        ▼
[1] 알림·로그 파싱                 (코드)
        │
        ▼
[2] 유사 과거 사례 검색 (RAG)       (코드)   승인 사례 / 불승인 사례
        │
        ▼
[3] 진성/가성 판별                 (AI: fail-classifier)
        │
   ┌────┴─────────────┐
 진성                가성   ◄── Router (판별 결과)
   │                  │
   ▼                  │
[4] 원인 분석·영향 범위 (AI: root-cause-analyst)
   │                  │
   ▼                  │
[5] 수정 코드 작성      (AI: code-fixer)
   │                  │
   ▼                  │
[6] 수정 코드 검증      (코드)
   │                  │
   ▼                  ▼
[7] 리포트 작성 (AI: report-writer + fail-report Skill)
    진성: 전체 섹션 / 가성: 판별 섹션만
        │
        ▼
[8] 리포트 검토 및 승인/불승인 (사람)
        │
        ▼
   결정과 사유를 과거 사례 이력에 기록
```

## 산출물 위치

- 작업 중간 파일: `output/alert-NN/` (context.json, similar_cases.json, classification.json 등)
- 최종 리포트: `output/alert-NN/report.html` (알림 1건당 1개)
