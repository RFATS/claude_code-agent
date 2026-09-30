"""essd_ft_result_etl DAG에서 사용하는 eSSD FT(Final Test) 결과 변환 로직."""
import csv
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

VALID_RESULT = {"PASS", "FAIL", "ABORT"}
# 테스터가 측정값을 출력하지 못했을 때 쓰는 결측 표기와, 이를 NULL로 허용하는 result.
# ABORT 이외 result의 결측 표기는 여전히 오류로 드러나도록 허용 대상을 ABORT로 한정한다.
MISSING_MARKER = "NA"
NULLABLE_RESULTS = {"ABORT"}
METRIC_FIELDS = ["read_bw_mbps", "write_bw_mbps", "read_p99_lat_us", "temp_c"]
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

    allow_missing=True일 때만 결측 표기(MISSING_MARKER)를 None(NULL)으로 변환한다.
    그 외 변환 불가 값은 기존처럼 ValueError를 그대로 발생시킨다.
    """
    if allow_missing and value == MISSING_MARKER:
        return None
    return float(value)


def parse_test_date(value):
    return datetime.strptime(value, "%Y-%m-%d").date()


def transform_ft_results(input_path, output_path):
    """테스터가 내보낸 FT 결과 CSV를 읽어 측정값을 숫자로 변환해 저장한다.

    ABORT 행의 측정값이 결측 표기(NA)이면 0으로 채우지 않고 NULL(빈 값)로 저장한다.
    """
    rows = []
    with open(input_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["result"] not in VALID_RESULT:
                raise ValueError(f"unknown result: {row['result']}")
            allow_missing = row["result"] in NULLABLE_RESULTS
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

    null_rows = sum(1 for r in rows if any(r[k] is None for k in METRIC_FIELDS))
    if null_rows:
        logger.warning("%d ABORT rows have missing metrics (NA); stored as NULL", null_rows)

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)
