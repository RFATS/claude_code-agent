"""essd_ft_result_etl DAG에서 사용하는 eSSD FT(Final Test) 결과 변환 로직."""
import csv
from datetime import datetime

VALID_RESULT = {"PASS", "FAIL", "ABORT"}
# ABORT 드라이브는 측정값을 출력하지 못해 결측 표기 'NA'로 내보낸다.
MISSING_MARKERS = {"NA"}
OUT_FIELDS = [
    "lot_id",
    "drive_sn",
    "product_code",
    "tester_id",
    "test_date",
    "result",
    "bin_code",
    "read_bw_mbps",
    "write_bw_mbps",
    "read_p99_lat_us",
    "temp_c",
]


def parse_metric(value, allow_missing=False):
    """테스트 측정값 문자열을 float로 변환한다.

    allow_missing=True(ABORT 행)일 때만 결측 표기('NA')를 None(NULL)으로 반환한다.
    그 외의 비수치 값은 기존과 같이 ValueError를 발생시킨다.
    """
    if allow_missing and value.strip() in MISSING_MARKERS:
        return None
    return float(value)


def parse_test_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def transform_ft_results(input_path, output_path):
    """테스터가 내보낸 FT 결과 CSV를 읽어 측정값을 숫자로 변환해 저장한다."""
    rows = []
    with open(input_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["result"] not in VALID_RESULT:
                raise ValueError(f"unknown result: {row['result']}")
            # 결측(NA)은 ABORT 행에서만 NULL로 허용한다. PASS/FAIL의 결측은 계속 오류.
            allow_missing = row["result"] == "ABORT"
            rows.append(
                {
                    "lot_id": row["lot_id"],
                    "drive_sn": row["drive_sn"],
                    "product_code": row["product_code"],
                    "tester_id": row["tester_id"],
                    "test_date": parse_test_date(row["test_date"]).isoformat(),
                    "result": row["result"],
                    "bin_code": row["bin_code"],
                    "read_bw_mbps": parse_metric(row["read_bw_mbps"], allow_missing),
                    "write_bw_mbps": parse_metric(row["write_bw_mbps"], allow_missing),
                    "read_p99_lat_us": parse_metric(row["read_p99_lat_us"], allow_missing),
                    "temp_c": parse_metric(row["temp_c"], allow_missing),
                }
            )

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)
