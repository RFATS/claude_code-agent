"""Task 6: 수정 코드 검증 실행.

fail 기간 샘플 데이터(data/essd_ft_results_*.csv)를 일자별로 나눠 원본 코드와 수정 코드를 로컬에서 각각 실행하고,
수정 전/후 결과를 비교해 output/alert-NN/verification.json으로 저장한다.

사용법: python scripts/06_verify_fix.py alert-02
"""
import csv
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = ROOT / "data" / "essd_ft_results_20260926_20260928.csv"
METRICS = ["read_bw_mbps", "write_bw_mbps", "read_p99_lat_us", "temp_c"]
CONTROL_DATE = "2026-09-26"  # fail이 없던 정상 일자


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def run(mod, func_name, rows, tmp, tag):
    """일자별 입력 CSV를 만들어 변환 함수를 실행한다. (성공 여부, 출력 행, 오류 문구) 반환."""
    src, dst = Path(tmp) / f"in_{tag}.csv", Path(tmp) / f"out_{tag}.csv"
    with open(src, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    try:
        getattr(mod, func_name)(str(src), str(dst))
    except Exception as e:  # 원본 코드의 실패도 결과로 기록한다
        return False, [], f"{type(e).__name__}: {e}"
    return True, read_csv(dst), None


def main(alert_id):
    out_dir = ROOT / "output" / alert_id
    ctx = json.loads((out_dir / "context.json").read_text(encoding="utf-8"))
    fix = json.loads((out_dir / "fix_summary.json").read_text(encoding="utf-8"))
    file_name = fix["changed_file"]
    func = "transform_ft_results"

    orig = load_module(ROOT / "data" / "dags" / file_name, "orig_mod")
    fixed = load_module(out_dir / "fixed" / file_name, "fixed_mod")
    sample = read_csv(SAMPLE)
    dates = sorted({r["test_date"] for r in sample})

    per_date, checks = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for d in dates:
            rows = [r for r in sample if r["test_date"] == d]
            ok_o, out_o, err_o = run(orig, func, rows, tmp, f"o_{d}")
            ok_f, out_f, err_f = run(fixed, func, rows, tmp, f"f_{d}")
            per_date.append({
                "date": d,
                "input_rows": len(rows),
                "abort_rows": sum(1 for r in rows if r["result"] == "ABORT"),
                "before": {"success": ok_o, "output_rows": len(out_o), "error": err_o},
                "after": {"success": ok_f, "output_rows": len(out_f), "error": err_f},
            })
            checks.append({"name": f"{d}: 수정 코드가 오류 없이 완료", "pass": ok_f})
            if ok_f:
                checks.append({"name": f"{d}: 입력 행 수와 출력 행 수 일치(행 누락 없음)", "pass": len(out_f) == len(rows)})
                # 결측(NA 등)이 0으로 바뀌지 않았는지
                zero_filled = 0
                for src_row, out_row in zip(rows, out_f):
                    for m in METRICS:
                        if src_row[m].strip().upper() in ("NA", "N/A", "-", "") and out_row[m].strip() not in ("", "None", "nan"):
                            zero_filled += 1
                checks.append({"name": f"{d}: 결측 측정값이 임의 값(0 등)으로 대체되지 않음", "pass": zero_filled == 0})
                # 결측이 없는 행의 값이 입력과 같은지
                mismatch = 0
                for src_row, out_row in zip(rows, out_f):
                    if all(src_row[m].strip().upper() not in ("NA", "N/A", "-", "") for m in METRICS):
                        for m in METRICS:
                            if abs(float(src_row[m]) - float(out_row[m])) > 1e-9:
                                mismatch += 1
                checks.append({"name": f"{d}: 정상 측정값이 입력과 동일", "pass": mismatch == 0})
            if d == CONTROL_DATE:
                checks.append({"name": f"{d}(정상 일자): 수정 전/후 결과 동일", "pass": ok_o and ok_f and out_o == out_f})
            else:
                checks.append({"name": f"{d}: 수정 전 코드에서 fail 재현", "pass": not ok_o})

    result = {
        "alert_id": alert_id,
        "dag_id": ctx["dag_id"],
        "task_id": ctx["task_id"],
        "changed_file": file_name,
        "sample_file": str(SAMPLE.relative_to(ROOT)).replace("\\", "/"),
        "per_date": per_date,
        "checks": checks,
        "passed": sum(1 for c in checks if c["pass"]),
        "total": len(checks),
        "overall": "PASS" if all(c["pass"] for c in checks) else "FAIL",
    }
    (out_dir / "verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{alert_id}: {result['overall']} ({result['passed']}/{result['total']})")
    for c in checks:
        print(("  [PASS] " if c["pass"] else "  [FAIL] ") + c["name"])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("사용법: python scripts/06_verify_fix.py alert-NN")
    main(sys.argv[1])
