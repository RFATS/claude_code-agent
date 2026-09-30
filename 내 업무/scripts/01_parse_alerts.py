"""Task 1: 알림 메시지 분리 및 Task 로그 매칭·파싱.

data/alerts.txt를 알림 1건씩 나누고, 각 알림에 연결된 Task 로그(data/logs/*.txt)를 읽어
output/alert-NN/context.json으로 저장한다.

사용법: python scripts/01_parse_alerts.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALERTS = ROOT / "data" / "alerts.txt"
DATA = ROOT / "data"
OUT = ROOT / "output"

HEADER = re.compile(r"^(DAG|Task|Logical date|Failed at|Try|Log):\s*(.*)$")
ATTEMPT = re.compile(r"Starting attempt (\d+) of (\d+)")
TS = re.compile(r"^\[(\d{4}-\d{2}-\d{2}, \d{2}:\d{2}:\d{2}) KST\]")
MARK = re.compile(r"Marking task as (\w+)")
FRAME = re.compile(r'File "([^"]+)", line (\d+), in (\S+)')
EXC = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception|Detected|Timeout)\w*):\s*(.*)$")


def parse_alert_blocks(text):
    blocks = [b for b in re.split(r"\n-{10,}\n", text) if b.strip()]
    alerts = []
    for block in blocks:
        fields = {}
        for line in block.splitlines():
            m = HEADER.match(line.strip())
            if m:
                fields[m.group(1)] = m.group(2).strip()
        alerts.append(fields)
    return alerts


def parse_log(path):
    attempts = []
    current = None
    frames = []
    for line in path.read_text(encoding="utf-8").splitlines():
        m = ATTEMPT.search(line)
        if m:
            current = {"attempt": int(m.group(1)), "max": int(m.group(2)), "outcome": None,
                       "error_type": None, "error_message": None, "started_at": TS.match(line).group(1)}
            attempts.append(current)
            frames = []
            continue
        if current is None:
            continue
        f = FRAME.search(line)
        if f:
            frames.append({"file": f.group(1), "line": int(f.group(2)), "function": f.group(3), "code": None})
            continue
        if frames and frames[-1]["code"] is None and line.startswith("    "):
            frames[-1]["code"] = line.strip()
            continue
        e = EXC.match(line)
        if e:
            current["error_type"], current["error_message"] = e.group(1), e.group(2)
            current["frames"] = list(frames)
            continue
        mk = MARK.search(line)
        if mk:
            current["outcome"] = mk.group(1)
    return attempts


def main():
    alerts = parse_alert_blocks(ALERTS.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    for i, a in enumerate(alerts, 1):
        alert_id = f"alert-{i:02d}"
        log_rel = re.search(r"\(([^)]+\.txt)\)", a.get("Log", "")).group(1)
        attempts = parse_log(DATA / log_rel)
        last = attempts[-1]
        first_err = next(x for x in attempts if x["error_type"])
        frames = first_err.get("frames", [])
        location = frames[-1] if frames else None
        dag_id = a["DAG"]
        src = None
        if location:
            cand = DATA / "dags" / Path(location["file"]).name
            src = str(cand.relative_to(ROOT)).replace("\\", "/") if cand.exists() else None
        ctx = {
            "alert_id": alert_id,
            "dag_id": dag_id,
            "task_id": a["Task"],
            "logical_date": a["Logical date"],
            "failed_at": a["Failed at"],
            "try": a["Try"],
            "log_file": "data/" + log_rel,
            "attempts": [{k: v for k, v in x.items() if k != "frames"} for x in attempts],
            "attempt_count": len(attempts),
            "final_outcome": last["outcome"],
            "retry_succeeded": last["outcome"] == "SUCCESS" and len(attempts) > 1,
            "error_type": first_err["error_type"],
            "error_message": first_err["error_message"],
            "same_error_every_attempt": all(x["error_type"] for x in attempts)
            and len({(x["error_type"], x["error_message"]) for x in attempts}) == 1,
            "error_location": location,
            "dag_stack": [f"{f['file']}:{f['line']} {f['function']}" for f in frames],
            "source_file": src,
        }
        d = OUT / alert_id
        d.mkdir(exist_ok=True)
        (d / "context.json").write_text(json.dumps(ctx, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{alert_id}: {dag_id}/{a['Task']} attempts={len(attempts)} final={last['outcome']} error={first_err['error_type']}")


if __name__ == "__main__":
    main()
