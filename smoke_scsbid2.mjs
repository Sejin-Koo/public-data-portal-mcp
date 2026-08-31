// 낙찰정보 도구 2차 개선 검증 (2026-08-31)
// 실행: NODE_USE_ENV_PROXY=1 DATA_PORTAL_KEY=<키> DART_API_KEY=<키> node smoke_scsbid2.mjs
import { searchScsbidWinners } from "./lib/scsbid_client.js";

const line = (t) => console.log("\n===== " + t + " =====");

// 1) 창 경계 중복제거 — 7~8월(62일)이면 2개 창으로 갈리고, 개찰 연기 건이 양쪽에 잡힌다
line("1. 중복제거 / 구간밖 실개찰 / 낙찰률 결측 — 용역·'정보시스템'·2026-07-01~08-31");
const r1 = await searchScsbidWinners({
  bizTypes: ["용역"],
  dateType: "개찰일시",
  from: "202607010000",
  to: "202608312359",
  bidNtceNm: "정보시스템",
  limit: 500,
});
console.log({
  수집건수: r1.수집건수,
  중복제거: r1.중복제거,
  구간밖_실개찰: r1.구간밖_실개찰,
  낙찰률결측: r1.낙찰률결측,
  잘림: r1.잘림,
  업무구분별: r1.업무구분별,
});
console.log("비고:", r1.비고);
console.log("유의사항:", r1.유의사항);
// 실제 고유키 수와 대조
const keys = new Set(r1.결과.map((x) => [x.공고번호, x.공고차수, x.분류번호, x.재입찰번호].join("|")));
console.log("반환행", r1.결과.length, "/ 고유키", keys.size, "→ 중복 잔존:", r1.결과.length - keys.size);

// 2) companyName 해석 성공 경로
line("2. companyName='포니링크' (DART 등록)");
const r2 = await searchScsbidWinners({
  bizTypes: ["용역"],
  from: "202606010000",
  to: "202608312359",
  companyName: "포니링크",
  limit: 10,
});
console.log(r2.해석 ?? r2.error, "| 수집:", r2.수집건수 ?? "-");
if (r2.결과) r2.결과.slice(0, 3).forEach((x) => console.log("  -", x.실개찰일시, x.공고명.slice(0, 30), x.최종낙찰금액));

// 3) companyName 해석 실패 경로 — 안내가 나오는지
line("3. companyName='한신정보기술' (DART 미등록)");
const r3 = await searchScsbidWinners({
  bizTypes: ["용역"],
  from: "202608010000",
  to: "202608312359",
  companyName: "한신정보기술",
});
console.log(JSON.stringify(r3, null, 1));

// 4) bizno가 companyName보다 우선하는지
line("4. bizno + companyName 동시 지정 → bizno 우선");
const r4 = await searchScsbidWinners({
  bizTypes: ["용역"],
  from: "202608010000",
  to: "202608312359",
  bizno: "3178105687",
  companyName: "엉뚱한회사명",
  limit: 5,
});
console.log("해석:", r4.해석, "| 검색조건:", r4.검색조건, "| 수집:", r4.수집건수);
r4.결과.forEach((x) => console.log("  -", x.최종낙찰업체, x.최종낙찰금액));

line("완료");
