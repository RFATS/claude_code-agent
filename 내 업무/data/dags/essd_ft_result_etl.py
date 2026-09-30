"""eSSD 양산 FT(Final Test) 결과를 수집·변환·적재하는 DAG (가상 예시)."""
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator

from ft_result_transform import transform_ft_results

default_args = {
    "owner": "solution-pe",
    "retries": 2,
    "retry_delay": timedelta(minutes=5),
}


def collect_tester_results(ds, **_):
    """테스터 로그 서버에서 해당 일자 FT 결과 CSV를 내려받는다."""
    print(f"download FT results for {ds} -> /data/raw/ft_results_{ds}.csv")


def run_transform(ds, **_):
    count = transform_ft_results(f"/data/raw/ft_results_{ds}.csv", f"/data/stage/ft_results_{ds}.csv")
    print(f"transformed {count} rows")


def load_to_dw(ds, **_):
    """변환된 CSV를 양산 테스트 DW(dw.mfg.ft_result)에 적재한다."""
    print(f"load /data/stage/ft_results_{ds}.csv -> dw.mfg.ft_result")


with DAG(
    dag_id="essd_ft_result_etl",
    start_date=datetime(2026, 1, 1),
    schedule="0 2 * * *",
    catchup=False,
    default_args=default_args,
) as dag:
    collect = PythonOperator(task_id="collect_tester_results", python_callable=collect_tester_results)
    transform = PythonOperator(task_id="transform_ft_results", python_callable=run_transform)
    load = PythonOperator(task_id="load_to_dw", python_callable=load_to_dw)

    collect >> transform >> load
