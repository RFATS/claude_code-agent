// 실시간 소스 — MCP 툴 get_apartment_trades 로 (시군구, 월) 한 건을 조회해 정규화한다.
// 같은 인터페이스(fetchMonth)를 sample-source.js 도 구현하므로 교체가 쉽다.
"use strict";

const FIRST_ROWS = 3000; // 한 달 거래가 이보다 많으면 한 번 더 키워서 재호출
const MAX_ROWS = 9999; // 실제 상한은 키 발급 후 scripts/probe.js 로 확인해 조정

// 오류 종류: quota(일일한도) | auth(키 문제) | transient(일시적) | fatal
function toError(kind, message, code) {
  const e = new Error(message);
  e.kind = kind;
  e.code = code;
  return e;
}

// MCP 가 {error, message, code} 로 돌려준 실패를 분류
function classify(data) {
  const code = String(data.code ?? "");
  const msg = `${data.error}: ${data.message || ""}`.trim();
  if (code === "22") return toError("quota", "공공데이터포털 일일 호출 한도를 초과했습니다 (code 22).", code);
  if (["20", "30", "31", "32"].includes(code) || data.error === "config_error") {
    return toError("auth", `API 키 문제로 조회할 수 없습니다 (${msg}). 키 등록·만료·Decoding 키 여부를 확인하세요.`, code);
  }
  // 실측(probe): 잘못된/미등록 키는 code 없이 network_error "HTTP error: 403" 으로 온다 → 재시도해도 소용없는 인증 오류
  if (data.error === "network_error" && /\b(401|403)\b/.test(String(data.message))) {
    return toError("auth", `API 키가 거부되었습니다 (${msg}). 키 등록·만료·Decoding 키 여부를 확인하세요.`, code);
  }
  if (data.error === "network_error") return toError("transient", msg, code);
  return toError("fatal", msg, code);
}

function createMcpSource(client) {
  const source = {
    kind: "live",
    onCall: null, // 스토어가 일일 호출 수를 세기 위해 설정하는 훅
    async fetchMonth(sgg, ym) {
      let numOfRows = FIRST_ROWS;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (source.onCall) source.onCall();
        const data = await client.callTool("get_apartment_trades", { region_code: sgg, year_month: ym, num_of_rows: numOfRows });
        if (data.error) {
          if (data.code === "03") return { rows: [], totalCount: 0 }; // 데이터 없음
          throw classify(data);
        }
        if (data.total_count > numOfRows && numOfRows < MAX_ROWS) {
          numOfRows = MAX_ROWS; // 잘렸을 수 있음 → 더 크게 재호출
          continue;
        }
        const items = Array.isArray(data.items) ? data.items : [];
        const rows = items.map((it) => ({
          sgg,
          ym,
          dong: it.dong,
          apt: it.apt_name,
          areaSqm: Number(it.area_sqm),
          floor: it.floor,
          priceMan: Number(it.price_10k),
          date: it.trade_date,
          buildYear: it.build_year,
          dealType: it.deal_type || "",
        })).filter((r) => r.dong && r.apt && r.areaSqm > 0 && r.priceMan > 0);
        return { rows, totalCount: data.total_count ?? rows.length, truncated: data.total_count > numOfRows };
      }
      throw toError("fatal", "재호출 후에도 응답을 얻지 못했습니다.");
    },
  };
  return source;
}

module.exports = { createMcpSource, classify, toError };
