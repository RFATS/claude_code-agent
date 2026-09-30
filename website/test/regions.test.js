"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const A = require("../lib/analytics");

const regions = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "regions.json"), "utf8"));
const codes = new Set(regions.sigungu.map((s) => s.code));
const zoneIds = new Set(regions.zones.map((z) => `zone:${z.id}`));

test("regions: 시군구 코드는 5자리 숫자이고 중복이 없다", () => {
  assert.equal(codes.size, regions.sigungu.length, "중복 코드");
  for (const s of regions.sigungu) assert.match(s.code, /^\d{5}$/, s.name);
});

test("regions: 모든 권역이 존재하는 시군구를 가리키고, 정규식이 유효하다", () => {
  for (const z of regions.zones) {
    assert.ok(z.parts.length, `${z.id}: parts 없음`);
    for (const p of z.parts) {
      assert.ok(codes.has(p.sgg), `${z.id}: 알 수 없는 시군구 ${p.sgg}`);
      if (p.aptRegex) assert.doesNotThrow(() => new RegExp(p.aptRegex), `${z.id}: 잘못된 정규식`);
    }
  }
});

test("regions: 권역이 쓰는 시군구는 모두 verified=true (미검증 코드로 호출하지 않는다)", () => {
  const bySgg = new Map(regions.sigungu.map((s) => [s.code, s]));
  for (const z of regions.zones) for (const p of z.parts) assert.equal(bySgg.get(p.sgg).verified, true, `${z.id} → ${p.sgg} 미검증`);
});

test("regions: 프리셋·비교군이 존재하는 권역만 참조하고, 권역 id 가 유일하다", () => {
  assert.equal(zoneIds.size, regions.zones.length, "권역 id 중복");
  for (const p of regions.presets) {
    assert.ok(zoneIds.has(p.a) && zoneIds.has(p.b), `프리셋 ${p.id}`);
    assert.notEqual(p.a, p.b, `프리셋 ${p.id}: 같은 지역`);
  }
  for (const g of regions.rankingGroups) for (const a of g.areas) assert.ok(zoneIds.has(a), `비교군 ${g.id}: ${a}`);
});

test("regions: 사용 불가 코드는 목록·권역 어디에도 쓰이지 않고, 구가 있는 시의 상위 코드가 모두 들어 있다", () => {
  const dead = new Set(regions.unusable.map((u) => u.code));
  for (const d of dead) assert.ok(!codes.has(d), `${d} 가 사용 가능 목록에도 있음`);
  for (const z of regions.zones) for (const p of z.parts) assert.ok(!dead.has(p.sgg), `${z.id} 가 사용 불가 코드 ${p.sgg} 를 씀`);
  // 수원·성남·안양·부천·안산·고양·용인·화성 상위 코드 + 폐지된 옛 인천 중구·동구·서구
  for (const c of ["41110", "41130", "41170", "41190", "41270", "41280", "41460", "41590", "28110", "28140", "28260"]) assert.ok(dead.has(c), `${c} 누락`);
});

test("regions: 수도권이 빠짐없이 채워져 있다 (서울 25 · 인천 11 · 경기 47)", () => {
  const n = (p) => regions.sigungu.filter((s) => s.code.startsWith(p)).length;
  assert.equal(n("11"), 25);
  assert.equal(n("28"), 11); // 2026-07 개편 후: 제물포·영종·미추홀·연수·남동·부평·계양·서해·검단 + 강화·옹진
  assert.equal(n("41"), 47);
  for (const c of ["28125", "28155", "28275", "28290"]) assert.ok(codes.has(c), `새 인천 구 ${c}`);
  const groups = new Set(regions.sigungu.map((s) => s.group));
  assert.deepEqual([...groups].sort(), ["gyeonggi-north", "gyeonggi-south", "incheon", "seoul"]);
});

test("화성시: 상위 코드(41590) 대신 4개 구 코드를 모두 사용한다", () => {
  assert.ok(!codes.has("41590"), "41590 은 모든 달에 0건이라 넣지 않는다");
  const hw = regions.zones.find((z) => z.id === "hwaseong");
  assert.deepEqual(hw.parts.map((p) => p.sgg).sort(), ["41591", "41593", "41595", "41597"]);
});

test("수지구(광교 제외): 단지명에 '광교'가 든 단지만 빠진다", () => {
  const suji = A.makeAreaMatcher(regions.zones.find((z) => z.id === "suji"));
  const ex = A.makeAreaMatcher(regions.zones.find((z) => z.id === "suji-ex"));
  const gg = A.makeAreaMatcher(regions.zones.find((z) => z.id === "gwanggyo"));
  const row = (dong, apt) => ({ sgg: "41465", dong, apt });
  for (const apt of ["광교자이더클래스", "심곡마을광교힐스테이트", "포레나 광교상현"]) {
    assert.ok(suji(row("상현동", apt)) && !ex(row("상현동", apt)) && gg(row("상현동", apt)), apt);
  }
  for (const apt of ["성복역리버파크", "벽산블루밍", "만현마을1단지롯데캐슬"]) {
    assert.ok(suji(row("상현동", apt)) && ex(row("상현동", apt)) && !gg(row("상현동", apt)), apt);
  }
  assert.ok(ex(row("풍덕천동", "한성")) && ex(row("죽전동", "e편한세상")));
});

test("철산동: 광명시 41210 의 철산동만 잡는다", () => {
  const m = A.makeAreaMatcher(regions.zones.find((z) => z.id === "cheolsan"));
  assert.ok(m({ sgg: "41210", dong: "철산동", apt: "주공" }));
  assert.ok(!m({ sgg: "41210", dong: "하안동", apt: "주공" }));
  assert.ok(!m({ sgg: "41135", dong: "철산동", apt: "x" }));
});
