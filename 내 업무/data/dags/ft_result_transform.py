"""essd_ft_result_etl DAG에서 사용하는 eSSD FT(Final Test) 결과 변환 로직."""
import csv
from datetime import datetime

VALID_RESULT = {"PASS", "FAIL", "ABORT"}
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


def parse_metric(value):
    """테스트 측정값 문자열을 float로 변환한다."""
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
            rows.append(
                {
                    "lot_id": row["lot_id"],
                    "drive_sn": row["drive_sn"],
                    "product_code": row["product_code"],
                    "tester_id": row["tester_id"],
                    "test_date": parse_test_date(row["test_date"]).isoformat(),
                    "result": row["result"],
                    "bin_code": row["bin_code"],
                    "read_bw_mbps": parse_metric(row["read_bw_mbps"]),
                    "write_bw_mbps": parse_metric(row["write_bw_mbps"]),
                    "read_p99_lat_us": parse_metric(row["read_p99_lat_us"]),
                    "temp_c": parse_metric(row["temp_c"]),
                }
            )

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)
