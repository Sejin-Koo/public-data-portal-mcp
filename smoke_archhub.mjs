// 건축HUB 도구 스모크테스트 — 정상경로 + 안내경로
import {
  resolveBjdong, scanArchPermits, searchArchPermits,
  getArchPermitDetail, searchArchAuxRegisters,
  DETAIL_SECTIONS, AUX_KINDS, ARCHHUB_DATA_LAG,
} from "./lib/archhub_client.js";

const show = (t, o, keys) => {
  console.log(`\n### ${t}  (ok=${o.ok})`);
  if (keys) for (const k of keys) if (o[k] !== undefined) console.log(`  ${k}:`, JSON.stringify(o[k]).slice(0, 420));
  else console.log("  " + JSON.stringify(o).slice(0, 420));
};

console.log("데이터 지연:", ARCHHUB_DATA_LAG, "| 섹션", DETAIL_SECTIONS.length, "| 부속대장", AUX_KINDS.length);

const r0 = await resolveBjdong("강남구");
console.log("\n### 0 법정동 해석(강남구)\n  법정동수:", r0.법정동수, "| 예시:", r0.법정동.slice(0,3).map(d=>`${d.동명}(${d.시군구코드}-${d.법정동부코드})`).join(", "));

show("1 지역스캔(강남구·2026생성·착공단계)",
  await scanArchPermits({ region: "강남구", since: "20260101", until: "20260829", stage: "착공", maxDongs: 5, limit: 3 }),
  ["조회조건","지역해석","호출한_법정동수","필터후건수","구분별","용도별","결과"]);

show("1b 지역스캔(조건 없음)", await scanArchPermits({}), ["reason","안내"]);
show("1c 지역스캔(없는 지역)", await scanArchPermits({ region: "없는동네xyz" }), ["안내"]);

show("2 단일조회(개포동 12-4)",
  await searchArchPermits({ sigunguCd: "11680", bjdongCd: "10300", bun: "12", ji: "4", limit: 2 }),
  ["조회조건","전체건수","필터후건수","결과"]);
show("2b 단일조회(시군구만)", await searchArchPermits({ sigunguCd: "11680" }), ["reason","안내"]);

show("3 상세(개포동 12-4)",
  await getArchPermitDetail({ sigunguCd: "11680", bjdongCd: "10300", bun: "12", ji: "4", sections: ["동별개요","주차장","알수없는것"], limitPerSection: 1 }),
  ["섹션","알수없는_섹션","조회실패"]);
show("3b 상세(코드 누락)", await getArchPermitDetail({}), ["reason","사용가능한_섹션"]);

show("4 철거멸실(강남구)",
  await searchArchAuxRegisters({ region: "강남구", kinds: ["철거멸실"], maxDongs: 5, limitPerKind: 2 }),
  ["조회조건","지역해석","결과"]);
show("4b 부속대장(잘못된 종류)", await searchArchAuxRegisters({ region: "강남구", kinds: ["없는대장"] }), ["reason"]);
