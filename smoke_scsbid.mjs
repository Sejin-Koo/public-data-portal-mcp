// 나라장터 낙찰정보서비스 도구 스모크테스트 (2026-08-31)
// 실행:  DATA_PORTAL_KEY=<키> node smoke_scsbid.mjs
import { searchScsbidWinners, getOpengResult, splitWindows } from "./lib/scsbid_client.js";

const line = (t) => console.log("\n===== " + t + " =====");
const brief = (o, keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, o[k]])), null, 1);

// 0) 창 분할 로직
line("0. splitWindows(2026-06-01 ~ 2026-08-30)");
console.log(splitWindows("202606010000", "202608302359"));

// 1) 기간+공고명 검색 (용역) — 31일 초과 구간 자동 분할
line("1. 용역 / 개찰일시 2026-07-01~2026-08-30 / 공고명 '유지관리'");
const r1 = await searchScsbidWinners({
  bizTypes: ["용역"],
  dateType: "개찰일시",
  from: "202607010000",
  to: "202608302359",
  bidNtceNm: "유지관리",
  limit: 3,
});
console.log(brief(r1, ["조회기준", "사용오퍼레이션", "건수", "잘림", "업무구분별", "비고"]));
console.log(r1.결과?.slice(0, 2));

// 2) 사업자번호로 수주이력
line("2. bizno=1220916969 / 2026-08");
const r2 = await searchScsbidWinners({
  bizTypes: ["용역"],
  from: "202608010000",
  to: "202608302359",
  bizno: "1220916969",
  limit: 5,
});
console.log(brief(r2, ["건수", "검색조건", "잘림"]));
console.log(r2.결과);

// 3) 공고번호 단건
line("3. bidNtceNo=R26BK01686208 (단건)");
const r3 = await searchScsbidWinners({ bidNtceNo: "R26BK01686208", bizTypes: ["용역"] });
console.log(JSON.stringify(r3.결과, null, 1));

// 4) 개찰결과 — 개찰완료 건
line("4. get_narajangteo_openg_result R26BK01686208");
const r4 = await getOpengResult({ bidNtceNo: "R26BK01686208", bizType: "용역", limit: 5 });
console.log(JSON.stringify(r4.개찰개요, null, 1));
console.log("참가업체수:", r4.참가업체수);
console.log(r4.순위별투찰내역.slice(0, 3));
console.log("유찰:", r4.유찰, "재입찰:", r4.재입찰);

// 5) 없는 공고번호 → 안내 경로
line("5. 존재하지 않는 공고번호");
const r5 = await getOpengResult({ bidNtceNo: "R26BK99999999" });
console.log(brief(r5, ["업무구분", "참가업체수", "비고"]));

// 6) 잘못된 조합 (등록일시 + 검색조건)
line("6. dateType=등록일시 + 검색조건");
const r6 = await searchScsbidWinners({
  dateType: "등록일시",
  bidNtceNm: "시스템",
  from: "202608010000",
  to: "202608302359",
});
console.log(r6);

// 7) 키 미설정 확인용
line("7. 완료");
