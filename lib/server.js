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

  return server;
}
