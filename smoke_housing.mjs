// 주택인허가 · 청약홈 도구 스모크테스트 — 정상경로 + 안내경로
import {
  searchHousingPermits,
  searchHousingSales,
  scanConstructionPipeline,
  HS_OPS,
  SALE_TYPES,
} from "./lib/housing_client.js";

const show = (t, o, keys) => {
  console.log(`\n### ${t}  (ok=${o.ok})`);
  if (keys) {
    for (const k of keys) if (o[k] !== undefined) console.log(`  ${k}:`, JSON.stringify(o[k]).slice(0, 700));
  } else {
    console.log("  " + JSON.stringify(o).slice(0, 700));
  }
};

console.log("주택인허가 대장", Object.keys(HS_OPS).join("/"), "| 청약홈 유형", Object.keys(SALE_TYPES).join("/"));

// ── 1. 주택인허가 정상경로: 이천시 (힐스테이트 이천역 1단지가 있어야 한다)
show(
  "1 주택인허가 — 이천시 300세대 이상",
  await searchHousingPermits({ region: "이천시", minHouseholds: 300, maxDongs: 6, limit: 5 }),
  ["조회조건", "지역해석", "수집행수", "조건일치_단지수", "단지"]
);

// ── 1b. 착공일 결측 특성 확인: 시공 중 단지
show(
  "1b 주택인허가 — 구미시 시공중/착공예정만",
  await searchHousingPermits({ region: "구미시", minHouseholds: 400, maxDongs: 8, limit: 5 }),
  ["조건일치_단지수", "단지"]
);

// ── 1c. 행정구역 개편 확인: 광주 북구(전남광주통합특별시)
show(
  "1c 주택인허가 — 광주 북구(행정구역 개편 지역)",
  await searchHousingPermits({ region: "북구", maxDongs: 3, limit: 2 }),
  ["지역해석", "조건일치_단지수"]
);

// ── 1d. 안내경로: 조건 없음
show("1d 주택인허가 — 조건 없음(안내)", await searchHousingPermits({}), ["reason"]);
// ── 1e. 안내경로: 없는 지역
show("1e 주택인허가 — 없는 지역(안내)", await searchHousingPermits({ region: "없는동네xyz" }), ["reason"]);
// ── 1f. 안내경로: 잘못된 섹션
show("1f 주택인허가 — 잘못된 섹션(안내)", await searchHousingPermits({ region: "이천시", sections: ["없는대장"] }), ["reason"]);

// ── 2. 청약홈 정상경로
show(
  "2 청약홈 — 시공사 현대건설, 입주 2027 이후",
  await searchHousingSales({ contractor: "현대건설", moveInFrom: "202701", limit: 3 }),
  ["조회조건", "소스별", "수집_전체건수", "조건일치_건수", "필터경로", "분양"]
);

// ── 2b. 서버측 문서화 필터
show(
  "2b 청약홈 — 주택명 부분검색(서버측 cond)",
  await searchHousingSales({ houseName: "힐스테이트", limit: 3 }),
  ["소스별", "조건일치_건수", "필터경로"]
);

// ── 2c. 안내경로: 잘못된 유형
show("2c 청약홈 — 잘못된 유형(안내)", await searchHousingSales({ types: ["없는유형"] }), ["reason"]);

// ── 2d. 오피스텔은 시공사 컬럼이 없다
show(
  "2d 청약홈 — 오피스텔등(시공사 컬럼 없음 확인)",
  await searchHousingSales({ types: ["오피스텔등"], limit: 2 }),
  ["소스별", "조건일치_건수", "분양"]
);

// ── 3. 파이프라인
show(
  "3 파이프라인 — 3사 시공, 입주 2027-01 이후",
  await scanConstructionPipeline({ moveInFrom: "202701", limit: 3 }),
  ["조회조건", "조건일치_현장수", "총공급세대_합계", "연도별_현장수", "시공사별_현장수", "현장"]
);

// ── 3b. 파이프라인 보강(주택인허가 교차) — 1건만
show(
  "3b 파이프라인 — enrich 1건",
  await scanConstructionPipeline({ moveInFrom: "202704", moveInTo: "202704", enrich: true, enrichLimit: 1, limit: 2 }),
  ["조건일치_현장수", "주택인허가_보강"]
);

console.log("\n=== 스모크테스트 종료 ===");
