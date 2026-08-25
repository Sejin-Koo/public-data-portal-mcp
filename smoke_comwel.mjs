// 근로복지공단 도구 2종 스모크테스트.
// 실행: PUBLIC_DATA_PORTAL_KEY=... DART_API_KEY=... node smoke_comwel.mjs
import { buildServer } from "./lib/server.js";

const server = buildServer();
const reg = server._registeredTools || server.server?._registeredTools;
const names = Object.keys(reg);
console.log(`등록된 도구 ${names.length}개`);
for (const n of ["get_employment_insurance_workplace", "get_accident_insurance_rate"]) {
  console.log(`  ${n}: ${reg[n] ? "등록됨" : "★ 없음"}`);
}
console.log("");

async function run(label, name, args) {
  const t0 = Date.now();
  try {
    const out = await reg[name].handler(args, {});
    const j = JSON.parse(out.content[0].text);
    console.log(`### ${label}  (${Date.now() - t0}ms)`);
    console.log(JSON.stringify(j, null, 1).slice(0, 2200));
  } catch (e) {
    console.log(`### ${label}  ★실패: ${e.message}`);
  }
  console.log("");
}

// 1. 정상경로 — 사업자등록번호 직접 지정 (포니링크)
await run("1. bizNo 직접 (포니링크)", "get_employment_insurance_workplace", {
  bizNo: "1198137606",
  pensionMonths: 2,
});

// 2. 회사명 자동 해석 — 법인격 표기 포함
await run("2. companyName 해석 ('주식회사 포니링크')", "get_employment_insurance_workplace", {
  companyName: "주식회사 포니링크",
  pensionMonths: 2,
});

// 3. DART 미등록 비상장사 폴백 — 링크아이
await run("3. DART 미등록 폴백 (링크아이)", "get_employment_insurance_workplace", {
  companyName: "링크아이",
  pensionMonths: 2,
});

// 4. 잘못된 자릿수 방어 — 앞 6자리
await run("4. 6자리 방어", "get_employment_insurance_workplace", {
  bizNo: "789870",
});

// 5. 존재하지 않는 회사명
await run("5. 없는 회사명", "get_employment_insurance_workplace", {
  companyName: "존재하지않는회사이름12345",
  includePension: true,
  pensionMonths: 1,
});

// 6. 산재만 필터
await run("6. insurance=산재 (포니링크)", "get_employment_insurance_workplace", {
  bizNo: "1198137606",
  insurance: "산재",
  includePension: false,
});

// 7. 요율표 — 업종코드 지정
await run("7. 요율 industryCode=91001", "get_accident_insurance_rate", {
  industryCode: "91001",
});

// 8. 요율표 — 키워드 검색
await run("8. 요율 keyword=소프트웨어", "get_accident_insurance_rate", { keyword: "소프트웨어" });

// 9. 요율표 — 과거 연도 방어
await run("9. 요율 year=1800 (범위 밖)", "get_accident_insurance_rate", { year: "1800" });
