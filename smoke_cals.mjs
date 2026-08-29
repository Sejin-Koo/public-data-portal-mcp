// 건설CALS 도구 스모크테스트 — 정상경로 + 안내경로
import {
  searchCalsConstruction, getCalsConstructionDetail, searchCalsContractor,
  searchCalsQualityTests, searchCalsProjectEvaluation, searchCalsRoadOccupancy,
  DETAIL_SECTION_NAMES, CALS_KEY_SOURCE,
} from "./lib/cals_client.js";

const show = (t, o) => {
  const s = JSON.stringify(o);
  console.log(`\n### ${t}\n  ok=${o.ok} ${s.length}자`);
  console.log("  " + s.slice(0, 700));
};

console.log("keySource:", CALS_KEY_SOURCE, "| 섹션:", DETAIL_SECTION_NAMES.length);

show("1 공사검색(전체/터널)", await searchCalsConstruction({ cwkNm: "터널", limit: 2 }));
show("1c 공사검색(전체+진행필터)", await searchCalsConstruction({ progress: "진행", limit: 1 }));
show("1d 공사검색(준공상세)", await searchCalsConstruction({ status: "준공", limit: 1 }));
show("1b 공사검색(잘못된 status)", await searchCalsConstruction({ status: "완료" }));
show("2 현장상세", await getCalsConstructionDetail({ sptNo: "C2023021", sections: ["연도별계약", "교량", "월간공정"], limitPerSection: 2 }));
show("2b 현장상세(sptNo 누락)", await getCalsConstructionDetail({}));
show("3 참여업체(해동종합건설)", await searchCalsContractor({ companyName: "해동종합건설", limit: 2 }));
show("3b 참여업체(없는 업체)", await searchCalsContractor({ companyName: "존재하지않는회사명xyz" }));
show("3c 참여업체(조건 없음)", await searchCalsContractor({}));
show("4 품질검사(현대건설)", await searchCalsQualityTests({ contractorName: "현대건설", sDate: "20230101", eDate: "20241231", limit: 3, maxPages: 1 }));
show("4b 품질검사(연도+공사명)", await searchCalsQualityTests({ year: "2024", cwkNm: "아파트", limit: 3, maxPages: 1 }));
show("4c 품질검사(조건 없음)", await searchCalsQualityTests({}));
show("5 사후평가", await searchCalsProjectEvaluation({ kind: "사후평가", sYm: "202001", eYm: "202612", limit: 3, maxPages: 1 }));
show("5b 사후평가(YYYYMMDD 오입력)", await searchCalsProjectEvaluation({ kind: "사후평가", sYm: "20200101", eYm: "20261231", limit: 1, maxPages: 1 }));
show("5c 설계VE(LH)", await searchCalsProjectEvaluation({ kind: "설계VE", orderOrgName: "한국토지주택공사", limit: 3, maxPages: 1 }));
show("6 도로점용(KT)", await searchCalsRoadOccupancy({ sDate: "20260101", eDate: "20261231", applicantName: "케이티", limit: 2, maxPages: 2 }));
show("6b 도로점용(기간 누락)", await searchCalsRoadOccupancy({}));
