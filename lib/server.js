import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  scanNarajangteoProcurement,
  scanAgencyBids,
  scanDapaPlan,
  scanNiaBoard,
  getHolidayInfo,
  AGENCY_LIST,
  DEFAULT_KEYWORDS,
  nowKstStr,
} from "./pdp_client.js";
import {
  searchOnbidRealEstate,
  getOnbidRealEstateDetail,
  getOnbidBidInfo,
  searchDrugEasyInfo,
  searchDrugPermission,
  searchDrugPermissionList,
  searchDrugIngredients,
  searchPillIdentification,
  searchHealthFood,
  PRPT_DIV_CODES,
} from "./onbid_mfds_client.js";

export function buildServer() {
  const server = new McpServer({ name: "public-data-portal-mcp", version: "1.0.0" });

  server.tool(
    "scan_narajangteo_procurement",
    "나라장터 4종(조달요청→발주계획→사전규격→입찰공고)을 지정 키워드로 각각 조회하고, " +
      "같은 사업이 여러 단계에 걸쳐 나타나면 가장 진전된 단계에서만 남기는 교차 중복제거까지 " +
      "적용해서 반환합니다. since만 넣으면 until은 현재 KST 시각으로 자동 설정되고, " +
      "since가 27일보다 오래됐으면 자동으로 27일 전으로 당겨집니다(truncatedTo27Days로 표시). " +
      "keywords 생략 시 기본 12개 키워드(AI/생성형/클라우드/정보시스템/빅데이터/데이터센터/" +
      "디지털전환/챗봇/RPA/RAG/Agent/지능형) 사용. 오탐 필터링(예: 'AIRPORT'의 AI)과 검토가치 " +
      "판단은 이 도구가 하지 않으니 반환된 title을 보고 직접 판단하세요.",
    {
      since: z.string().describe("조회 시작 시각 YYYYMMDDHHMM (예: 202607200900)"),
      until: z.string().optional().describe("조회 종료 시각 YYYYMMDDHHMM, 생략 시 현재 KST 시각"),
      keywords: z.array(z.string()).optional().describe("검색 키워드 목록, 생략 시 기본 12개 키워드"),
    },
    async ({ since, until, keywords }) => {
      const result = await scanNarajangteoProcurement({ since, until, keywords });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "scan_agency_bids",
    "나라장터 외 8개 기관(수자원공사 입찰공고/사전규격, 한국마사회, 방위사업청 해외입찰, " +
      "방위사업청 군수품조달 입찰공고, 한국지역정보개발원, 한국남부발전, 한국지역난방공사) 중 " +
      "하나를 조회해서 키워드 매칭 결과를 반환합니다. 각 기관 API의 서로 다른 성공코드/헤더/" +
      "인코딩/월단위 조회 등 quirk를 서버가 흡수합니다. 나라장터(scan_narajangteo_procurement) " +
      "결과와 사업명이 같은 건이 있으면 나라장터 쪽을 우선하고 이 결과에서는 제외하는 교차 " +
      "중복제거는 호출하는 쪽에서 두 결과의 title을 비교해서 직접 수행하세요(이 도구는 " +
      "그 비교를 하지 않습니다).",
    {
      agency: z.enum(AGENCY_LIST).describe(`기관 코드: ${AGENCY_LIST.join(", ")}`),
      since: z.string().describe("조회 시작 시각 YYYYMMDDHHMM"),
      until: z.string().optional().describe("조회 종료 시각 YYYYMMDDHHMM, 생략 시 현재 KST 시각"),
      keywords: z.array(z.string()).optional().describe("검색 키워드 목록, 생략 시 기본 12개 키워드"),
    },
    async ({ agency, since, until, keywords }) => {
      const result = await scanAgencyBids({ agency, since, until, keywords });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "scan_dapa_plan",
    "방위사업청 D2B 조달계획(9번 입찰공고보다 이른 국내 방산조달 단계)을 키워드로 조회합니다. " +
      "이 API는 등록일시 필드가 없어 시간 범위 필터가 불가능하므로, 매번 '현재 조달계획 전체 " +
      "중 키워드 매칭분'을 전부 반환합니다(id 필드는 dcsNo). 이전 실행에서 이미 본 건인지" +
      "('신규' 판정)는 이 도구가 상태를 갖지 않으므로 호출하는 쪽이 이전에 받은 id 목록과 " +
      "비교해서 직접 판단하세요.",
    {
      keywords: z.array(z.string()).optional().describe("검색 키워드 목록, 생략 시 기본 12개 키워드"),
    },
    async ({ keywords }) => {
      const result = await scanDapaPlan({ keywords });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "scan_nia_board",
    "NIA(한국지능정보사회진흥원) 알림마당 입찰공고 게시판(Open API 없음, HTML 목록 파싱)을 " +
      "최근 페이지부터 조회해서 키워드 매칭 결과를 반환합니다(id 필드는 bcIdx). 날짜가 일 단위 " +
      "까지만 있어 시간 범위 필터가 부정확하므로, dapa_plan과 마찬가지로 매번 최근 게시물 중 " +
      "매칭분 전체를 반환합니다 — '신규' 판정은 호출하는 쪽이 이전에 받은 id 목록과 비교해서 " +
      "직접 판단하세요. allFetchedIds 필드에는 키워드 매칭 여부와 무관하게 이번에 실제로 파싱에 " +
      "성공한 전체 bcIdx가 들어있으니, 다음 실행을 위한 seen 목록 갱신에 이 값을 사용하세요.",
    {
      pages: z.number().int().min(1).max(10).optional().describe("조회할 페이지 수 (기본 5, 페이지당 10건)"),
      keywords: z.array(z.string()).optional().describe("검색 키워드 목록, 생략 시 기본 12개 키워드"),
    },
    async ({ pages, keywords }) => {
      const result = await scanNiaBoard({ pages, keywords });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_holiday_info",
    "한국천문연구원 특일정보 API로 지정 연/월의 공휴일 목록(날짜명, 날짜, 공휴일여부)을 " +
      "조회합니다. 오늘이 공휴일인지 확인할 때는 응답의 locdate가 오늘 날짜와 일치하고 " +
      "isHoliday가 'Y'인 항목이 있는지 확인하세요.",
    {
      year: z.union([z.string(), z.number()]).describe("연도 (예: 2026)"),
      month: z.union([z.string(), z.number()]).describe("월 (예: 7 또는 '07')"),
    },
    async ({ year, month }) => {
      const result = await getHolidayInfo({ year, month });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_agencies",
    "scan_agency_bids에 넣을 수 있는 기관 코드 목록과 기본 키워드 목록, 현재 KST 기준 시각을 " +
      "조회합니다.",
    {},
    async () => {
      const text = JSON.stringify(
        { agencies: AGENCY_LIST, defaultKeywords: DEFAULT_KEYWORDS, nowKst: nowKstStr() },
        null,
        2
      );
      return { content: [{ type: "text", text }] };
    }
  );


  // ─── 온비드(한국자산관리공사 공매) ───────────────────────────────────────
  server.tool(
    "search_onbid_realestate",
    "한국자산관리공사 온비드에 등록된 **부동산 공매물건 목록**을 지역·금액·면적·입찰기간 등으로 " +
      "검색합니다. ★ 온비드는 법원이 집행하는 '경매'가 아니라 캠코가 집행하는 '공매(公賣)'입니다 — " +
      "법원경매 물건은 이 API에 없습니다. ★ 현재 입찰중이거나 입찰예정인 물건만 제공되고 이미 종료된 " +
      "과거 물건은 조회되지 않으므로, '최근 1주에 나온 물건'은 updatedFrom/updatedTo(물건 등록·수정일 " +
      "기준)로, '이번 주에 입찰하는 물건'은 bidStartFrom/bidStartTo(입찰기간 기준)로 각각 다르게 " +
      "조회해야 합니다. ★ 소재지는 법정동 기준이라 '교문2동' 같은 행정동을 넣으면 0건이 나오므로, " +
      "서버가 자동으로 끝자리 숫자를 떼어('교문동') 재조회하고 그 사실을 dongResolution에 적어 " +
      "돌려줍니다. 반환된 cltrMngNo와 pbctCdtnNo를 get_onbid_realestate_detail / get_onbid_bid_info에 " +
      "넣으면 상세·입찰조건을 볼 수 있습니다.",
    {
      sido: z.string().optional().describe("소재지 시도 (예: 경기도, 서울특별시)"),
      sigungu: z.string().optional().describe("소재지 시군구 (예: 구리시, 고양시 일산동구)"),
      eupmyeondong: z.string().optional().describe("소재지 읍면동 — 법정동명 기준(예: 교문동). 행정동('교문2동')을 넣으면 서버가 법정동으로 바꿔 재시도합니다"),
      prptDivCd: z.string().optional().describe(`재산유형코드(쉼표로 복수 지정). 생략 시 전체. ${Object.entries(PRPT_DIV_CODES).map(([k, v]) => `${k}:${v}`).join(", ")}`),
      pvctTrgtYn: z.enum(["Y", "N"]).optional().describe("수의계약 가능여부. 필수값이며 기본 N(수의계약 불가 물건 = 일반 공매물건). Y로 주면 수의계약 가능 물건만 나옵니다"),
      dspsMthodCd: z.enum(["0001", "0002"]).optional().describe("처분방식 0001:매각 0002:임대"),
      bidDivCd: z.enum(["0001", "0002"]).optional().describe("입찰구분 0001:인터넷(전자입찰) 0002:현장"),
      cptnMthodCd: z.string().optional().describe("입찰방식 0001:일반경쟁 0002:제한경쟁 0003:지명경쟁 0004:수의계약"),
      usageLarge: z.string().optional().describe("용도 대분류코드 (부동산=10000)"),
      usageMedium: z.string().optional().describe("용도 중분류코드 (예: 10100 토지, 10400 산업용및기타특수용건물)"),
      usageSmall: z.string().optional().describe("용도 소분류코드"),
      minPrice: z.union([z.string(), z.number()]).optional().describe("최저입찰가격 하한(원)"),
      maxPrice: z.union([z.string(), z.number()]).optional().describe("최저입찰가격 상한(원)"),
      minAppraisal: z.union([z.string(), z.number()]).optional().describe("감정평가금액 하한(원)"),
      maxAppraisal: z.union([z.string(), z.number()]).optional().describe("감정평가금액 상한(원)"),
      minLandArea: z.union([z.string(), z.number()]).optional().describe("토지면적 하한(㎡)"),
      maxLandArea: z.union([z.string(), z.number()]).optional().describe("토지면적 상한(㎡)"),
      minBldArea: z.union([z.string(), z.number()]).optional().describe("건물면적 하한(㎡)"),
      maxBldArea: z.union([z.string(), z.number()]).optional().describe("건물면적 상한(㎡)"),
      minFailCount: z.union([z.string(), z.number()]).optional().describe("유찰횟수 하한"),
      maxFailCount: z.union([z.string(), z.number()]).optional().describe("유찰횟수 상한"),
      bidStartFrom: z.string().optional().describe("입찰기간 시작일 YYYYMMDD — '언제 입찰하는 물건인가' 기준"),
      bidStartTo: z.string().optional().describe("입찰기간 종료일 YYYYMMDD"),
      updatedFrom: z.string().optional().describe("물건 최종수정일 시작 YYYYMMDD — '최근에 새로 올라온/바뀐 물건' 기준"),
      updatedTo: z.string().optional().describe("물건 최종수정일 종료 YYYYMMDD"),
      cltrName: z.string().optional().describe("물건명 부분검색"),
      orgName: z.string().optional().describe("공고기관명 (예: 한국자산관리공사)"),
      shareOnly: z.enum(["Y", "N"]).optional().describe("지분물건 여부"),
      limit: z.number().int().min(1).max(300).optional().describe("가져올 최대 건수 (기본 30)"),
    },
    async (args) => {
      const result = await searchOnbidRealEstate(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_onbid_realestate_detail",
    "온비드 부동산 공매물건 **상세정보**를 조회합니다. search_onbid_realestate가 돌려준 " +
      "cltrMngNo(물건관리번호)와 pbctCdtnNo(공매조건번호)를 함께 넣으세요. 소재지 상세주소, 지목·면적 " +
      "내역(sqmsList), 감정평가 내역(apslEvlClgList), 임대차정보(leasInfList), 등기사항증명서 주요정보" +
      "(rgstPrmrInfList), 점유관계(ocpyRelList), 배분요구 사항(dtbtRqrMtrsList), 공매재산명세(papsInf), " +
      "사진·위치도 URL, 입찰자 자격(purrQlfcCont)·유의사항(pytnMtrsCont)까지 나옵니다. " +
      "입찰중·입찰예정 물건만 조회 가능합니다.",
    {
      cltrMngNo: z.string().describe("물건관리번호 (예: 2020-11444-007)"),
      pbctCdtnNo: z.union([z.string(), z.number()]).optional().describe("공매조건번호 (예: 6160097). 생략 가능하지만 넣는 편이 정확합니다"),
    },
    async ({ cltrMngNo, pbctCdtnNo }) => {
      const result = await getOnbidRealEstateDetail({ cltrMngNo, pbctCdtnNo });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_onbid_bid_info",
    "온비드 물건의 **입찰조건 상세**를 조회합니다(물건 자체 정보가 아니라 '어떻게 입찰하는가'). " +
      "입찰보증금 납부방법·기한(pcmtPayMtdCont/pcmtPayTermCont), 공동입찰·대리입찰·2회이상 입찰 가능 " +
      "여부와 제출서류, 자격제한(qlfcLmtCdtnCont)·지역제한(rgnLmtCdtnCont), 최저보증금률, 예정가격 " +
      "산정방식, 차수별 입찰내역(cseqBidInfClgList) 등이 포함됩니다. cltrMngNo와 pbctCdtnNo가 필요하며 " +
      "부동산뿐 아니라 자동차·동산 물건에도 사용할 수 있습니다.",
    {
      cltrMngNo: z.string().describe("물건관리번호"),
      pbctCdtnNo: z.union([z.string(), z.number()]).optional().describe("공매조건번호"),
    },
    async ({ cltrMngNo, pbctCdtnNo }) => {
      const result = await getOnbidBidInfo({ cltrMngNo, pbctCdtnNo });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── 식품의약품안전처 ─────────────────────────────────────────────────────
  server.tool(
    "search_drug_easy_info",
    "식약처 **의약품개요정보(e약은요)** — 일반인이 읽기 쉽게 정리된 복약안내를 조회합니다. " +
      "효능, 사용법, 사용 전 경고, 사용상 주의사항, 병용 주의 약·음식, 이상반응, 보관법 7문항이 " +
      "평이한 문장으로 들어 있어 '이 약 어떻게 먹어?', '이 약 부작용이 뭐야?' 같은 질문에 적합합니다. " +
      "★ 제품명·업체명·품목기준코드로만 검색되며 **성분으로는 검색할 수 없습니다** — 성분으로 찾을 " +
      "때는 search_drug_permission을 쓰세요. ★ 이 DB는 전체 허가 의약품이 아니라 일부 품목만 수록하고 " +
      "있으므로, 0건이라고 해서 '그런 약이 없다'는 뜻이 아닙니다(허가정보로 교차 확인할 것).",
    {
      itemName: z.string().optional().describe("제품명 부분검색 (예: 타이레놀)"),
      entpName: z.string().optional().describe("업체명 부분검색 (예: 한미약품)"),
      itemSeq: z.string().optional().describe("품목기준코드 (예: 200003092)"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchDrugEasyInfo(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_drug_permission",
    "식약처 **의약품 제품 허가정보** 전체 DB를 조회합니다. 허가일자, 전문/일반 구분, 성상, 포장단위, " +
      "저장방법·유효기간, 보험코드(EDI), ATC코드, 취소여부, 그리고 **주성분(MAIN_ITEM_INGR)과 " +
      "첨가제(INGR_NAME)** 가 들어 있습니다. ★ '이 성분이 들어간 약을 찾아줘'(예: 콘드로이친, " +
      "아세트아미노펜)는 mainIngredient로 검색하는 이 도구가 유일한 경로입니다 — e약은요에는 성분 " +
      "검색이 없습니다. 성분명은 데이터에 '황산 콘드로이친 나트륨'처럼 수식어가 붙어 저장되므로 " +
      "짧은 핵심어로 넣어야 걸립니다. ★ 한글 성분명은 외래어 표기가 데이터마다 갈리므로(의약품은 " +
      "'콘드로이틴' 178건, 건강기능식품은 '콘드로이친' 293건) 서버가 어간으로 자동 재조회해 더 많이 " +
      "잡히는 쪽을 돌려주고 ingredientResolution에 그 사실을 남깁니다 — 이 필드가 있으면 답변에도 " +
      "옮겨 적으세요. 영문 성분명으로 확실히 하려면 search_drug_permission_list를 함께 쓰세요. " +
      "verbose=true로 부르면 효능효과·용법용량·" +
      "사용상주의사항 XML 원문까지 함께 받습니다(응답이 커집니다). ★ 성분이 의약품이 아니라 " +
      "건강기능식품 원료일 수도 있으므로, 성분 질문에는 search_health_functional_food도 함께 " +
      "확인하는 것이 안전합니다.",
    {
      itemName: z.string().optional().describe("제품명 부분검색"),
      entpName: z.string().optional().describe("업체명 부분검색"),
      mainIngredient: z.string().optional().describe("주성분명 부분검색 (예: 콘드로이친, 아세트아미노펜)"),
      itemSeq: z.string().optional().describe("품목기준코드"),
      ediCode: z.string().optional().describe("보험코드(EDI)"),
      verbose: z.boolean().optional().describe("true면 효능효과·용법용량·주의사항 XML 원문 포함 (기본 false)"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchDrugPermission(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_drug_permission_list",
    "식약처 **의약품 제품 허가 목록**을 조회합니다(상세조회보다 가볍습니다). 이 도구에만 있는 것이 " +
      "**영문 주성분명 검색(ingredientEnglish)** 이며, 한글 성분명의 외래어 표기 요동을 우회하는 가장 " +
      "확실한 경로입니다 — 실측에서 한글 '콘드로이친'은 3건뿐이었지만 영문 'Chondroitin'은 181건이었고, " +
      "한글 쪽 표준 표기는 '콘드로이틴'(178건)이었습니다. ★ 성분 질문에는 이 도구와 " +
      "search_drug_permission(한글)을 **둘 다** 돌려 건수를 대조하세요. 한쪽만 보면 규모를 크게 " +
      "과소평가합니다. ★ ingredientEnglish는 대소문자를 구분합니다 — 'Chondroitin'은 181건, " +
      "'chondroitin'은 0건이므로 첫 글자를 대문자로 넣으세요. 응답에는 영문 성분명(ITEM_INGR_NAME, " +
      "여러 성분은 '/'로 구분)·성분 수·약효분류(PRDUCT_TYPE)·제품 이미지·허가 취소 여부가 포함됩니다.",
    {
      itemName: z.string().optional().describe("품목명(제품명) 부분검색"),
      entpName: z.string().optional().describe("업체명 부분검색"),
      ingredientEnglish: z.string().optional().describe("영문 주성분명 (예: Chondroitin, Acetaminophen). 대소문자 구분 — 첫 글자 대문자"),
      otcType: z.string().optional().describe("전문/일반 구분 (예: 전문의약품, 일반의약품)"),
      induty: z.string().optional().describe("업종 (예: 의약품, 의약외품)"),
      ediCode: z.string().optional().describe("보험코드(EDI)"),
      stdCode: z.string().optional().describe("품목일련번호(품목기준코드)"),
      permitNo: z.string().optional().describe("품목허가번호"),
      bizrno: z.string().optional().describe("사업자등록번호"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchDrugPermissionList(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_drug_ingredients",
    "식약처 **의약품 제품 주성분 상세** — 한 제품에 어떤 성분이 **얼마나** 들어 있는지 성분별로 " +
      "한 행씩 조회합니다. 성분명(한글)·분량·단위·성분코드가 나오므로 '이 약에 콘드로이틴이 몇 mg " +
      "들었나' 같은 질문에 답할 수 있습니다(예: 토비콤캅셀 → 황산 콘드로이친 나트륨 100밀리그램, " +
      "팔미틴산레티놀 2500아이.유 …). ★ **성분명으로는 검색할 수 없습니다** — 제품명·업체명·" +
      "사업자등록번호로만 좁혀집니다. 특정 성분이 든 제품을 찾는 것이 목적이면 " +
      "search_drug_permission(한글) 또는 search_drug_permission_list(영문)로 제품을 먼저 찾고, " +
      "그 제품명으로 이 도구를 호출해 배합량을 확인하세요.",
    {
      productName: z.string().optional().describe("제품명(한글) 부분검색 (예: 토비콤캅셀)"),
      companyName: z.string().optional().describe("업체명 부분검색 (예: 안국약품)"),
      bizrno: z.string().optional().describe("사업자등록번호"),
      entpPermitNo: z.string().optional().describe("업체허가번호"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 — 성분 단위 행이므로 넉넉히 (기본 20)"),
    },
    async (args) => {
      const result = await searchDrugIngredients(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_pill_identification",
    "식약처 **의약품 낱알식별 정보**를 조회합니다. 알약의 각인(PRINT_FRONT/BACK), 모양(DRUG_SHAPE), " +
      "색상(COLOR_CLASS1/2), 분할선, 장축·단축·두께, 낱알 이미지 URL(ITEM_IMAGE), 분류번호·분류명, " +
      "전문/일반 구분이 나옵니다. ★ **각인·모양·색상으로는 검색할 수 없습니다** — 공공데이터포털 " +
      "공식 명세상 요청 파라미터로 아예 존재하지 않고 응답 필드로만 제공되므로, 표기를 바꿔 " +
      "재시도해도 소용없습니다. 따라서 '흰색 원형에 T가 찍힌 알약이 뭐야' 같은 겉모양 역추적은 이 " +
      "도구만으로는 불가능하며, 제품명 후보를 먼저 좁힌 뒤 반환된 ITEM_IMAGE·PRINT_FRONT·DRUG_SHAPE와 " +
      "대조하는 방식으로 써야 합니다. 성상(chart)·제형(formCodeName)은 공식 명세에 없지만 실제로 " +
      "동작하는 미문서화 파라미터라 예고 없이 막힐 수 있습니다.",
    {
      itemName: z.string().optional().describe("제품명 부분검색"),
      entpName: z.string().optional().describe("업체명 부분검색"),
      itemSeq: z.string().optional().describe("품목기준코드"),
      ediCode: z.string().optional().describe("보험코드(EDI)"),
      bizrno: z.string().optional().describe("사업자등록번호"),
      imgRegistTs: z.string().optional().describe("약학정보원 이미지 생성일"),
      chart: z.string().optional().describe("성상 부분검색 (예: 흰색, 노란색의 원형 정제)"),
      formCodeName: z.string().optional().describe("제형 (예: 나정, 필름코팅정, 경질캡슐)"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchPillIdentification(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_health_functional_food",
    "식약처 **건강기능식품 품목정보**를 조회합니다. 업체명(ENTRPS), 제품명(PRDUCT), 신고번호" +
      "(STTEMNT_NO), 유통기한, 성상(SUNGSANG), 섭취방법(SRV_USE), 보관방법, 섭취 시 주의사항" +
      "(INTAKE_HINT1), 기능성 내용(MAIN_FNCTN), 기준규격(BASE_STANDARD)이 포함됩니다. " +
      "콘드로이친·글루코사민·프로바이오틱스처럼 의약품이 아닌 건강기능식품 원료로 쓰이는 성분을 " +
      "확인할 때 필수입니다. 제품명·업체명 부분검색과 신고번호 조회를 모두 지원합니다. " +
      "★ 이 서비스는 오퍼레이션이 둘이고 업체명 검색은 목록조회에서만 동작하므로, companyName을 " +
      "주면 서버가 목록조회로 좁힌 뒤 신고번호로 상세를 자동 병합합니다(응답의 searchedVia로 확인). " +
      "상세 병합은 20건까지만 수행하며, 그보다 많으면 totalCount로 전체 규모를 확인하세요. " +
      "목록 4개 필드(업체명·제품명·신고번호·등록일)만 빠르게 훑고 싶으면 detail=false를 주세요.",
    {
      productName: z.string().optional().describe("제품명 부분검색 (예: 콘드로이친, 유산균)"),
      companyName: z.string().optional().describe("업체명 부분검색 (예: 일동, 광동헬스바이오)"),
      statementNo: z.string().optional().describe("신고번호 (예: 20140017002183)"),
      detail: z.boolean().optional().describe("companyName을 준 경우에만 의미 있음. false면 기능성·성상 등 상세 병합을 생략하고 목록 4개 필드만 반환 (기본 true)"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchHealthFood(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}
