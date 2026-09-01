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
  SERVICE_KEY,
  SERVICE_KEY_SOURCE,
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
import {
  getEmploymentInsuranceWorkplace,
  getAccidentInsuranceRate,
} from "./comwel_client.js";
import {
  searchFranchiseDisclosure,
  getFranchiseDisclosure,
  FTC_KEY_SOURCE,
} from "./ftc_client.js";
import {
  searchFranchiseHeadquarters,
  getFranchiseBrandStores,
} from "./ftc_data_client.js";
import {
  searchConstructionFirms,
  searchConstructionSanctions,
  getConstructionNoticeStats,
} from "./kiscon_client.js";
import {
  searchCalsConstruction,
  getCalsConstructionDetail,
  searchCalsContractor,
  searchCalsQualityTests,
  searchCalsProjectEvaluation,
  searchCalsRoadOccupancy,
  DETAIL_SECTION_NAMES,
  QUALITY_DATA_CUTOFF,
  CALS_KEY,
  CALS_KEY_SOURCE,
} from "./cals_client.js";
import {
  scanArchPermits,
  searchArchPermits,
  getArchPermitDetail,
  searchArchAuxRegisters,
  DETAIL_SECTIONS,
  AUX_KINDS,
  ARCHHUB_DATA_LAG,
  TOTAL_BJDONG,
} from "./archhub_client.js";
import { registerHousingTools } from "./housing_client.js";

import {
  searchScsbidWinners,
  getOpengResult,
  BIZ_TYPE_NAMES,
  RANGE_LIMIT_DAYS,
} from "./scsbid_client.js";

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
      "조회합니다. 인증키가 어느 환경변수명으로 읽혔는지(keySource)와 설정 여부도 함께 " +
      "반환하므로, 조회가 전부 실패할 때 키 누락인지 확인하는 용도로 쓸 수 있습니다 " +
      "(키 값 자체는 반환하지 않습니다).",
    {},
    async () => {
      const text = JSON.stringify(
        {
          agencies: AGENCY_LIST,
          defaultKeywords: DEFAULT_KEYWORDS,
          nowKst: nowKstStr(),
          keySource: SERVICE_KEY_SOURCE,
          keyConfigured: SERVICE_KEY.length > 0,
          // 공정위 가맹사업 정보제공시스템은 별도 포털이라 인증키도 별개다.
          ftcKeySource: FTC_KEY_SOURCE,
          ftcKeyConfigured: FTC_KEY_SOURCE !== "미설정",
          // 건설CALS(calspia.go.kr)도 별도 포털·별도 키다.
          calsKeySource: CALS_KEY_SOURCE,
          calsKeyConfigured: CALS_KEY.length > 0,
          calsQualityDataCutoff: QUALITY_DATA_CUTOFF,
        },
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
      companyName: z
        .string()
        .optional()
        .describe(
          "회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 법인 단위로 정확히 좁힙니다" +
            "(실측: itemName=\"우루사\" 단독 10건에는 대웅바이오 제품이 섞이고, 대웅제약 법인으로 좁히면 9건). " +
            "해석에 실패하면 업체명 부분검색으로 자동 폴백하며, 어느 경로를 탔는지는 응답의 resolution에 담깁니다. " +
            "bizrno를 직접 넣으면 이 값은 무시됩니다"
        ),
      bizrno: z.string().optional().describe("사업자등록번호 10자리"),
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
      companyName: z.string().optional().describe("회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 법인 단위로 정확히 좁힙니다(실측: entpName=\"대웅\" 567건 vs 대웅제약 법인 244건). 해석에 실패하면 업체명 부분검색으로 자동 폴백하며, 어느 경로를 탔는지는 응답의 resolution에 담깁니다. bizrno를 직접 넣으면 이 값은 무시됩니다"),
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
      entpName: z.string().optional().describe("업체명 부분검색 (예: 안국약품)"),
      companyName: z.string().optional().describe("회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 법인 단위로 정확히 좁힙니다(실측: entpName=\"대웅\" 567건 vs 대웅제약 법인 244건). 해석에 실패하면 업체명 부분검색으로 자동 폴백하며, 어느 경로를 탔는지는 응답의 resolution에 담깁니다. bizrno를 직접 넣으면 이 값은 무시됩니다"),
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
      companyName: z.string().optional().describe("회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 법인 단위로 정확히 좁힙니다(실측: entpName=\"대웅\" 567건 vs 대웅제약 법인 244건). 해석에 실패하면 업체명 부분검색으로 자동 폴백하며, 어느 경로를 탔는지는 응답의 resolution에 담깁니다. bizrno를 직접 넣으면 이 값은 무시됩니다"),
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
      "★ 이 서비스는 오퍼레이션이 둘이고 업체명 검색은 목록조회에서만 동작하므로, entpName을 " +
      "주면 서버가 목록조회로 좁힌 뒤 신고번호로 상세를 자동 병합합니다(응답의 searchedVia로 확인). " +
      "상세 병합은 20건까지만 수행하며, 그보다 많으면 totalCount로 전체 규모를 확인하세요. " +
      "목록 4개 필드(업체명·제품명·신고번호·등록일)만 빠르게 훑고 싶으면 detail=false를 주세요. " +
      "★ **이 도구는 회사를 법인 단위로 좁힐 수 없습니다** — 건강기능식품 원 API에는 사업자등록번호 " +
      "파라미터가 아예 없기 때문입니다. 의약품 3개 도구(search_pill_identification 등)의 companyName은 " +
      "사업자등록번호를 자동 해석해 법인 단위로 정확히 좁히지만, 여기서는 업체명 부분검색이 한계라 " +
      "계열사·동명 업체가 섞일 수 있습니다. 응답의 resolution에 그 사실이 담기니 답변에도 옮기세요.",
    {
      productName: z.string().optional().describe("제품명 부분검색 (예: 콘드로이친, 유산균)"),
      entpName: z.string().optional().describe("업체명 부분검색 (예: 일동, 광동헬스바이오)"),
      companyName: z.string().optional().describe("entpName과 동일하게 동작합니다(업체명 부분검색). 이 도구는 사업자등록번호를 지원하지 않아 법인 단위 정확검색이 불가능하므로, 의약품 도구의 companyName과 달리 자동 해석이 일어나지 않습니다 — 앞으로는 entpName을 쓰세요"),
      statementNo: z.string().optional().describe("신고번호 (예: 20140017002183)"),
      detail: z.boolean().optional().describe("업체명을 준 경우에만 의미 있음. false면 기능성·성상 등 상세 병합을 생략하고 목록 4개 필드만 반환 (기본 true)"),
      limit: z.number().int().min(1).max(100).optional().describe("최대 건수 (기본 10)"),
    },
    async (args) => {
      const result = await searchHealthFood(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_employment_insurance_workplace",
    "근로복지공단 **고용·산재보험 가입 사업장**의 상시인원·업종·보험 성립일자를 조회합니다. " +
      "비상장사 임직원 규모를 확인하는 두 원자료 중 하나이며, 국민연금 가입자수를 함께 조회해 " +
      "교차검증까지 한 번에 돌려줍니다(includePension 기본 true). " +
      "★ 이 API의 검색 키는 사업자등록번호 10자리 완전일치 하나뿐이고 사업장명 검색이 아예 " +
      "불가능합니다. companyName만 주면 서버가 DART 고유번호 인덱스 → 기업개황(bizr_no) 경로로 " +
      "10자리를 자동 확보하며, 어느 경로를 탔는지 resolution.resolvedVia에 남깁니다. " +
      "DART 미등록 비상장사는 10자리를 얻을 경로가 없어 근로복지공단 조회가 원천 불가하므로 " +
      "이때는 국민연금 결과만 돌아옵니다 — 이 경우를 '미가입'으로 읽지 마세요(미조회입니다). " +
      "★ 응답에 기준시점 필드가 없어 상시인원이 언제 기준인지 알 수 없습니다. 단독 인용하지 말고 " +
      "caveats를 그대로 답변에 옮기세요. 한 사업장이 산재·고용 두 행으로 나뉘어 나오며 인원이 " +
      "서로 다를 수 있습니다(실측 포니링크 산재 131 / 고용 133 / 국민연금 75 / DART 96).",
    {
      companyName: z
        .string()
        .optional()
        .describe("회사명. 법인격 표기(주식회사·(주))와 공백은 자동 제거해 대조합니다. bizNo가 없으면 이 값으로 사업자등록번호를 해석합니다"),
      bizNo: z
        .string()
        .optional()
        .describe("사업자등록번호 10자리(하이픈 무관). 알고 있으면 이 값을 주는 것이 가장 정확합니다. 부분일치는 지원되지 않아 앞 6자리로는 0건이 납니다"),
      insurance: z
        .enum(["전체", "산재", "고용"])
        .optional()
        .describe("조회할 보험 구분 (기본 전체 — 산재·고용 두 행을 모두 반환)"),
      includePension: z
        .boolean()
        .optional()
        .describe("국민연금 가입자수를 함께 조회해 교차검증 (기본 true)"),
      pensionMonths: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("국민연금 월별 추이를 몇 개월치 가져올지 (기본 3, 최대 12 — 국민연금은 1년치만 제공)"),
    },
    async (args) => {
      const result = await getEmploymentInsuranceWorkplace(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_accident_insurance_rate",
    "근로복지공단 **사업종류별 산재보험요율표**를 조회합니다. 업종명 부분검색(keyword) 또는 " +
      "산재업종코드(industryCode)로 좁힐 수 있고, 생략하면 해당 연도 전체 업종을 반환합니다. " +
      "원 API는 1962년부터 누적 반환되므로 서버가 기본적으로 최신 연도만 걸러 줍니다(year로 지정 가능). " +
      "★ 요율은 **천분율**입니다 — 8이면 0.8%이며, 백분율로 읽으면 10배 틀립니다(요율_퍼센트 필드에 " +
      "변환값을 함께 담습니다). ★ 이 표에는 **출퇴근재해 요율이 포함되어 있지 않습니다.** 실제 부담 " +
      "요율은 여기에 그 해 고용노동부가 별도 고시한 출퇴근재해 요율을 더한 값이므로, 언론의 '평균 " +
      "산재보험료율'과 직접 비교하지 마세요. 특정 회사의 산재업종코드는 " +
      "get_employment_insurance_workplace의 산재업종코드 필드에서 얻을 수 있습니다.",
    {
      keyword: z.string().optional().describe("업종명 부분검색 (예: 도소매, 소프트웨어, 건설)"),
      industryCode: z.string().optional().describe("산재업종코드 5자리 (예: 91001)"),
      year: z.string().optional().describe("적용연도 4자리. 생략 시 제공되는 최신 연도"),
      limit: z.number().int().min(1).max(300).optional().describe("최대 반환 업종 수 (기본 300)"),
    },
    async (args) => {
      const result = await getAccidentInsuranceRate(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_franchise_disclosure",
    "공정거래위원회 **가맹사업 정보공개서 공개본 목록**을 조회합니다. 프랜차이즈 가맹본부의 " +
      "회사명(corpNm)·브랜드명(brandNm)·사업자등록번호(brno)·정보공개서 일련번호(jngIfrmpSn)를 " +
      "반환하며, 이 일련번호를 get_franchise_disclosure에 넣으면 재무제표·가맹점 수·가맹점 평균 " +
      "매출액·임직원 수·법 위반 사실까지 담긴 정보공개서 본문을 볼 수 있습니다. " +
      "★ **기준년도(year)는 필수**입니다 — 정보공개서가 공개된 연도 기준이라 대부분의 가맹본부는 " +
      "가장 최근 연도에 몰려 있고, 갱신이 늦은 곳은 이전 연도에 남아 있습니다. 한 해에서 못 찾으면 " +
      "인접 연도도 확인하세요. " +
      "★ **원 API에는 회사명·브랜드명·업종 필터가 규격 자체에 없습니다.** 이름을 파라미터로 넣어도 " +
      "에러 없이 전체가 돌아오는 '조용한 실패'가 나므로, 이 서버는 해당 연도 전량을 한 번에 받아 " +
      "서버에서 걸러 줍니다(응답의 filteredLocally=true). 그래서 첫 호출은 몇 초 걸릴 수 있습니다. " +
      "★ companyName을 주면 DART 인덱스로 사업자등록번호를 자동 해석해 brno 완전일치로 좁힙니다 — " +
      "가맹본부명이 정보공개서에 등록된 표기와 달라도 잡히고, 어느 경로를 탔는지는 resolution에 담깁니다. " +
      "한 가맹본부가 브랜드마다 정보공개서를 따로 등록하므로 같은 brno가 여러 건 나오는 것이 정상입니다.",
    {
      year: z
        .union([z.string(), z.number()])
        .describe("기준년도 4자리 (필수). 예: 2025. 정보공개서가 공개된 연도 기준"),
      companyName: z
        .string()
        .optional()
        .describe(
          "가맹본부 회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 brno 완전일치로 좁힙니다. " +
            "해석에 실패하면 가맹본부명 부분검색으로 자동 폴백하며 resolution에 그 사실이 담깁니다"
        ),
      bizNo: z
        .string()
        .optional()
        .describe("사업자등록번호 10자리. 주면 companyName 자동해석을 건너뛰고 이 값으로 완전일치 검색합니다"),
      corpName: z.string().optional().describe("가맹본부명 부분검색(자동해석 없이 이름 그대로 매칭)"),
      brandName: z.string().optional().describe("브랜드명 부분검색 (예: 교촌, 메가커피)"),
      pageNo: z.number().int().min(1).optional().describe("필터를 주지 않았을 때의 페이지 번호 (기본 1)"),
      numOfRows: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe("필터를 주지 않았을 때의 페이지당 건수 (기본 100)"),
      limit: z.number().int().min(1).max(300).optional().describe("최대 반환 건수 (기본 50)"),
    },
    async (args) => {
      const result = await searchFranchiseDisclosure(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_franchise_disclosure",
    "공정거래위원회 **가맹사업 정보공개서 본문**을 조회합니다. 정보공개서는 100개 안팎의 절로 " +
      "이루어진 법정 공시자료로, 가맹본부 설립일·특수관계인·인수합병 내역·직전 3개 사업연도 " +
      "재무상태표와 손익계산서·가맹사업 매출액·임원 명단·임직원 수·가맹점 및 직영점 수·**가맹점사업자 " +
      "연간 평균 매출액**·평균 영업기간·최초 가맹금·광고판촉 지출·공정위 시정조치와 민사소송·형의 선고까지 " +
      "담고 있습니다. 비상장 프랜차이즈 기업을 실사할 때 DART로는 얻을 수 없는 원자료입니다. " +
      "★ **모든 절을 조회할 수 있습니다.** mode로 무엇을 돌려받을지 고르세요 — " +
      "core(기본, 재무·가맹점수·평균매출 등 핵심 절), toc(목차만), section(지정한 절의 전문), " +
      "keyword(**본문 전체를 검색**해 해당 단어가 나온 절만), full(전문). " +
      "core로 부족하면 곧바로 toc로 목차를 보고 section이나 keyword로 다시 부르면 됩니다. " +
      "★ 정보공개서는 **등록 시점의 자료**라 최신 실적과 다를 수 있으니, 답변에 조회한 기준년도를 " +
      "반드시 함께 밝히세요. jngIfrmpSn은 search_franchise_disclosure로 먼저 확보하세요.",
    {
      jngIfrmpSn: z
        .union([z.string(), z.number()])
        .describe("정보공개서 일련번호 (필수). search_franchise_disclosure의 응답에서 얻습니다"),
      mode: z
        .enum(["core", "toc", "section", "keyword", "full"])
        .optional()
        .describe(
          "core=핵심 절만(기본) / toc=목차만 / section=지정한 절 전문 / keyword=본문 전체 검색 / full=전문"
        ),
      section: z
        .string()
        .optional()
        .describe(
          'mode="section"에서 사용. 절 제목 일부(예: "재무", "가맹점 수") 또는 attr 코드' +
            '(예: RB_TTYR_FNNR_STUS, RB_BIZ_YR_FYER_AVRG_SLS_AMT)'
        ),
      keyword: z
        .string()
        .optional()
        .describe('mode="keyword"에서 사용. 본문 전체를 훑어 이 단어가 나온 절만 반환 (예: 위약금, 리뉴얼)'),
      maxChars: z
        .number()
        .int()
        .min(2000)
        .max(200000)
        .optional()
        .describe("반환 본문 글자수 상한 (기본 60000). 잘리면 truncatedAt에 어느 절부터 잘렸는지 담깁니다"),
    },
    async (args) => {
      const result = await getFranchiseDisclosure(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_franchise_headquarters",
    "공정거래위원회 **가맹본부 등록부**를 조회합니다. 상호명·사업자등록번호·법인등록번호·대표자· " +
      "사업자등록일·법인설립일·소재지·기업규모·계열사 수와, 그 가맹본부가 운영하는 **브랜드 목록** " +
      "(브랜드명·업종·주요상품·가맹사업개시일), 그리고 **재무(자산·자본·부채·매출액·영업이익· " +
      "당기순이익)** 를 한 번에 돌려줍니다. 프랜차이즈 기업을 실사하거나 제휴·인수 후보를 볼 때 " +
      "DART에 공시가 없는 비상장 가맹본부까지 확인할 수 있습니다. " +
      "★ **정보공개서 API(search_franchise_disclosure)와 커버리지가 다릅니다.** 그쪽은 공개에 " +
      "동의한 '공개본'만 담아 교촌·투썸 같은 대형 프랜차이즈가 빠지지만, 이 도구는 **전체 " +
      "가맹본부 등록부**라 빠짐이 없습니다. 회사 존재 여부·규모 확인은 이 도구를 먼저 쓰고, " +
      "정확한 재무제표·가맹점 평균매출액·법 위반 이력이 필요할 때 정보공개서로 넘어가세요. " +
      "★ **재무는 구간값입니다** — 공정위가 '4300~4800억원' 식으로만 공개하므로 정확한 금액이 " +
      "아닙니다. 정확한 수치가 필요하면 DART나 정보공개서 본문을 쓰세요. " +
      "★ year(기준년도)는 필수이고, 회계연도는 보통 그보다 1년 앞섭니다 — 답변에 둘 다 밝히세요. " +
      "companyName을 주면 DART 인덱스로 사업자등록번호를 해석해 정확히 좁히고, 실패하면 상호명 " +
      "부분검색으로 폴백하며 그 사실을 resolution에 담습니다.",
    {
      year: z
        .union([z.string(), z.number()])
        .describe("가맹사업 기준년도 4자리 (필수). 예: 2025. 회계연도는 보통 이보다 1년 앞섭니다"),
      companyName: z
        .string()
        .optional()
        .describe("가맹본부 회사명. 사업자등록번호를 자동 해석해 정확히 좁힙니다(실패 시 상호명 부분검색으로 폴백)"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리. 주면 companyName 자동해석을 건너뜁니다"),
      corpName: z.string().optional().describe("가맹본부 상호명 부분검색(자동해석 없이 이름 그대로 매칭)"),
      includeFinance: z.boolean().optional().describe("재무 구간값을 함께 조회 (기본 true)"),
      includeBrands: z.boolean().optional().describe("운영 브랜드 목록을 함께 조회 (기본 true)"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 반환 가맹본부 수 (기본 10)"),
    },
    async (args) => {
      const result = await searchFranchiseHeadquarters(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_franchise_brand_stores",
    "공정거래위원회 가맹정보에서 **브랜드별·지역별 가맹점/직영점 수**를 조회합니다. 17개 시도별 " +
      "분포와 합계를 돌려주므로, 프랜차이즈 브랜드의 실제 점포 규모와 지역 편중을 볼 수 있습니다. " +
      "★ 원 API는 **브랜드관리번호(brandMnno)로만** 좁혀집니다. 브랜드명이나 회사명을 주면 서버가 " +
      "브랜드 목록에서 관리번호를 먼저 찾아 연결하므로, 관리번호를 몰라도 됩니다. 한 가맹본부가 " +
      "브랜드를 여러 개 운영하면 브랜드마다 한 건씩 나옵니다. " +
      "★ 원 응답의 지역 목록에는 '전체' 행이 섞여 있어 그대로 더하면 정확히 두 배가 됩니다 — " +
      "서버가 분리해 합계로 따로 담으니, 지역별 수치를 다시 합산하지 마세요. " +
      "★ 수치는 **회계연도 말 기준**이고 기준년도보다 보통 1년 앞섭니다 — 답변에 회계연도를 " +
      "반드시 밝히세요. 0건은 '가맹사업을 하지 않는다'는 뜻이 아니라 그 기준년도에 등록이 없다는 " +
      "뜻이므로 인접 연도도 확인하세요.",
    {
      year: z
        .union([z.string(), z.number()])
        .describe("가맹사업 기준년도 4자리 (필수). 예: 2025"),
      brandMnno: z.string().optional().describe("브랜드관리번호 (예: BRD_20080600002). 알고 있으면 가장 정확합니다"),
      brandName: z.string().optional().describe("브랜드명 부분검색 (예: 교촌치킨, 메가커피)"),
      companyName: z
        .string()
        .optional()
        .describe("가맹본부 회사명. 그 회사가 운영하는 브랜드를 모두 찾아 각각의 점포현황을 반환합니다"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 반환 브랜드 수 (기본 20)"),
    },
    async (args) => {
      const result = await getFranchiseBrandStores(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_construction_firms",
    "국토교통부 키스콘(KISCON) **건설업체 등록·변동 공시**를 조회합니다. 건설업 신규등록·등록기준사항 " +
      "신고·양도신고·법인합병 신고·상속신고 5종을 한 번에 훑어 업체명·**사업자등록번호**·대표자·업종· " +
      "등록번호·소재지·연락처·공시일을 돌려줍니다. 건설 분야 신규 고객사 발굴이나 거래처 실체 확인에 " +
      "씁니다. " +
      "★ **기간 기반 조회입니다** — sDate·eDate(YYYYMMDD)가 필수이고 2003-01-01 이후 공시분을 " +
      "제공합니다. 원 API에 업체명·사업자등록번호 검색 파라미터가 없어(넣어도 에러 없이 전체가 " +
      "돌아옵니다) 기간 전량을 받아 서버에서 거릅니다. 동작하는 원 API 필터는 지역(area·areaDetail)뿐입니다. " +
      "★ **0건을 '그런 업체가 없다'로 답하지 마세요.** 조회한 기간에 공시가 없었다는 뜻일 뿐입니다. " +
      "특정 회사를 찾는 것이 목적이면 기간을 넓혀 재조회하고, 답변에는 확인한 기간을 반드시 밝히세요. " +
      "★ **sDate~eDate 간격은 2년 이내로 잡으세요.** 원 API는 요청 하나에 20~40초가 걸려(행 수와 " +
      "거의 무관한 서버측 조회시간) 그보다 긴 기간은 응답 제한시간을 넘깁니다. 실측: 2년(약 25,000행)은 " +
      "정상, 4년은 타임아웃. 더 긴 이력이 필요하면 2년 단위로 나눠 여러 번 호출하고 ncrGsSeq로 합집합하세요. " +
      "★★ **여러 번 나눠 호출한 결과의 집계값을 더하지 마세요.** 구간 경계 공시가 양쪽에 들어와 " +
      "부풀려집니다 — 실측으로 2년치를 8분할해 합산했더니 건수 +0.42%, 과징금 총액 +3.22%(6.7억원) " +
      "과대 집계됐습니다. 부득이 합산했다면 '경계 중복이 포함된 근사치'임을 답변에 반드시 밝히세요. " +
      "잘림=true면 시간 제한으로 다 받지 못한 것이니 같은 원칙이 적용됩니다. " +
      "★ 같은 공시 1건이 보유 업종 수만큼 행으로 반복됩니다. 건수는 **조건일치_건수**(공시 고유)를 쓰고 " +
      "조건일치_행수를 건수로 보고하지 마세요. " +
      "행정처분·폐업 이력은 search_construction_sanctions를 쓰세요.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수). 예: 20260101"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수). 예: 20260826"),
      kinds: z
        .array(z.enum(["reg", "renew", "trans", "union", "inheri"]))
        .optional()
        .describe("조회할 공시 종류. reg=신규등록 renew=등록기준사항신고 trans=양도 union=법인합병 inheri=상속 (기본 전부)"),
      area: z.string().optional().describe("등록 시도 (예: 서울, 경기, 부산, 전남광주). 원 API가 지원하는 필터"),
      areaDetail: z.string().optional().describe("등록 시군구 (예: 강남구, 성남시)"),
      companyName: z.string().optional().describe("업체명. 사업자등록번호를 자동 해석해 정확히 좁히고, 실패하면 업체명 부분검색으로 폴백합니다"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리"),
      itemName: z.string().optional().describe("업종 부분검색 (예: 실내건축, 지반조성, 전기)"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(10).optional().describe(
        "오퍼레이션당 최대 페이지(10,000행 단위, 기본 3). 원 API가 한 요청당 20~40초라 이 값을 올리면 " +
          "응답 제한시간을 넘길 수 있습니다. 더 긴 기간이 필요하면 기간을 나눠 여러 번 호출하세요"
      ),
    },
    async (args) => {
      const result = await searchConstructionFirms(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_construction_sanctions",
    "국토교통부 키스콘(KISCON) **건설업체 행정처분·가처분·폐업 공시**를 조회합니다. 협력사·하도급사· " +
      "인수 후보의 법규 위반 이력을 확인하는 용도입니다. 처분명(영업정지·과징금·과태료·시정명령· " +
      "등록말소), **위반내용과 근거조문**(예: 건설산업기본법 제82조제2항제3호), 처분사유 전문, " +
      "**과징금·과태료 금액(원)**, 영업정지 기간, 가처분 여부, 취소일까지 나옵니다. " +
      "위반내용별 집계는 상위 몇 개가 아니라 **전량**을 돌려주므로 그대로 인용하면 됩니다(2년치 기준 80종 이상). " +
      "★ **기간 기반 조회입니다** — sDate·eDate(YYYYMMDD)가 필수입니다. 원 API에 업체명·사업자등록번호 " +
      "검색 파라미터가 없어 기간 전량을 받아 서버에서 거릅니다. " +
      "★ **0건을 '처분 이력이 없다'로 절대 답하지 마세요.** 조회한 기간에 공시가 없었다는 뜻일 뿐이며, " +
      "실사 목적이라면 기간을 수년 단위로 넓혀 재조회해야 합니다. " +
      "★ **sDate~eDate 간격은 2년 이내로 잡으세요.** 원 API는 요청 하나에 20~40초가 걸려(행 수와 " +
      "거의 무관한 서버측 조회시간) 그보다 긴 기간은 응답 제한시간을 넘깁니다. 실측: 2년(약 25,000행)은 " +
      "정상, 4년은 타임아웃. 더 긴 이력이 필요하면 2년 단위로 나눠 여러 번 호출하고 ncrGsSeq로 합집합하세요. " +
      "★★ **여러 번 나눠 호출한 결과의 집계값을 더하지 마세요.** 구간 경계 공시가 양쪽에 들어와 " +
      "부풀려집니다 — 실측으로 2년치를 8분할해 합산했더니 건수 +0.42%, 과징금 총액 +3.22%(6.7억원) " +
      "과대 집계됐습니다. 부득이 합산했다면 '경계 중복이 포함된 근사치'임을 답변에 반드시 밝히세요. " +
      "잘림=true면 시간 제한으로 다 받지 못한 것이니 같은 원칙이 적용됩니다. " +
      "★ 같은 처분 1건이 보유 업종 수만큼 행으로 반복됩니다. 건수는 **조건일치_건수**를 쓰고, " +
      "처분유형별·위반내용_상위·금액합계_원은 이미 고유 기준으로 집계된 값이니 그대로 인용하세요. " +
      "답변에는 확인한 기간을 반드시 밝히세요. 가처분(ncrPdStatus=Y)이 걸린 건은 처분 효력이 정지 중일 수 있습니다.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수)"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수)"),
      kinds: z
        .array(z.enum(["admi", "admiPD", "cess"]))
        .optional()
        .describe("admi=행정처분 admiPD=행정처분 가처분 cess=폐업신고 (기본 전부)"),
      area: z.string().optional().describe("등록 시도 (예: 서울, 경기)"),
      areaDetail: z.string().optional().describe("등록 시군구"),
      companyName: z.string().optional().describe("업체명. 사업자등록번호를 자동 해석해 정확히 좁힙니다"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리"),
      itemName: z.string().optional().describe("업종 부분검색"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(10).optional().describe(
        "오퍼레이션당 최대 페이지(10,000행 단위, 기본 3). 원 API가 한 요청당 20~40초라 이 값을 올리면 " +
          "응답 제한시간을 넘길 수 있습니다. 더 긴 기간이 필요하면 기간을 나눠 여러 번 호출하세요"
      ),
    },
    async (args) => {
      const result = await searchConstructionSanctions(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_construction_notice_stats",
    "국토교통부 키스콘(KISCON) **건설공사대장 통보 통계**를 조회합니다. 일자 × 지역 × 발주구분" +
      "(공공/민간법인/민간개인) × 도급구분(원도급/하도급)으로 집계된 **통보 건수와 금액**을 서버가 " +
      "결합해 돌려줍니다(원 API는 건수·금액이 별도 오퍼레이션). 건설시장의 공공/민간 비중, 하도급 " +
      "비중, 지역별 물량 추이를 보는 데 씁니다. groupBy로 발주구분·지역·도급구분·일자 중 집계 축을 " +
      "고릅니다. " +
      "★ 원 응답에는 지역 '전체'·발주구분 '전체' 합계 행이 실제 항목과 같은 배열에 섞여 있어 그대로 " +
      "더하면 중복 계상됩니다 — 서버가 제외하고 집계하므로 **반환된 집계값을 다시 합산하지 마세요.** " +
      "★ **금액 단위는 억원으로 판단됩니다** — 원 명세에는 표기가 없으나 통보 대상이 도급금액 1억원 " +
      "이상(건설산업기본법 시행령 제26조제1항)인데 실측 건당 평균이 4.4로 나와 다른 단위로는 " +
      "성립하지 않습니다. 명세로 확인된 값은 아니므로 대외 인용 시 근거를 함께 밝히세요. " +
      "★ 지역·발주구분·도급구분은 **원 API가 서버에서 걸러 주는 진짜 필터**입니다(시도명·구분명을 " +
      "그대로 넣으면 서버가 코드로 바꿔 전달합니다). 조회 범위를 좁힐수록 응답이 가볍습니다. " +
      "★ 이 통계는 **2020-07-15부터** 제공됩니다 — 건설업체정보(2003-01-01~)와 시작일이 다릅니다.",
    {
      sDate: z.string().describe("조회 시작일 YYYYMMDD (필수). 이 통계는 2020-07-15부터 제공됩니다"),
      eDate: z.string().describe("조회 종료일 YYYYMMDD (필수). 기간이 길수록 원본 행이 급격히 늘어납니다"),
      area: z
        .string()
        .optional()
        .describe("지역 필터. 시도명(서울·부산·경기 등) 또는 코드. 원 API가 서버에서 걸러 줍니다"),
      balju: z
        .string()
        .optional()
        .describe("발주구분 필터: 공공 / 민간(법인) / 민간(개인). 원 API가 서버에서 걸러 줍니다"),
      dogub: z
        .string()
        .optional()
        .describe("도급구분 필터: 원도급 / 하도급. 원 API가 서버에서 걸러 줍니다"),
      groupBy: z
        .enum(["balju", "area", "dogub", "date"])
        .optional()
        .describe("집계 축: balju=발주구분(기본) area=지역 dogub=도급구분 date=일자"),
      maxPages: z.number().int().min(1).max(20).optional().describe("오퍼레이션당 최대 페이지(5,000행 단위, 기본 10)"),
    },
    async (args) => {
      const result = await getConstructionNoticeStats(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── 국토교통부 건설CALS (calspia.go.kr) ──────────────────────────────────
  server.tool(
    "search_cals_construction",
    "국토교통부 **건설CALS 공사정보**를 검색합니다. 공사명·현장번호·발주기관·사업분야·노선/하천·" +
      "행정구역·착공일·준공(예정)일이 나옵니다. 여기서 얻은 **현장번호(sptNo)** 를 " +
      "get_cals_construction_detail에 넣어 상세로 들어갑니다. " +
      "★ **데이터 범위가 좁습니다** — 국토교통부 5개 지방국토관리청(서울·원주·대전·익산·부산) " +
      "발주 공사만 담겨 있습니다(실측 1,362건). 민간 건축공사, 지자체·LH·공사·공단 발주분은 " +
      "**여기에 아예 없습니다.** '전국 건설현장 현황'으로 확대해석하지 마세요. " +
      "★ status는 전체(기본)/진행/준공이며 **모집단이 서로 다릅니다.** 전체 목록은 1,362건" +
      "(진행 141 + 완료 1,221)인데 진행 상세검색은 140건, 준공 상세검색은 254건뿐입니다 — " +
      "상세검색 2종은 전체의 부분집합이라 건수를 총수로 인용하면 틀립니다. 폭넓게 보려면 " +
      "status=전체에 progress로 진행/완료를 거르세요(원 API의 준공여부 파라미터가 무시되므로 서버가 직접 거릅니다). " +
      "★ 상세검색(진행/준공)에서만 사업분야·행정구역·착공일·준공일 필터가 동작합니다.",
    {
      status: z.enum(["전체", "진행", "준공"]).optional().describe("조회할 오퍼레이션. 기본 전체"),
      progress: z.enum(["진행", "완료"]).optional().describe("status=전체일 때만 적용되는 진행/완료 필터"),
      cwkNm: z.string().optional().describe("공사명 부분검색"),
      orcd: z.string().optional().describe("발주기관 코드 (코드집 기준)"),
      bzarCd: z.string().optional().describe("사업분야 코드. status=진행/준공에서만 동작"),
      pdznNm: z.string().optional().describe("행정구역명. status=진행/준공에서만 동작"),
      stwrDt: z.string().optional().describe("착공일 조건. status=진행/준공에서만 동작"),
      ccwDt: z.string().optional().describe("준공일 조건. status=진행/준공에서만 동작"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsConstruction(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_cals_construction_detail",
    "건설CALS에서 **특정 현장(sptNo)의 상세정보**를 섹션별로 한 번에 가져옵니다. " +
      "연도별계약·집행금액·기성보고입찰·설계변경·설계변경내역·기성보고·월간공정과 " +
      "공사중인 시설물 7종(교량·터널·절개사면·통로박스·옹벽·수문·제방)을 고를 수 있습니다. " +
      "★ sptNo는 search_cals_construction으로 먼저 확보하세요. " +
      "★ 설계변경·설계변경내역·기성보고는 **차수(sptTo)** 가, 월간공정은 차수와 **보고연월(rprtYm, YYYYMM)** 이 " +
      "추가로 필요합니다. rprtYm 없이 월간공정을 요청하면 그 섹션만 안내와 함께 건너뜁니다. " +
      "★ 섹션이 0건이어도 오류가 아닙니다 — 그 현장에 해당 자료가 등록되지 않았다는 뜻입니다.",
    {
      sptNo: z.string().describe("현장번호 (필수). 예: C2023021"),
      sections: z
        .array(z.string())
        .optional()
        .describe(
          "가져올 섹션. 생략 시 연도별계약·설계변경·교량·터널. 사용 가능: " + DETAIL_SECTION_NAMES.join(", ")
        ),
      sptTo: z.string().optional().describe("차수. 설계변경·기성보고·월간공정에 필요 (기본 1)"),
      rprtYm: z.string().optional().describe("보고연월 YYYYMM. 월간공정 섹션에 필요"),
      limitPerSection: z.number().int().min(1).max(100).optional().describe("섹션당 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await getCalsConstructionDetail(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_contractor",
    "건설CALS **국토관리청 참여업체와 그 업체의 참여공사 이력**을 조회합니다. 업체명 또는 " +
      "사업자등록번호로 찾으면 대표자·대표공사와 함께 **참여공사 목록(공사명·발주기관·사업분야·" +
      "참여단계(시공/설계/감리)·지분율·도급액·준공여부·공사기간)** 이 나옵니다. 협력사·경쟁사·인수후보의 " +
      "공공공사 수행이력을 확인하는 용도입니다. " +
      "★ **명부가 좁습니다** — 국토교통부 5개 지방국토관리청 발주 공사의 참여업체 약 995개만 담겨 " +
      "있습니다. **0건을 '그런 업체가 없다'로 절대 답하지 마세요.** 민간공사나 지자체 공사만 수행한 " +
      "업체는 여기에 없는 것이 정상입니다. 그 경우 키스콘(search_construction_firms)으로 교차 확인하세요. " +
      "★ 참여이력은 1996년 준공 건까지 거슬러 올라갑니다 — 오래된 실적이 섞이므로 공사기간을 함께 보세요. " +
      "★ 원 API에 업체 검색 파라미터가 없어 명부 전량을 받아 서버에서 거릅니다((주)·주식회사 표기 차이는 무시합니다).",
    {
      companyName: z.string().optional().describe("업체명 부분검색. (주)·주식회사 표기 차이는 무시"),
      bizNo: z.string().optional().describe("사업자등록번호 10자리. 있으면 이쪽이 우선"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 업체 수 (기본 30)"),
    },
    async (args) => {
      const result = await searchCalsContractor(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_quality_tests",
    "건설CALS **건설자재 품질검사 등록정보**로 전국 건설현장을 추적합니다. 이 서버의 건설 도구 중 " +
      "**유일하게 전국을 덮는 현장 데이터**입니다(공사정보·참여업체는 국토관리청 한정). " +
      "공사명·**시공사명**·발주처·착공일·**준공예정일**이 함께 나와, 특정 건설사의 현장 목록을 뽑아 " +
      "준공예정일 기준으로 공정 진입 시점을 역산하는 데 씁니다. 서버가 현장 단위로 접어서 돌려줍니다" +
      "(같은 현장이 시험 건마다 반복되므로 행 수 ≠ 현장 수). " +
      "★★ **이 데이터는 " + QUALITY_DATA_CUTOFF + "에서 멈춰 있습니다.** 2025년·2026년 등록분이 전 시공사에 걸쳐 " +
      "0건입니다(연도별 자재 품질검사 실측: 2022년 237,629 / 2023년 245,067 / 2024년 142,387 / 2025년 0 / 2026년 0). " +
      "**신규 현장을 찾는 선행지표로 쓸 수 없습니다.** 고객사별 현장 이력·경쟁구도 분석 같은 후행 용도이며, " +
      "'현재 진행 중인 현장'이라고 답하면 틀립니다. 최신 현장이 필요하면 다른 소스를 쓰세요. " +
      "★ 경로가 둘입니다. **contractorName(시공사명)** 을 주면 성적서 등록 목록을 시공사 기준으로 조회하고" +
      "(대형 건설사도 잡힙니다 — 실측 2020~2026 누적: 포스코이앤씨 32,643 / 대우건설 31,256 / 현대건설 28,115 / " +
      "GS건설 17,141 / 삼성물산 11,765건), **year(연도)** 만 주면 자재 품질검사 등록정보를 조회합니다" +
      "(이쪽에는 시공사 필터가 없어 공사명·자재명으로 좁혀야 합니다). " +
      "★ 잘림=true면 수집한 행 안에서만 집계한 값입니다 — 고유현장수를 그 시공사의 전체 현장 수로 인용하지 마세요.",
    {
      contractorName: z.string().optional().describe("시공사명. 이 값을 주면 성적서 등록 목록 경로로 조회"),
      sDate: z.string().optional().describe("성적서 발급일 시작 YYYYMMDD (기본 20200101). contractorName 경로 전용"),
      eDate: z.string().optional().describe("성적서 발급일 종료 YYYYMMDD (기본 20241231). contractorName 경로 전용"),
      year: z.string().optional().describe("연도 YYYY. contractorName 없이 쓰면 자재 품질검사 등록정보 경로"),
      cwkNm: z.string().optional().describe("공사명 부분검색. year 경로 전용"),
      materialName: z.string().optional().describe("자재/검사기관명 부분검색"),
      permitNo: z.string().optional().describe("품질검사 허가번호. year 경로 전용"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 현장 수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsQualityTests(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_project_evaluation",
    "건설CALS **건설공사 사후평가**와 **설계VE(설계경제성 검토)** 를 조회합니다. 둘 다 **전국 공공발주기관** " +
      "대상이라 건설시장 구조와 발주처 동향을 보는 데 씁니다. " +
      "사후평가는 공사발주금액·준공일과 함께 **계획 대비 실제 수요, 공사비 증감률, 공기 증감률**을 주므로 " +
      "발주처별 사업 집행 정확도를 비교할 수 있습니다(실측 175개 발주기관: 국가철도공단·한국전력공사·" +
      "지자체 등, 유형은 도로·철도·항만·공항·수자원·기타). " +
      "설계VE는 총공사비·공사위치·VE단계·공사구분(토목/건축)을 주며 실측 184개 발주청입니다" +
      "(한국토지주택공사·국가철도공단·한국수자원공사 순). " +
      "★ 사후평가의 기간은 **YYYYMM(월 단위)** 입니다 — YYYYMMDD를 주면 파라미터 오류가 아니라 DB 오류로 " +
      "떨어지므로 서버가 앞 6자리로 잘라 쓰고 그 사실을 응답에 밝힙니다. " +
      "★ 사후평가는 **총사업비가 일정 규모 이상인 공사만** 대상이라 소규모 공사는 없습니다 — " +
      "0건을 '그런 사업이 없었다'로 읽지 마세요. " +
      "★ 설계VE의 총공사비 단위는 원 명세에 표기가 없어 확정하지 못했습니다(백만원으로 보임). 대외 인용 시 원 자료로 확인하세요.",
    {
      kind: z.enum(["사후평가", "설계VE"]).optional().describe("조회 대상 (기본 사후평가)"),
      sYm: z.string().optional().describe("사후평가 준공 시작년월 YYYYMM (기본 201001)"),
      eYm: z.string().optional().describe("사후평가 준공 종료년월 YYYYMM (기본 202612)"),
      orderOrgName: z.string().optional().describe("발주기관/발주청명 부분검색"),
      projectName: z.string().optional().describe("사업명 부분검색"),
      contractorName: z.string().optional().describe("시공사명 (사후평가 전용)"),
      bizTypeCd: z.string().optional().describe("사업유형 코드 (사후평가 전용)"),
      constClass: z.string().optional().describe("공사구분 (설계VE 전용)"),
      minAmt: z.string().optional().describe("최소 공사비 (설계VE 전용)"),
      maxAmt: z.string().optional().describe("최대 공사비 (설계VE 전용)"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsProjectEvaluation(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_cals_road_occupancy",
    "건설CALS **도로점용허가** 내역을 조회합니다. 허가기관·신청인·허가일·허가사유·허가번호가 나옵니다. " +
      "통신사·전력회사 등이 국도에 설비를 놓을 때 받는 허가라, 인프라 사업자의 지역별 공사 움직임을 " +
      "읽는 데 씁니다(실측 신청인 상위: LG유플러스·KT·SK텔레콤·SK브로드밴드·한전 및 지자체). " +
      "★ sDate·eDate(YYYYMMDD)가 필수인 **기간 조회**입니다. 0건은 그 기간에 허가가 없었다는 뜻일 뿐 " +
      "'그 회사가 점용허가를 받은 적 없다'가 아닙니다. " +
      "★ 원 API의 신청인·허가기관·허가번호 필터는 **조용히 무시되므로**(실측: 어떤 필터를 줘도 건수가 동일) " +
      "서버가 기간 전량을 받아 직접 거릅니다. 그래서 **잘림=true면 해당 신청인의 건이 더 있을 수 있습니다** — " +
      "이 경우 기간을 좁혀 다시 조회하세요. " +
      "★ 신청인 표기가 제각각입니다('(주)케이티', '주식회사 케이티', '(주)케이티 진천지점' 등). 서버가 " +
      "(주)·주식회사 표기를 무시하고 부분일치로 묶지만, 지사·지점명이 붙은 건은 별도 항목으로 보입니다. " +
      "★ 지방국토관리청이 관리하는 국도 등이 대상이며 지자체 관리 도로는 포함되지 않습니다.",
    {
      sDate: z.string().describe("허가일 시작 YYYYMMDD (필수)"),
      eDate: z.string().describe("허가일 종료 YYYYMMDD (필수)"),
      applicantName: z.string().optional().describe("신청인 부분검색. 서버가 직접 거릅니다"),
      orgName: z.string().optional().describe("허가기관 부분검색. 서버가 직접 거릅니다"),
      permitNo: z.string().optional().describe("허가번호 부분검색. 서버가 직접 거릅니다"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(5).optional().describe("최대 페이지(1,000행 단위, 기본 3)"),
    },
    async (args) => {
      const result = await searchCalsRoadOccupancy(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );


  // ── 국토교통부 건축HUB 건축인허가 (세움터) ───────────────────────────────
  server.tool(
    "scan_arch_permits",
    "국토교통부 **건축HUB 건축인허가**(세움터)를 지역 단위로 스캔해 신규 허가·착공 건을 찾습니다. " +
      "**민간 건축공사를 덮는 유일한 도구**입니다 — 건설CALS는 국토관리청 토목, 키스콘은 건설업체 " +
      "등록·처분이라 민간 건축현장이 없습니다. " +
      "대지위치·건물명·건축구분(신축/증축/대수선/용도변경)·주용도·연면적·세대수와 함께 " +
      "**건축허가일·착공예정일·실제착공일·사용승인일**이 나오므로, 후속 공정 진입 시점을 역산하는 데 씁니다. " +
      "★ **데이터가 최신입니다** — 실측 지연 " + ARCHHUB_DATA_LAG + ". 건설CALS 품질검사(2024-08-30 정지)와 달리 " +
      "선행지표로 쓸 수 있습니다. " +
      "★ **원 API는 법정동 단위 조회입니다.** 시군구만 주면 에러 없이 빈 결과가 옵니다(resultCode는 00). " +
      "region에 시군구명('강남구', '성남시 분당구')을 주면 서버가 법정동 목록을 해석해 순회합니다. " +
      "실측 강남구는 법정동 14개이고 **전국은 " + TOTAL_BJDONG.toLocaleString() + "개**입니다. " +
      "★★ **이 API는 페이지당 100행이 상한입니다** — numOfRows에 1,000을 줘도 에러 없이 100으로 깎여 돌아옵니다. 통계를 낼 목적이면 반드시 끝까지 페이징해서 전량을 받으세요(응답의 잘림 여부를 확인할 것). 잘린 100건은 무작위 표본이 아니라 원 API가 첫 페이지에 주는 순서대로의 100건이고 그 정렬 기준은 명세에 없으므로, 잘린 표본으로 중앙값·사분위를 내면 무엇의 통계인지 말할 수 없습니다. " + "★★ **일일 트래픽 10,000건입니다.** maxDongs로 순회 수를 조절하세요(기본 20). 전국 전수 스캔은 하루에 불가능하니 " +
      "관심 시군구를 좁혀 쓰세요. 응답의 지역해석.잘림=true면 그 시군구에 더 많은 법정동이 있다는 뜻입니다. " +
      "★★ **since·until은 건축허가일이 아니라 데이터 생성일(crtnDay) 기준입니다.** 실측에서 2026년 구간으로 " +
      "조회했더니 허가일 2007년 건이 섞여 나왔습니다. 허가일로 좁히려면 permitFrom·permitTo를 쓰세요.",
    {
      region: z.string().optional().describe("시군구명. 예: 강남구, 성남시 분당구. 서버가 법정동으로 해석해 순회"),
      sigunguCd: z.string().optional().describe("시군구코드 5자리. bjdongCds와 함께 쓸 때만"),
      bjdongCds: z.array(z.string()).optional().describe("법정동코드 5자리 배열. sigunguCd와 함께"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD (허가일이 아님)"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD (허가일이 아님)"),
      permitFrom: z.string().optional().describe("건축허가일 시작 YYYYMMDD. 서버가 직접 거릅니다"),
      permitTo: z.string().optional().describe("건축허가일 종료 YYYYMMDD. 서버가 직접 거릅니다"),
      archGb: z.string().optional().describe("건축구분 부분검색: 신축 / 증축 / 대수선 / 용도변경"),
      mainPurps: z.string().optional().describe("주용도 부분검색: 공동주택 / 업무시설 / 숙박시설 / 제2종근린생활시설 등"),
      minTotArea: z.number().optional().describe("최소 연면적(㎡). 규모 있는 현장만 볼 때"),
      stage: z.enum(["허가", "착공", "사용승인"]).optional().describe("허가=허가났고 미착공 / 착공=착공했고 미승인 / 사용승인=승인완료"),
      maxDongs: z.number().int().min(1).max(60).optional().describe("순회할 법정동 수 (기본 20). 트래픽과 응답시간에 직결"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 50)"),
    },
    async (args) => {
      const result = await scanArchPermits(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_arch_permits",
    "건축HUB 건축인허가를 **특정 법정동·지번**으로 조회합니다. 지역 전체가 아니라 아는 주소 한 곳을 " +
      "확인할 때 씁니다(지역 단위 발굴은 scan_arch_permits). 반환 필드는 scan_arch_permits와 같습니다. " +
      "★ sigunguCd(5자리)와 bjdongCd(5자리)가 **둘 다** 필요합니다. 시군구만 주면 원 API가 에러 없이 " +
      "빈 결과를 돌려줍니다. 법정동코드 10자리는 앞 5자리가 시군구, 뒤 5자리가 법정동입니다" +
      "(예: 1168010300 = 11680 강남구 + 10300 개포동). 코드를 모르면 scan_arch_permits에 region으로 시군구명을 주면 됩니다. " +
      "★ bun(번)·ji(지)를 주면 그 지번만 봅니다. 생략하면 그 법정동 전체입니다. " +
      "★ since·until은 데이터 생성일 기준이라 허가일과 다릅니다 — 허가일은 permitFrom·permitTo를 쓰세요. " +
      "★ 한 지번에 인허가 건이 여러 개 있는 것이 정상입니다(신축 후 용도변경, 증축 등). " +
      "관리번호(mgmPmsrgstPk)가 건별 식별자이며, 22자리라 숫자로 다루면 정밀도가 깨지므로 문자열로 돌려줍니다.",
    {
      sigunguCd: z.string().describe("시군구코드 5자리 (필수)"),
      bjdongCd: z.string().describe("법정동코드 5자리 (필수)"),
      bun: z.string().optional().describe("번. 4자리로 자동 zero-padding"),
      ji: z.string().optional().describe("지. 4자리로 자동 zero-padding"),
      platGbCd: z.string().optional().describe("대지구분 0:대지 1:산 2:블록"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD"),
      permitFrom: z.string().optional().describe("건축허가일 시작 YYYYMMDD"),
      permitTo: z.string().optional().describe("건축허가일 종료 YYYYMMDD"),
      archGb: z.string().optional().describe("건축구분 부분검색"),
      mainPurps: z.string().optional().describe("주용도 부분검색"),
      minTotArea: z.number().optional().describe("최소 연면적(㎡)"),
      stage: z.enum(["허가", "착공", "사용승인"]).optional().describe("진행 단계 필터"),
      limit: z.number().int().min(1).max(200).optional().describe("최대 반환 건수 (기본 30)"),
      maxPages: z.number().int().min(1).max(200).optional().describe("최대 페이지. 이 API는 **페이지당 100행이 상한**이라(numOfRows를 크게 줘도 100으로 깎임) 전량이 필요하면 넉넉히 주세요. 기본 20"),
    },
    async (args) => {
      const result = await searchArchPermits(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_arch_permit_detail",
    "건축HUB 건축인허가의 **상세정보를 섹션별로** 가져옵니다. 동별개요(주용도·구조·호수·세대수)· " +
      "층별개요·호별개요·전유공용면적·호별전유공용면적·주차장·부설주차장·주택유형·지역지구구역· " +
      "도로명대장·대지위치 중에서 고릅니다. 설비 물량을 가늠할 때 동별개요와 주택유형이 특히 유용합니다. " +
      "★ **원 API는 관리번호가 아니라 주소로 조회합니다.** scan_arch_permits / search_arch_permits 결과의 " +
      "시군구코드·법정동코드·번·지를 그대로 넘기세요. 한 지번에 여러 인허가 건이 섞여 나오므로 특정 건만 " +
      "보려면 mgmPmsrgstPk를 함께 주세요 — 서버가 받은 뒤 거릅니다(이 경우 건수는 필터 후 값입니다). " +
      "★ 섹션이 0건이어도 오류가 아닙니다. 그 건축물에 해당 자료가 없다는 뜻입니다.",
    {
      sigunguCd: z.string().describe("시군구코드 5자리 (필수)"),
      bjdongCd: z.string().describe("법정동코드 5자리 (필수)"),
      bun: z.string().optional().describe("번"),
      ji: z.string().optional().describe("지"),
      platGbCd: z.string().optional().describe("대지구분"),
      sections: z
        .array(z.string())
        .optional()
        .describe("가져올 섹션. 생략 시 동별개요·층별개요·주차장·주택유형. 사용 가능: " + DETAIL_SECTIONS.join(", ")),
      mgmPmsrgstPk: z.string().optional().describe("관리번호. 주면 그 건만 남깁니다(문자열로 주세요)"),
      limitPerSection: z.number().int().min(1).max(100).optional().describe("섹션당 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await getArchPermitDetail(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_arch_aux_registers",
    "건축HUB의 **철거멸실·대수선·가설건축물·공작물·오수정화시설** 대장을 조회합니다. " +
      "특히 **철거멸실은 재건축·재개발의 선행지표**입니다 — 멸실 신고 뒤에 신축 인허가가 따라오므로, " +
      "scan_arch_permits보다 한 단계 앞선 시점에 지역의 개발 움직임을 잡을 수 있습니다. " +
      "철거멸실은 철거/멸실 구분, 착수·완료일, 연면적, 건축물 수, 주용도, 석면 함유 여부를 제공합니다. " +
      "★ 이 API도 **법정동 단위 조회**입니다. region에 시군구명을 주면 서버가 법정동을 해석해 순회하고, " +
      "maxDongs로 순회 수를 조절합니다(기본 10). 일일 트래픽 10,000건 안에서 쓰세요. " +
      "★ 철거멸실 대장의 관리번호는 아직 **구 PK 형식**(시군구코드-일련번호, 예: 11680-100062686)으로 " +
      "내려옵니다. 기본개요의 22자리 신규 PK와 형식이 달라 그대로는 매칭되지 않습니다 — " +
      "국토교통부 PK 전환 규칙(통합분류코드 4자리 + 대장구분 + 일련번호)을 거쳐야 연결됩니다. " +
      "★ since·until은 데이터 생성일 기준입니다.",
    {
      region: z.string().optional().describe("시군구명. 서버가 법정동으로 해석해 순회"),
      sigunguCd: z.string().optional().describe("시군구코드 5자리. bjdongCd와 함께"),
      bjdongCd: z.string().optional().describe("법정동코드 5자리"),
      bun: z.string().optional().describe("번"),
      ji: z.string().optional().describe("지"),
      kinds: z
        .array(z.enum(["철거멸실", "대수선", "가설건축물", "공작물", "오수정화시설"]))
        .optional()
        .describe("조회할 대장 종류 (기본 철거멸실)"),
      since: z.string().optional().describe("데이터 생성일 시작 YYYYMMDD"),
      until: z.string().optional().describe("데이터 생성일 종료 YYYYMMDD"),
      maxDongs: z.number().int().min(1).max(40).optional().describe("순회할 법정동 수 (기본 10)"),
      limitPerKind: z.number().int().min(1).max(100).optional().describe("종류별 최대 행수 (기본 20)"),
    },
    async (args) => {
      const result = await searchArchAuxRegisters(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );



  server.tool(
    "search_narajangteo_scsbid",
    "조달청 나라장터 **낙찰정보**를 조회해 공공입찰의 **최종낙찰업체·최종낙찰금액·최종낙찰률**을 " +
      "돌려줍니다. 물품·공사·용역·외자 4종을 한 번에 조회하며, 낙찰업체의 사업자번호·대표자·주소·" +
      "연락처와 수요기관·참가업체수·실개찰일시까지 함께 나옵니다. " +
      "★ **공고명·기관명·업종명·참가제한지역·추정가격범위·사업자번호(bizno) 중 하나라도 주면** " +
      "검색형 오퍼레이션(PPSSrch)으로 전환합니다. 특히 **bizno로 특정 업체의 공공 수주이력**을 바로 " +
      "뽑을 수 있어 경쟁사·협력사·인수후보 분석에 유용합니다. 검색조건을 안 주면 그 기간의 낙찰건 " +
      "전체가 나오므로 기간을 짧게 잡으세요. " +
      "★ 조회기간 상한은 **캘린더 1개월**입니다(초과 시 원 API가 resultCode 07 '입력범위값 초과'). " +
      "일수가 아니라 달력 기준이라, 30일 이하인 달이 시작점이면 30일 남짓이어도 초과합니다 " +
      "(실측: 6/30~7/31, 2/27~3/30 모두 07). 더 긴 기간을 주면 서버가 **달력 월 경계로** 잘라 " +
      "순차 호출합니다. " +
      "★ **창 하나가 실패하면 그 구간이 통째로 빠집니다** — 이때 잘림=true·잘림사유='창실패'가 " +
      "붙고 실패구간이 응답에 담깁니다. 그 결과로 건수·합계·순위를 내지 말고 실패 구간만 따로 " +
      "다시 호출해 합치세요. **잘림=true인 결과로 낙찰가율 평균 같은 통계를 내지 마세요.** " +
      "★ **원 API 일일 한도는 오퍼레이션(업무구분×기본형/검색형)당 1,000회**입니다. 소진되면 " +
      "HTTP 429가 나고 잘림사유='요청한도초과'로 돌아오며, 재시도는 한도만 더 씁니다(익일 초기화). " +
      "한도가 호출 '횟수' 기준이라 서버는 한 페이지에 999건씩 받아 호출 수를 최소화합니다 — " +
      "응답의 **upstream호출수**로 그 호출이 한도를 얼마나 썼는지 확인하고 누적을 가늠하세요. " +
      "한도는 업무구분별로 따로이므로 용역이 막혀도 공사·물품은 계속 조회됩니다. " +
      "★ dateType은 기본 '개찰일시'입니다. 검색조건을 함께 쓰면 '등록일시'는 쓸 수 없습니다" +
      "(검색형 오퍼레이션에 그 조회구분이 없습니다). " +
      "★ 개찰 전이거나 협상·적격심사가 진행 중이면 낙찰자가 비어 있을 수 있고, 그것은 오류가 아닙니다. " +
      "★ **기간 필터는 공고상 개찰(예정)일시로 걸립니다.** 실개찰일시(rlOpengDt)는 연기될 수 있어 요청 구간 " +
      "밖인 건이 섞이고, 같은 건이 인접한 두 구간에 모두 잡힙니다(실측: 7월 조회 70건 중 11건의 실개찰이 8월, " +
      "그 11건이 8월 조회에도 포함). 서버가 창 경계 중복을 제거하고 그 수를 중복제거에, 구간 밖 건수를 " +
      "구간밖_실개찰에 담아 보냅니다 — **'그 달에 개찰된 건'으로 엄격히 집계하려면 각 행의 실개찰일시로 다시 " +
      "거르세요.** " +
      "★ **최종낙찰률은 결측이 많습니다**(실측 70건 중 48건 공란). 협상에 의한 계약은 예정가격 대비 투찰률이 " +
      "산출되지 않기 때문이며, 응답의 낙찰률결측에 건수·비율이 담깁니다. 결측을 빼고 평균을 내면 적격심사 건에 " +
      "쏠린 편향값이 되므로 그대로 인용하지 마세요. " +
      "★ **최근 구간은 과소집계입니다.** 낙찰정보는 개찰 후 낙찰자가 확정·등록되어야 조회되며, 실측한 " +
      "개찰→등록 지연은 중앙값 7.0일·90분위 22.9일·최대 46일입니다. 조회 종료일이 30일 이내면 서버가 " +
      "경고를 붙이니, 그 구간 건수는 확정치가 아니라 '현재까지 등록된 건 기준'으로 답하세요. " +
      "★ **업무구분 '용역'은 건수가 많아 3개월 이상을 한 번에 부르면 시간 상한에 걸립니다** — 이때는 " +
      "거기까지 모은 중간 결과에 잘림=true·잘림사유='시간상한'이 붙어 돌아옵니다. **필터가 고장난 것이 " +
      "아니라 기간이 길었던 것이므로 월 단위로 나눠 호출해 합치세요**(같은 조건도 1개월이면 정상). " +
      "★ **장기계속공사는 총계약금액이 아니라 차수분 금액이 기록됩니다** — 실측: 「울산도시철도 1호선 " +
      "건설공사」가 11.3억원으로 잡힙니다(실제 사업은 수천억). 금액 하한 필터를 걸면 이런 대형 사업이 " +
      "통째로 빠지므로, 금액 기준 집계·순위를 낼 때 이 성질을 답변에 밝히세요. " +
      "★ **건수·합계·순위가 목적이면 summaryOnly=true를 쓰세요.** 개별 행 대신 집계만 돌려주므로 " +
      "limit 절단이 원천적으로 사라집니다. 같은 조건이라도 기간에 따라 건수가 몇 배씩 달라져 " +
      "(실측: 10일 창 하나가 7월은 194~263건, 3월은 478~519건) **창을 몇 개로 쪼개야 하는지 " +
      "부르기 전에는 알 수 없기 때문입니다.** " +
      "★ **집계 목적이면 응답의 수집건수와 반환건수를 반드시 대조하세요.** limit에 걸려 반환만 잘린 " +
      "경우 잘림 필드는 false로 남습니다(잘림은 수집이 끊겼을 때만 true). 정렬이 금액순이 아니라 " +
      "실개찰일시 내림차순이라 잘린 쪽에 금액 상위가 들어갈 수 있습니다 — 실측: limit=300으로 불러 " +
      "수집 317·반환 300이 됐고 잘린 17건에 300억 이상이 4건 있었습니다. 집계는 기간을 나눠 합치세요. " +
      "★ **조달청 시스템 테스트 공고가 실제 낙찰건과 섞여 있습니다**(실측: 「[SHR]공사 PQ 테스트 공고」가 " +
      "낙찰금액 989억원, 낙찰업체 '업체29', 공고번호 T25BK…). 서버가 판정해 응답의 테스트공고의심에 건수·금액을 " +
      "담고 해당 행에 근거를 붙이지만 **제거하지는 않습니다** — 합계를 낼 때 직접 빼고 뺐다는 사실을 밝히세요. " +
      "★ **창을 더 잘게 쪼갠다고 더 나오지 않습니다** — 실측상 30일 1창과 7일 4창의 고유건이 정확히 " +
      "같았고(188건), 늘어나는 것은 중복뿐입니다. 분할 폭을 임의로 줄이지 마세요. " +
      "전 참가업체의 순위별 투찰금액이 필요하면 get_narajangteo_openg_result를 쓰세요.",
    {
      bizTypes: z
        .array(z.enum(["물품", "공사", "용역", "외자"]))
        .optional()
        .describe("업무구분. 생략 시 4종 전부(" + BIZ_TYPE_NAMES.join("/") + ")"),
      dateType: z
        .enum(["개찰일시", "공고일시", "등록일시"])
        .optional()
        .describe("기간의 기준 (기본 개찰일시). 검색조건과 함께 쓰면 등록일시 불가"),
      from: z.string().optional().describe("조회 시작 YYYYMMDDHHMM (생략 시 종료일 30일 전)"),
      to: z.string().optional().describe("조회 종료 YYYYMMDDHHMM (생략 시 현재 KST)"),
      bidNtceNo: z.string().optional().describe("입찰공고번호. 주면 기간 대신 이 번호로 단건 조회"),
      bidNtceNm: z.string().optional().describe("공고명 부분검색"),
      ntceInsttNm: z.string().optional().describe("공고기관명 부분검색"),
      dminsttNm: z.string().optional().describe("수요기관명 부분검색"),
      indstrytyNm: z
        .string()
        .optional()
        .describe(
          "업종명. ★ **신뢰할 수 없습니다** — 실측(2026-08-31) 용역에 '토목공사업'을 넣으니 건수는 줄었으나 " +
            "청소년활동 연구·미디어아트 연출 같은 무관한 건이 그대로 반환됐습니다. 오류 없이 엉뚱하게 걸리므로 " +
            "업종별 집계에 쓰지 말고 bidNtceNm으로 좁히세요"
        ),
      indstrytyCd: z
        .string()
        .optional()
        .describe("업종코드. indstrytyNm과 같은 이유로 신뢰할 수 없습니다"),
      prtcptLmtRgnCd: z.string().optional().describe("참가제한지역코드 2자리 (11 서울, 41 경기, 00 전국 등)"),
      presmptPrceBgn: z.string().optional().describe("추정가격 하한(원)"),
      presmptPrceEnd: z.string().optional().describe("추정가격 상한(원)"),
      bizno: z.string().optional().describe("업체 사업자등록번호 10자리. 그 업체의 낙찰건만. companyName보다 우선합니다"),
      companyName: z
        .string()
        .optional()
        .describe(
          "회사명. DART 인덱스로 **사업자등록번호를 자동 해석**해 그 업체의 낙찰건만 조회합니다. " +
            "★ 다른 도구와 달리 해석에 실패하면 업체명 부분검색으로 폴백할 수 없습니다(원 API에 업체명 " +
            "파라미터가 없음) — 이때는 조회를 멈추고 안내를 돌려주므로, 웹에서 사업자등록번호를 확인해 " +
            "bizno로 다시 부르세요. 어느 경로를 탔는지는 응답의 해석에 담깁니다"
        ),
      limit: z.number().int().min(1).max(300).optional().describe("최대 반환 건수 (기본 50)"),
      // ★ 일부 MCP 클라이언트·프록시는 인자를 전부 문자열로 직렬화해 보낸다(실측
      //   2026-09-01: boolean true가 "true"로 도착해 검증에서 튕겼다). z.coerce.boolean()은
      //   "false"까지 true로 만들어 버리므로 쓰지 않고, 문자열 리터럴만 명시적으로 받는다.
      summaryOnly: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .transform((v) => v === true || v === "true")
        .optional()
        .describe(
          "★ **건수·합계·순위가 목적이면 이걸 켜세요.** 개별 행 대신 집계만 돌려줍니다 — " +
            "건수·낙찰금액합계·낙찰업체수·업체별 상위·수요기관별 상위·실개찰 월별 분포·금액구간별 " +
            "분포·낙찰률 결측과 사분위. 행을 반환하지 않으므로 **limit 절단이 원천적으로 없고** " +
            "응답도 작습니다(실측: 700건 수집에 4KB). 집계는 두 벌로 옵니다 — 전체(공고상 " +
            "개찰예정일시 기준 전 행)와 실개찰_구간내(실개찰일시가 요청 구간 안인 행만). " +
            "\"그 기간에 개찰된 건\"으로 답할 때는 실개찰_구간내를 쓰세요. " +
            "★ 다만 수집 자체가 끊기는 경우는 그대로이므로 **잘림이 true면 이 집계도 부분값**입니다. " +
            "★ **여러 번 나눠 부른 집계는 합치지 마세요** — 건수·금액은 더할 수 있지만 상위 목록은 " +
            "각 호출의 상위 topN개만 담겨 있어 두 구간에 고르게 걸친 업체가 통째로 빠집니다."
        ),
      topN: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("summaryOnly일 때 업체별·수요기관별 상위 몇 개까지 담을지 (기본 10)"),
    },
    async (args) => {
      const result = await searchScsbidWinners(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_narajangteo_openg_result",
    "입찰공고번호 **한 건의 개찰결과 전모**를 돌려줍니다. 개찰개요(공고명·개찰일시·참가업체수·" +
      "진행구분·수요기관)와 함께 **전 참가업체의 개찰순위·투찰금액·투찰률·투찰일시**가 나오고, " +
      "적격심사·종합평가 건은 입찰가격평가점수·기술평가점수도 붙습니다. 유찰이면 유찰사유, " +
      "재입찰이면 재입찰사유와 새 마감·개찰일시가 나옵니다. " +
      "★ 이 도구는 **기간 조회가 안 됩니다** — 원 API가 입찰공고번호를 필수로 요구합니다. " +
      "번호는 search_narajangteo_scsbid나 scan_narajangteo_procurement로 먼저 확보하세요. " +
      "★ bizType(물품/공사/용역/외자)을 알면 넣어주세요. 없으면 4종을 차례로 두드려 찾습니다. " +
      "★ 낙찰가율 분포·경쟁강도를 보려면 이 도구가, 어느 업체가 얼마에 따냈는지 목록이 필요하면 " +
      "search_narajangteo_scsbid가 맞습니다.",
    {
      bidNtceNo: z.string().describe("입찰공고번호 (필수). 예: R26BK01686208"),
      bizType: z.enum(["물품", "공사", "용역", "외자"]).optional().describe("업무구분. 알면 지정(탐색 호출 절약)"),
      bidNtceOrd: z.string().optional().describe("입찰공고차수. 재공고 건 구분용"),
      bidClsfcNo: z.string().optional().describe("입찰분류번호"),
      rbidNo: z.string().optional().describe("재입찰번호"),
      limit: z.number().int().min(1).max(500).optional().describe("반환할 최대 참가업체 수 (기본 100)"),
    },
    async (args) => {
      const result = await getOpengResult(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );



  // 주택인허가 · 청약홈 분양정보 도구 3종 (lib/housing_client.js)
  registerHousingTools(server, z);

  return server;
}
