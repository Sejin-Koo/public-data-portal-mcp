// public-data-portal-mcp / lib/cals_client.js
//
// 국토교통부 건설CALS(건설사업정보시스템, calspia.go.kr) OpenAPI.
//
//   https://www.calspia.go.kr/io/openapi/<구분>/<오퍼레이션>.do
//   구분: cm=공사, fm=시설물, lc=보상, pm=인허가, pt=기타 (전체 70개 오퍼레이션)
//
// ★ 공공데이터포털과 **별개의 포털·별개의 키**다. 환경변수는 CALS_KEY이며 DATA_PORTAL_KEY가
//   아니다. 키는 GUID 형태(대문자+하이픈)라 URL 인코딩이 필요 없다.
//
// ★ 인증키 파라미터명은 `serviceKey`, 포맷은 `type=json`(주지 않으면 XML).
//
// ── 실측으로 확인한 함정 (2026-08-29) ────────────────────────────────────────
//
// ★ 응답 래퍼가 성공/실패에 따라 다르다. 정상이면 `{response:{body,header}}`인데
//   DB_ERROR가 나면 `response` 래퍼가 사라지고 `{body,header}`가 루트로 온다.
//   한쪽만 가정하면 에러 경로에서 터진다. → unwrap()으로 둘 다 받는다.
//
// ★ resultCode는 공공데이터포털의 "00"이 아니라 **한 자리 "0"**이다. 3=NODATA_ERROR.
//
// ★ 공사정보 목록(selectIoCmConstructionList)의 `searchCcwYn`(준공여부)은 **조용히 무시된다.**
//   0/1 어느 쪽을 줘도 totalCount가 1,362로 같고 반환 행은 전부 진행공사다. 준공 공사는
//   반드시 별도 오퍼레이션(selectIoCmCcwConstructionList)을 써야 한다.
//
// ★ 날짜 형식이 오퍼레이션마다 다르다. 사후평가는 YYYYMM, 도로점용허가·품질검사성적서는
//   YYYYMMDD다. 틀린 형식을 주면 파라미터 오류가 아니라 DB_ERROR로 떨어져 원인을 찾기 어렵다.
//
// ★ numOfRows는 1,000이 상한이다. 9,000을 줘도 1,000행만 온다(에러 없음).
//
// ★ 도로점용허가(selectIoPmPermitList)의 searchActUserNm(신청인)·searchOrgNm(허가기관)·
//   searchPermitNo도 **전부 조용히 무시된다.** 실측: 필터 없음 9,109건 / 신청인=케이티 9,109건 /
//   기관=서울지방국토관리청 9,109건으로 전부 같다. 실제로 동작하는 필터는 기간뿐이므로
//   나머지는 받아서 서버에서 건다.
//
// ★ 공사 관련 오퍼레이션 3종은 모집단이 서로 다르다(실측).
//     전체 목록 selectIoCmConstructionList     1,362건 (진행 141 + 완료 1,221)
//     진행 상세검색 selectIoCmPrgConstructionList  140건
//     준공 상세검색 selectIoCmCcwConstructionList  254건
//   상세검색 2종은 전체 목록의 부분집합이며, 특히 준공 상세검색은 완료공사 1,221건 중 254건만
//   담고 있다. "준공 공사가 254건"이라고 답하면 틀린다 — 상세검색 오퍼레이션이 담은 범위일 뿐이다.
//
// ── 데이터 커버리지 — 서비스군마다 완전히 다르다 ───────────────────────────
//
// ★ 공사·시설물·참여업체 계열(cm/fm)은 **국토교통부 5개 지방국토관리청**(서울·원주·대전·
//   익산·부산) 발주분 한정이다. 전국 건설현장이 아니다. 실측: 공사 1,362건 / 참여업체 995개 /
//   시설물 8,021건. 민간 건축공사는 아예 없다.
//
// ★ 반대로 품질검사(pm)·사후평가·설계VE(pt)는 **전국**이다. 사후평가 175개 발주기관,
//   설계VE 184개 발주청(LH·국가철도공단·수자원공사 등), 품질검사에는 시·군·공사·공단이 모두 나온다.
//
// ★★ **품질검사 계열은 2024-08-30에서 데이터가 멈춰 있다.** 2025년·2026년 등록분이 전
//   시공사에 걸쳐 0건이다(연도별 자재 품질검사: 2022년 237,629 / 2023년 245,067 /
//   2024년 142,387 / 2025년 0 / 2026년 0). **신규 현장을 찾는 선행지표로 쓸 수 없다.**
//   고객사별 현장 이력·경쟁구도 같은 후행 분석 용도다. 반면 공사정보(cm)는 2026-06 착공분까지
//   최신이다. 두 계열의 기준시점이 2년 가까이 어긋나므로 섞어서 "현재 현황"이라고 말하면 틀린다.

const BASE = "https://www.calspia.go.kr/io/openapi";
const MAX_ROWS = 1000;

export const CALS_KEY = process.env.CALS_KEY || "";
export const CALS_KEY_SOURCE = CALS_KEY ? "CALS_KEY" : "미설정";

// 품질검사 계열 데이터가 실제로 끝나는 날. 안내 문구에 쓴다.
export const QUALITY_DATA_CUTOFF = "2024-08-30";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function keyMissing() {
  return {
    ok: false,
    reason:
      "건설CALS 인증키가 설정되지 않았습니다. 환경변수 CALS_KEY를 설정하세요. " +
      "(공공데이터포털 키 DATA_PORTAL_KEY와는 다른 키입니다)",
    keySource: CALS_KEY_SOURCE,
  };
}

const onlyDigits = (s) => String(s ?? "").replace(/[^0-9]/g, "");

function checkYmd(v, name) {
  const d = onlyDigits(v);
  if (d.length !== 8) return `${name}는 YYYYMMDD 8자리여야 합니다. 예: 20240101`;
  return null;
}

function checkYm(v, name) {
  const d = onlyDigits(v);
  if (d.length !== 6) return `${name}는 YYYYMM 6자리여야 합니다. 예: 202401`;
  return null;
}

// 성공이면 {response:{...}}, DB_ERROR면 {...}가 루트로 온다.
function unwrap(json) {
  return json && json.response ? json.response : json;
}

async function callCals(path, params, { timeoutMs = 45000, retries = 2 } = {}) {
  const url = `${BASE}${path}?serviceKey=${CALS_KEY}&type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`JSON 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const payload = unwrap(data);
      const header = payload?.header ?? {};
      const code = String(header.resultCode ?? "");
      // 3 = NODATA_ERROR 는 오류가 아니라 "그 조건에 데이터 없음"이다.
      if (code !== "0" && code !== "3") {
        throw new Error(
          `${path}: ${header.resultKorMsg || header.resultMsg || "오류"} (resultCode ${code || "?"})`
        );
      }
      const body = payload?.body ?? {};
      const items = Array.isArray(body.items) ? body.items : body.items ? [body.items] : [];
      return { items, totalCount: Number(body.totalCount ?? items.length), body };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchPages(path, params, maxPages = 3) {
  const first = await callCals(path, { ...params, pageNo: 1, numOfRows: MAX_ROWS });
  let items = first.items;
  const pages = Math.min(Math.ceil(first.totalCount / MAX_ROWS) || 1, maxPages);
  for (let p = 2; p <= pages; p++) {
    const got = await callCals(path, { ...params, pageNo: p, numOfRows: MAX_ROWS });
    items = items.concat(got.items);
  }
  return {
    items,
    fetched: items.length,
    totalCount: first.totalCount,
    truncated: first.totalCount > items.length,
  };
}

const norm = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

// ★ 같은 현장이 표기 차이만으로 여러 건으로 갈린다(실측: "영동대로 지하공간 복합개발 3공구"와
//   "…3공구 건설공사"가 시공사 표기 ㈜/(주) 차이까지 겹쳐 4건으로 분리). 현장을 접을 때는
//   공사명에서 괄호·공백·구두점과 후행 공사 접미어를 걷어낸 값을 키로 쓴다. 원문 표기는
//   버리지 않고 병합된_표기로 함께 돌려줘, 잘못 합쳐졌는지 사람이 확인할 수 있게 한다.
const SITE_SUFFIX = /(건설공사|신축공사|조성공사|확장공사|공사|사업)$/;
function normSite(s) {
  let v = String(s || "")
    .normalize("NFKC")
    .replace(/[()\[\]{}<>「」『』·・,.\-_/\\]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  let prev;
  do {
    prev = v;
    v = v.replace(SITE_SUFFIX, "");
  } while (v !== prev && v.length > 2);
  return v || String(s || "");
}

// 착공일·준공예정일이 오퍼레이션마다 YYYYMMDD와 YYYY-MM-DD로 섞여 온다.
function ymdDash(v) {
  const d = String(v ?? "").replace(/[^0-9]/g, "");
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : trimSafe(v);
}
function trimSafe(s) {
  return s == null ? null : String(s).trim() || null;
}

const trim = (s) => (s == null ? null : String(s).trim() || null);

// ────────────────────────────────────────────────────────────────────────────
// 1. 공사정보 검색
// ────────────────────────────────────────────────────────────────────────────

const CONSTRUCTION_OPS = {
  진행: "/cm/selectIoCmPrgConstructionList.do",
  준공: "/cm/selectIoCmCcwConstructionList.do",
  전체: "/cm/selectIoCmConstructionList.do",
};

export async function searchCalsConstruction({
  status = "전체",
  progress,
  cwkNm,
  orcd,
  bzarCd,
  pdznNm,
  stwrDt,
  ccwDt,
  limit = 30,
  maxPages = 3,
} = {}) {
  if (!CALS_KEY) return keyMissing();
  const path = CONSTRUCTION_OPS[status];
  if (!path) {
    return {
      ok: false,
      reason: `status는 진행 / 준공 / 전체 중 하나여야 합니다. 받은 값: ${status}`,
      안내: "원 API의 searchCcwYn(준공여부) 파라미터는 조용히 무시되므로 오퍼레이션 자체를 나눠 호출합니다.",
    };
  }

  const params =
    status === "전체"
      ? { searchCwkNm: cwkNm, searchOrcd: orcd }
      : {
          searchCwkNm: cwkNm,
          searchOrcd: orcd,
          searchBzarCd: bzarCd,
          searchPdznNm: pdznNm,
          searchStwrDt: stwrDt,
          searchCcwDt: ccwDt,
        };

  const got = await fetchPages(path, params, maxPages);
  let source = got.items;
  // 전체 목록은 진행·완료가 섞여 있고 원 API의 searchCcwYn이 무시되므로 여기서 거른다.
  if (status === "전체" && progress) {
    const want = progress === "진행" ? "0" : "1";
    source = source.filter((x) => String(x.ccwYn) === want);
  }
  const rows = source.map((x) => ({
    현장번호: trim(x.sptNo),
    공사번호: trim(x.cno),
    공사명: trim(x.cwkNm),
    발주기관: trim(x.ornm),
    사업분야: trim(x.bzarNm),
    사업종류: trim(x.bzKdNm),
    노선_하천: trim(x.rutNm),
    행정구역: trim(x.pdznNm),
    공사구간: trim(x.cwkSctnNm),
    착공일: trim(x.stwrDt),
    준공일: trim(x.ccwDt),
    준공예정일: trim(x.ccwXpcDt),
    준공여부: trim(x.ccwYnNm),
  }));

  const 기관별 = {};
  const 분야별 = {};
  for (const r of rows) {
    if (r.발주기관) 기관별[r.발주기관] = (기관별[r.발주기관] || 0) + 1;
    if (r.사업분야) 분야별[r.사업분야] = (분야별[r.사업분야] || 0) + 1;
  }

  return {
    ok: true,
    조회구분: status,
    조회조건: { 공사명: cwkNm ?? null, 진행구분: progress ?? null, 발주기관코드: orcd ?? null, 사업분야코드: bzarCd ?? null, 행정구역: pdznNm ?? null },
    전체건수: got.totalCount,
    수집행수: got.fetched,
    필터후건수: rows.length,
    잘림: got.truncated,
    기관별,
    분야별,
    목록: rows.slice(0, limit),
    모집단안내:
      status === "전체"
        ? "전체 목록 오퍼레이션입니다(실측 1,362건 = 진행 141 + 완료 1,221). 진행·완료 구분은 " +
          "원 API의 searchCcwYn이 무시되므로 서버가 받아서 직접 걸렀습니다."
        : `${status} 상세검색 오퍼레이션입니다. 이 오퍼레이션은 전체 목록의 부분집합만 담고 ` +
          "있습니다(실측 진행 140건 / 준공 254건, 전체 목록은 1,362건). 여기서 나온 건수를 " +
          "'국토관리청의 진행·준공 공사 총수'로 인용하지 마세요 — 폭넓게 보려면 status=전체를 쓰세요.",
    데이터범위:
      "국토교통부 5개 지방국토관리청(서울·원주·대전·익산·부산) 발주 공사만 포함합니다. " +
      "민간 건축공사와 지자체·공사·공단 발주분은 이 데이터에 없습니다.",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 현장 상세 (현장번호 기준 다중 섹션)
// ────────────────────────────────────────────────────────────────────────────

const DETAIL_SECTIONS = {
  연도별계약: { path: "/cm/selectIoCmProjConstYearContractList.do", needs: ["sptNo"] },
  집행금액: { path: "/cm/selectIoCmCbmRprtByerExeAmtList.do", needs: ["sptNo"] },
  기성보고입찰: { path: "/cm/selectIoCmAcpsRprtCntrBidList.do", needs: ["sptNo"] },
  교량: { path: "/cm/selectIoCmProjFcl01List.do", needs: ["sptNo"] },
  터널: { path: "/cm/selectIoCmProjFcl02List.do", needs: ["sptNo"] },
  절개사면: { path: "/cm/selectIoCmProjFcl03List.do", needs: ["sptNo"] },
  통로박스: { path: "/cm/selectIoCmProjFcl04List.do", needs: ["sptNo"] },
  옹벽: { path: "/cm/selectIoCmProjFcl05List.do", needs: ["sptNo"] },
  수문: { path: "/cm/selectIoCmProjFcl06List.do", needs: ["sptNo"] },
  제방: { path: "/cm/selectIoCmProjFcl07List.do", needs: ["sptNo"] },
  설계변경: { path: "/cm/selectDgnChgRprtList.do", needs: ["sptNo", "sptTo"] },
  설계변경내역: { path: "/cm/selectDgnChgRprtDetailList.do", needs: ["sptNo", "sptTo"] },
  기성보고: { path: "/cm/selectAcpsRprtList.do", needs: ["sptNo", "sptTo"] },
  월간공정: { path: "/cm/selectMlyPrpoList.do", needs: ["sptNo", "sptTo", "rprtYm"] },
};

export const DETAIL_SECTION_NAMES = Object.keys(DETAIL_SECTIONS);

export async function getCalsConstructionDetail({ sptNo, sections, sptTo = "1", rprtYm, limitPerSection = 20 } = {}) {
  if (!CALS_KEY) return keyMissing();
  if (!sptNo) {
    return {
      ok: false,
      reason: "sptNo(현장번호)는 필수입니다.",
      안내: "search_cals_construction의 결과에서 현장번호를 먼저 확보하세요.",
      사용가능한_섹션: DETAIL_SECTION_NAMES,
    };
  }
  const want = (sections && sections.length ? sections : ["연도별계약", "설계변경", "교량", "터널"]).filter((s) =>
    DETAIL_SECTIONS[s]
  );
  const unknown = (sections || []).filter((s) => !DETAIL_SECTIONS[s]);

  const out = {};
  const 오류 = {};
  for (const name of want) {
    const spec = DETAIL_SECTIONS[name];
    if (spec.needs.includes("rprtYm") && !rprtYm) {
      오류[name] = "rprtYm(보고연월 YYYYMM)이 필요한 섹션입니다.";
      continue;
    }
    const params = { sptNo };
    if (spec.needs.includes("sptTo")) params.sptTo = sptTo;
    if (spec.needs.includes("rprtYm")) params.rprtYm = onlyDigits(rprtYm);
    try {
      const got = await callCals(spec.path, { ...params, pageNo: 1, numOfRows: MAX_ROWS });
      out[name] = { 건수: got.totalCount, 목록: got.items.slice(0, limitPerSection) };
    } catch (e) {
      오류[name] = String(e.message || e);
    }
  }

  return {
    ok: true,
    현장번호: sptNo,
    차수: sptTo,
    보고연월: rprtYm ? onlyDigits(rprtYm) : null,
    섹션: out,
    ...(Object.keys(오류).length ? { 조회실패: 오류 } : {}),
    ...(unknown.length ? { 알수없는_섹션: unknown, 사용가능한_섹션: DETAIL_SECTION_NAMES } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 참여업체 / 업체별 참여공사
// ────────────────────────────────────────────────────────────────────────────

export async function searchCalsContractor({ companyName, bizNo, limit = 30 } = {}) {
  if (!CALS_KEY) return keyMissing();
  if (!companyName && !bizNo) {
    return {
      ok: false,
      reason: "companyName(업체명) 또는 bizNo(사업자등록번호) 중 하나는 필요합니다.",
      안내: "원 API의 업체 목록에는 검색 파라미터가 없어 전량(약 995개)을 받아 서버에서 거릅니다.",
    };
  }

  const all = await fetchPages("/cm/selectIoCmProjCorpInfoList.do", {}, 2);
  const key = companyName ? norm(companyName) : null;
  const digits = bizNo ? onlyDigits(bizNo) : null;
  const matched = all.items.filter((x) => {
    if (digits) return onlyDigits(x.brn) === digits;
    return norm(x.cmnm).includes(key);
  });

  if (!matched.length) {
    return {
      ok: true,
      조회조건: { 업체명: companyName ?? null, 사업자등록번호: bizNo ?? null },
      업체수: 0,
      안내:
        "국토관리청 참여업체 명부에 없습니다. 이 명부는 국토교통부 5개 지방국토관리청 발주 공사의 " +
        "참여업체(약 995개)만 담고 있어, 민간공사나 지자체 공사만 수행한 업체는 여기에 없습니다. " +
        "그 업체가 존재하지 않는다는 뜻이 아닙니다.",
      전체명부_업체수: all.totalCount,
    };
  }

  const 업체 = [];
  for (const m of matched.slice(0, limit)) {
    let 참여공사 = [];
    let 참여공사수 = 0;
    try {
      const part = await callCals("/cm/selectIoCmProjCorpPartList.do", {
        brn: onlyDigits(m.brn),
        pageNo: 1,
        numOfRows: MAX_ROWS,
      });
      참여공사수 = part.totalCount;
      참여공사 = part.items.map((x) => ({
        현장번호: trim(x.sptNo),
        공사명: trim(x.cwkNm),
        발주기관: trim(x.orgNm),
        사업분야: trim(x.bzarNm),
        참여단계: trim(x.extCyclSeNm),
        지분율_퍼센트: x.quaRt ?? null,
        도급액: x.otsrAmt ?? null,
        준공여부: trim(x.ccwNm),
        공사기간: trim(x.stwrCcwDt),
      }));
    } catch (e) {
      참여공사 = [{ 오류: String(e.message || e) }];
    }
    업체.push({
      업체명: trim(m.cmnm),
      사업자등록번호: trim(m.brn),
      대표자: trim(m.rprnNm),
      대표공사: trim(m.cwkNm),
      참여공사수,
      참여공사,
    });
  }

  return {
    ok: true,
    조회조건: { 업체명: companyName ?? null, 사업자등록번호: bizNo ?? null },
    업체수: matched.length,
    업체: 업체,
    데이터범위:
      "국토교통부 5개 지방국토관리청 발주 공사의 참여업체 명부입니다. 참여이력은 1996년 준공 건까지 " +
      "거슬러 올라가며, 민간공사 실적은 포함되지 않습니다.",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 품질검사 (시공사 기준 현장 추적)
// ────────────────────────────────────────────────────────────────────────────

export async function searchCalsQualityTests({
  contractorName,
  sDate,
  eDate,
  year,
  cwkNm,
  materialName,
  permitNo,
  limit = 30,
  maxPages = 3,
} = {}) {
  if (!CALS_KEY) return keyMissing();

  const 시점안내 =
    `이 데이터는 ${QUALITY_DATA_CUTOFF}에서 멈춰 있습니다(2025년·2026년 등록분 0건). ` +
    "신규 현장을 찾는 선행지표로 쓸 수 없고, 고객사별 현장 이력·경쟁구도 분석 같은 후행 용도입니다.";

  // 경로 A — 시공사명 기준 (품질검사성적서 등록 목록)
  if (contractorName) {
    const e1 = checkYmd(sDate || "20200101", "sDate");
    const e2 = checkYmd(eDate || "20241231", "eDate");
    if (e1 || e2) return { ok: false, reason: e1 || e2 };
    const got = await fetchPages(
      "/pm/selectIoPmQtscList.do",
      {
        searchCstrNm: contractorName,
        searchRpcdIsBgDt: onlyDigits(sDate || "20200101"),
        searchRpcdIsEdDt: onlyDigits(eDate || "20241231"),
        searchClntNm: undefined,
        searchMtlNm: materialName,
      },
      maxPages
    );

    // 같은 현장이 시험 건마다 반복된다 — 현장 단위로 접는다.
    const sites = new Map();
    for (const x of got.items) {
      const k = `${normSite(x.cwkNm)}|${norm(x.cstrNm)}`;
      const cur = sites.get(k) || {
        공사명: trim(x.cwkNm),
        시공사: trim(x.cstrNm),
        발주처: trim(x.ordrNm) || trim(x.ornm),
        착공일: ymdDash(x.stwrDt),
        준공예정일: ymdDash(x.ccwXpcDt),
        성적서건수: 0,
        최근발급일: null,
        _표기: new Set(),
      };
      cur.성적서건수 += 1;
      cur._표기.add(`${trim(x.cwkNm)} / ${trim(x.cstrNm)}`);
      if (!cur.발주처) cur.발주처 = trim(x.ordrNm) || trim(x.ornm);
      if (!cur.착공일) cur.착공일 = ymdDash(x.stwrDt);
      if (!cur.준공예정일) cur.준공예정일 = ymdDash(x.ccwXpcDt);
      const d = trim(x.rpcdIsDt);
      if (d && (!cur.최근발급일 || d > cur.최근발급일)) cur.최근발급일 = d;
      sites.set(k, cur);
    }
    const 현장 = [...sites.values()]
      .map(({ _표기, ...r }) => (_표기.size > 1 ? { ...r, 병합된_표기: [..._표기] } : r))
      .sort((a, b) => String(b.준공예정일 || "").localeCompare(String(a.준공예정일 || "")));

    return {
      ok: true,
      조회구분: "시공사명 기준 (품질검사성적서 등록 목록)",
      조회조건: { 시공사명: contractorName, 발급일: `${onlyDigits(sDate || "20200101")}~${onlyDigits(eDate || "20241231")}` },
      전체성적서건수: got.totalCount,
      수집행수: got.fetched,
      잘림: got.truncated,
      고유현장수: 현장.length,
      현장: 현장.slice(0, limit),
      기준시점: 시점안내,
      집계주의:
        "잘림=true면 전체가 아니라 수집한 행 안에서만 현장을 센 값입니다. 고유현장수를 " +
        "그 시공사의 전체 현장 수로 인용하지 마세요.",
    };
  }

  // 경로 B — 연도 + 공사명/자재명 기준 (건설자재 품질검사 등록정보)
  if (!year) {
    return {
      ok: false,
      reason: "contractorName(시공사명) 또는 year(연도) 중 하나는 필요합니다.",
      안내:
        "시공사명으로 찾으면 성적서 등록 목록을, 연도로 찾으면 건설자재 품질검사 등록정보를 조회합니다. " +
        "연도 경로에는 시공사 필터가 없어 공사명·자재명으로 좁혀야 합니다.",
      기준시점: 시점안내,
    };
  }

  const got = await fetchPages(
    "/pm/selectIoPmQtlTsitStsList.do",
    { year: onlyDigits(year).slice(0, 4), searchCwkNm: cwkNm, searchMtlNm: materialName, searchPerNo: permitNo },
    maxPages
  );

  const sites = new Map();
  for (const x of got.items) {
    const k = `${normSite(x.cwkNm)}|${norm(x.cstrNm)}`;
    const cur = sites.get(k) || {
      공사명: trim(x.cwkNm),
      시공사: trim(x.cstrNm),
      발주처: trim(x.ordrNm) || trim(x.ornm),
      착공일: ymdDash(x.stwrDt),
      준공예정일: ymdDash(x.ccwXpcDt),
      검사건수: 0,
      _표기: new Set(),
    };
    cur.검사건수 += 1;
    cur._표기.add(`${trim(x.cwkNm)} / ${trim(x.cstrNm)}`);
    if (!cur.발주처) cur.발주처 = trim(x.ordrNm) || trim(x.ornm);
    if (!cur.착공일) cur.착공일 = ymdDash(x.stwrDt);
    if (!cur.준공예정일) cur.준공예정일 = ymdDash(x.ccwXpcDt);
    sites.set(k, cur);
  }
  const 현장 = [...sites.values()]
    .map(({ _표기, ...r }) => (_표기.size > 1 ? { ...r, 병합된_표기: [..._표기] } : r))
    .sort((a, b) => b.검사건수 - a.검사건수);

  return {
    ok: true,
    조회구분: "연도 기준 (건설자재 품질검사 등록정보)",
    조회조건: { 연도: onlyDigits(year).slice(0, 4), 공사명: cwkNm ?? null, 자재명: materialName ?? null },
    전체검사건수: got.totalCount,
    수집행수: got.fetched,
    잘림: got.truncated,
    고유현장수: 현장.length,
    현장: 현장.slice(0, limit),
    기준시점: 시점안내,
    집계주의:
      "이 오퍼레이션에는 시공사 필터가 없습니다. 특정 건설사의 현장을 찾으려면 contractorName " +
      "경로를 쓰세요. 잘림=true면 수집한 행 안에서만 집계한 값입니다.",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. 건설공사 사후평가 / 설계VE
// ────────────────────────────────────────────────────────────────────────────

export async function searchCalsProjectEvaluation({
  kind = "사후평가",
  sYm,
  eYm,
  orderOrgName,
  projectName,
  contractorName,
  bizTypeCd,
  constClass,
  minAmt,
  maxAmt,
  limit = 30,
  maxPages = 3,
} = {}) {
  if (!CALS_KEY) return keyMissing();

  if (kind === "사후평가") {
    const s = onlyDigits(sYm || "201001").slice(0, 6);
    const e = onlyDigits(eYm || "202612").slice(0, 6);
    const err = checkYm(s, "sYm") || checkYm(e, "eYm");
    if (err) return { ok: false, reason: err + " (사후평가는 YYYYMMDD가 아니라 YYYYMM입니다)" };
    const 잘라씀 =
      onlyDigits(sYm || "").length > 6 || onlyDigits(eYm || "").length > 6
        ? "입력값이 6자리를 넘어 앞 6자리(YYYYMM)만 사용했습니다. 이 오퍼레이션은 월 단위 조회입니다."
        : null;

    const got = await fetchPages(
      "/pt/selectIoPtCtwkPsevList.do",
      {
        searchCcwDtInqBgDt: s,
        searchCcwDtInqEdDt: e,
        searchOdinOrcd: undefined,
        searchBztpCd: bizTypeCd,
        searchCtco: contractorName,
        searchBzNm: projectName,
      },
      maxPages
    );

    let rows = got.items.map((x) => ({
      사업번호: trim(x.ptlCmno),
      공사명: trim(x.cwkNm),
      사업명: trim(x.bzNm),
      발주기관: trim(x.jrsGvdpNm),
      사업유형: trim(x.bztpCdNm),
      공사발주금액: x.cwkOrdeAmt ?? null,
      준공일: trim(x.ccwDt),
      계획수요: x.demPlnVl ?? null,
      실제수요: x.demRlVl ?? null,
      수요증감률: x.demIndRt ?? null,
      공사비증감률: x.wctIndRt ?? null,
      공기증감률: x.bzTrIndRt ?? null,
    }));
    if (orderOrgName) {
      const k = norm(orderOrgName);
      rows = rows.filter((r) => norm(r.발주기관).includes(k));
    }

    const 기관별 = {};
    const 유형별 = {};
    for (const r of rows) {
      if (r.발주기관) 기관별[r.발주기관] = (기관별[r.발주기관] || 0) + 1;
      if (r.사업유형) 유형별[r.사업유형] = (유형별[r.사업유형] || 0) + 1;
    }

    return {
      ok: true,
      조회구분: "건설공사 사후평가",
      조회조건: { 준공년월: `${s}~${e}`, 발주기관: orderOrgName ?? null, 사업명: projectName ?? null },
      ...(잘라씀 ? { 입력해석: 잘라씀 } : {}),
      전체건수: got.totalCount,
      수집행수: got.fetched,
      잘림: got.truncated,
      필터후건수: rows.length,
      발주기관수: Object.keys(기관별).length,
      유형별,
      목록: rows.slice(0, limit),
      데이터범위:
        "전국 공공발주기관의 건설공사 사후평가입니다(철도·도로·항만·공항·수자원 등). " +
        "총사업비 일정 규모 이상의 공사가 대상이라 소규모 공사는 포함되지 않습니다.",
    };
  }

  if (kind === "설계VE") {
    const got = await fetchPages(
      "/pt/selectIoPtVeBusinessList.do",
      {
        searchProjNm: projectName,
        searchOrderOrgNm: orderOrgName,
        searchConstClass: constClass,
        searchMinConstAmt: minAmt,
        searchMaxConstAmt: maxAmt,
      },
      maxPages
    );
    const rows = got.items.map((x) => ({
      사업번호: trim(x.ptlCmno),
      공사명: trim(x.cwkNm),
      발주청: trim(x.odogNm),
      총공사비: x.ctco ?? null,
      공사위치: trim(x.cwkLctNm),
      검토조직유형: trim(x.xmnOrgnCmpsTyNm),
      VE단계: trim(x.xmnStpTyNm),
      공사구분: trim(x.cwkSeNm),
    }));
    const 발주청별 = {};
    for (const r of rows) if (r.발주청) 발주청별[r.발주청] = (발주청별[r.발주청] || 0) + 1;

    return {
      ok: true,
      조회구분: "설계VE(설계경제성 검토)",
      조회조건: { 사업명: projectName ?? null, 발주청: orderOrgName ?? null },
      전체건수: got.totalCount,
      수집행수: got.fetched,
      잘림: got.truncated,
      발주청수: Object.keys(발주청별).length,
      발주청별_상위: Object.entries(발주청별)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
      목록: rows.slice(0, limit),
      데이터범위:
        "전국 공공발주청의 설계VE 실적입니다(LH·국가철도공단·수자원공사·지자체 등). " +
        "총공사비(ctco) 단위는 원 명세에 표기가 없어 확정하지 못했습니다 — 실측 값의 자릿수로 보아 " +
        "백만원 단위로 보이나, 대외 인용 시 반드시 원 자료로 확인하세요.",
    };
  }

  return { ok: false, reason: `kind는 사후평가 / 설계VE 중 하나여야 합니다. 받은 값: ${kind}` };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. 도로점용허가
// ────────────────────────────────────────────────────────────────────────────

export async function searchCalsRoadOccupancy({
  sDate,
  eDate,
  applicantName,
  orgName,
  permitNo,
  limit = 30,
  maxPages = 3,
} = {}) {
  if (!CALS_KEY) return keyMissing();
  if (!sDate || !eDate) {
    return {
      ok: false,
      reason: "sDate·eDate(YYYYMMDD)는 필수입니다.",
      안내: "이 API는 허가일 기준 기간 조회입니다. 0건은 그 기간에 허가가 없었다는 뜻일 뿐입니다.",
    };
  }
  const err = checkYmd(sDate, "sDate") || checkYmd(eDate, "eDate");
  if (err) return { ok: false, reason: err };

  // ★ 원 API의 searchActUserNm·searchOrgNm·searchPermitNo는 조용히 무시된다(실측: 세 필터
  //   어느 것을 줘도 totalCount 9,109로 동일). 기간만 서버에 넘기고 나머지는 여기서 건다.
  const got = await fetchPages(
    "/pm/selectIoPmPermitList.do",
    { searchEdBgDt: onlyDigits(sDate), searchEdEdDt: onlyDigits(eDate) },
    maxPages
  );

  let source = got.items;
  if (applicantName) {
    const k = norm(applicantName);
    source = source.filter((x) => norm(x.rlAppiNm).includes(k));
  }
  if (orgName) {
    const k = norm(orgName);
    source = source.filter((x) => norm(x.ornm).includes(k));
  }
  if (permitNo) {
    const k = norm(permitNo);
    source = source.filter((x) => norm(x.perNo).includes(k));
  }

  const rows = source.map((x) => ({
    신청번호: trim(x.rqsNo),
    허가종류: trim(x.prmNm),
    허가기관: trim(x.ornm),
    신청인: trim(x.rlAppiNm),
    허가일: trim(x.edDt),
    허가사유: trim(x.edRsn),
    허가번호: trim(x.perNo),
  }));

  const 신청인별 = {};
  for (const r of rows) if (r.신청인) 신청인별[r.신청인] = (신청인별[r.신청인] || 0) + 1;

  return {
    ok: true,
    조회조건: { 기간: `${onlyDigits(sDate)}~${onlyDigits(eDate)}`, 신청인: applicantName ?? null, 허가기관: orgName ?? null },
    기간내_전체건수: got.totalCount,
    수집행수: got.fetched,
    필터후건수: rows.length,
    잘림: got.truncated,
    신청인별_상위: Object.entries(신청인별)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15),
    목록: rows.slice(0, limit),
    필터방식:
      "원 API의 신청인·허가기관·허가번호 필터는 무시되므로 서버가 기간 전량을 받아 직접 걸렀습니다. " +
      "잘림=true면 기간 전량을 받지 못한 상태에서 거른 것이라 해당 신청인의 건이 더 있을 수 있습니다 — " +
      "이 경우 기간을 좁혀 다시 조회하세요.",
    데이터범위:
      "국토교통부 지방국토관리청이 관리하는 국도 등의 도로점용허가입니다. " +
      "지자체가 관리하는 도로의 점용허가는 포함되지 않습니다.",
  };
}
