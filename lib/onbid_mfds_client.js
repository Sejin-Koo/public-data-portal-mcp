// public-data-portal-mcp / lib/onbid_mfds_client.js
//
// 한국자산관리공사 온비드(공매) 3종 + 식품의약품안전처 의약품·건강기능식품 4종 API 래퍼.
// 2026-08-23 추가. 오퍼레이션명·파라미터명은 전부 실제 호출로 확정한 값이다
// (data.go.kr 계열은 파라미터명을 틀려도 에러 없이 전체 데이터를 그대로 돌려주는
//  "조용한 실패"가 흔하므로, 이 파일의 파라미터명을 임의로 바꾸지 말 것).
//
// ── 확정된 오퍼레이션 (2026-08-23 실호출 검증) ──────────────────────────────
//  온비드 부동산 물건목록   B010003/OnbidRlstListSrvc2/getRlstCltrList2
//  온비드 부동산 물건상세   B010003/OnbidRlstDtlSrvc2/getRlstDtlInf2
//  온비드 물건상세 입찰정보 B010003/OnbidCltrBidDtlSrvc2/getCltrBidInf2
//  의약품개요(e약은요)      1471000/DrbEasyDrugInfoService/getDrbEasyDrugList
//  의약품 제품 허가정보     1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06
//  의약품 낱알식별          1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03
//  건강기능식품정보         1471000/HtfsInfoService03/getHtfsItem01

import { SERVICE_KEY, qs, rawFetch, parseResponse } from "./pdp_client.js";

const ONBID_BASE = "https://apis.data.go.kr/B010003";
const MFDS_BASE = "https://apis.data.go.kr/1471000";

// 재산유형코드 전체. 물건목록 API는 prptDivCd가 필수이므로, 호출자가 지정하지 않으면
// 전체를 넣어 "재산유형 무관 검색"이 되게 한다.
export const PRPT_DIV_CODES = {
  "0002": "공유재산",
  "0003": "금융권담보재산",
  "0004": "불용품",
  "0005": "기타일반재산",
  "0006": "유입재산",
  "0007": "압류재산",
  "0008": "수탁재산",
  "0010": "국유재산",
  "0011": "공공개발재산",
  "0013": "파산재산",
};
export const ALL_PRPT_DIV = Object.keys(PRPT_DIV_CODES).join(",");

// ---------------------------------------------------------------------------
// 공통 호출·정규화
// ---------------------------------------------------------------------------

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 공공데이터포털 응답에서 결과코드/메시지를 뽑는다.
 * 이 계열에서 관측된 형태는 셋이다:
 *   1) 정상/일반오류 : { header: { resultCode, resultMsg }, body: {...} }
 *   2) 필수파라미터   : { result: { resultCode: "11", resultMsg: "NO_MANDATORY..." } }
 *   3) 서비스 자체    : { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg, returnReasonCode } } }
 * 표준 { response: { header, body } } 구조도 함께 지원한다.
 */
function readHeader(d) {
  if (!d || typeof d !== "object") return { code: undefined, msg: undefined };
  const svc = d.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (svc) {
    return {
      code: String(svc.returnReasonCode ?? "ERR"),
      msg: `${svc.errMsg ?? ""} ${svc.returnAuthMsg ?? ""}`.trim(),
    };
  }
  const h = d.header ?? d.result ?? d.response?.header;
  if (h) return { code: String(h.resultCode ?? ""), msg: String(h.resultMsg ?? "") };
  return { code: undefined, msg: undefined };
}

function readBody(d) {
  return d?.body ?? d?.response?.body ?? {};
}

/**
 * items를 항상 평평한 배열로 만든다.
 *   온비드      : body.items.item = [...]          (또는 단건이면 객체)
 *   e약은요/허가/낱알 : body.items = [...]
 *   건강기능식품 : body.items = [{ item: {...} }, ...]   ← 한 겹 더 감싸져 있음
 */
function readItems(d) {
  const body = readBody(d);
  let items = body.items;
  if (items && !Array.isArray(items) && typeof items === "object") {
    items = items.item !== undefined ? items.item : items;
  }
  return asArray(items).map((x) =>
    x && typeof x === "object" && x.item && Object.keys(x).length === 1 ? x.item : x
  );
}

// "03"(NODATA_ERROR)은 오류가 아니라 "조건에 맞는 데이터 없음"이다. 실패로 처리하면
// 호출자가 "조회 실패"로 오해하므로 totalCount 0 / items [] 로 정규화한다.
const NODATA_CODES = new Set(["03"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// data.go.kr 게이트웨이는 간헐적으로 연결을 끊거나(ECONNRESET) WAF가 HTML 에러 페이지를
// 돌려준다. 실측에서 동일한 요청이 첫 호출만 실패하고 재시도하면 바로 성공하는 형태로
// 나타났으므로(2026-08-23 스모크테스트), 네트워크 실패·파싱 실패·5xx는 재시도한다.
// 재시도해도 안 되는 경우에만 ok:false로 정규화해서 돌려준다(예외를 던지지 않는다).
async function callApi({ base, service, operation, params, timeoutMs = 20000, retries = 3 }) {
  const url = `${base}/${service}/${operation}?serviceKey=${encodeURIComponent(SERVICE_KEY)}&${qs(params)}`;
  let status = 0;
  let text = "";
  let lastErr = null;
  let parsed = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      ({ status, text } = await rawFetch(url, {}, timeoutMs));
      if (status >= 500) {
        lastErr = `HTTP ${status}`;
      } else {
        parsed = parseResponse(text);
        if (parsed.format !== "error") break;
        lastErr = "응답 파싱 실패";
      }
    } catch (e) {
      lastErr = e.message;
      parsed = null;
    }
    if (attempt < retries) await sleep(600 * attempt);
  }
  if (!parsed || parsed.format === "error") {
    return {
      ok: false,
      httpStatus: status,
      resultCode: undefined,
      resultMsg: `조회 실패(${retries}회 재시도): ${lastErr}`,
      raw: String(text).slice(0, 500),
      totalCount: 0,
      items: [],
      endpoint: `${base}/${service}/${operation}`,
    };
  }
  const d = parsed.data;
  const { code, msg } = readHeader(d);
  const body = readBody(d);
  const items = readItems(d);
  const nodata = NODATA_CODES.has(code);
  const ok = code === "00" || nodata;
  return {
    ok,
    httpStatus: status,
    resultCode: code,
    resultMsg: msg,
    noData: nodata,
    totalCount: nodata ? 0 : Number(body.totalCount ?? items.length) || 0,
    pageNo: Number(body.pageNo ?? params.pageNo ?? 1) || 1,
    numOfRows: Number(body.numOfRows ?? params.numOfRows ?? 0) || 0,
    items: nodata ? [] : items,
    endpoint: `${base}/${service}/${operation}`,
  };
}

/** numOfRows 상한(온비드 100, 식약처 100)을 넘겨 여러 페이지를 모아온다. */
async function callPaged({ base, service, operation, params, want, perPage = 100, maxPages = 10, timeoutMs = 20000 }) {
  const collected = [];
  let first = null;
  let pages = 0;
  const limit = Math.max(1, Math.min(maxPages, Math.ceil((want || perPage) / perPage)));
  for (let p = 1; p <= limit; p++) {
    const r = await callApi({
      base,
      service,
      operation,
      params: { ...params, pageNo: p, numOfRows: perPage },
      timeoutMs,
    });
    pages = p;
    if (!first) first = r;
    if (!r.ok) return { ...r, items: collected, fetchedPages: pages };
    collected.push(...r.items);
    if (r.noData) break;
    if (collected.length >= (want || perPage)) break;
    if (collected.length >= r.totalCount) break;
  }
  return { ...first, items: collected.slice(0, want || collected.length), fetchedPages: pages };
}

// ---------------------------------------------------------------------------
// 온비드 (한국자산관리공사 공매)
// ---------------------------------------------------------------------------

// 온비드 소재지는 **법정동** 기준이라 "교문2동"·"수택3동" 같은 행정동명으로는 0건이 나온다.
// 사용자가 행정동을 넣었을 때 조용히 "없음"으로 끝나지 않도록, 끝의 숫자를 떼어 재시도하고
// 무엇을 바꿔 조회했는지 응답에 남긴다.
export function legalDongCandidates(emd) {
  if (!emd) return [];
  const raw = String(emd).trim();
  const out = [raw];
  const stripped = raw.replace(/(\D)\d+동$/, "$1동");
  if (stripped !== raw) out.push(stripped);
  return out;
}

export async function searchOnbidRealEstate(opts = {}) {
  const {
    sido,
    sigungu,
    eupmyeondong,
    prptDivCd,
    pvctTrgtYn = "N",
    dspsMthodCd,
    bidDivCd,
    cptnMthodCd,
    usageLarge,
    usageMedium,
    usageSmall,
    minPrice,
    maxPrice,
    minAppraisal,
    maxAppraisal,
    minLandArea,
    maxLandArea,
    minBldArea,
    maxBldArea,
    minFailCount,
    maxFailCount,
    bidStartFrom,
    bidStartTo,
    updatedFrom,
    updatedTo,
    cltrName,
    orgName,
    shareOnly,
    limit = 30,
    maxPages = 5,
  } = opts;

  const baseParams = {
    resultType: "json",
    prptDivCd: prptDivCd && String(prptDivCd).trim() ? String(prptDivCd).trim() : ALL_PRPT_DIV,
    pvctTrgtYn,
    dspsMthodCd,
    bidDivCd,
    cptnMthodCd,
    cltrUsgLclsCtgrId: usageLarge,
    cltrUsgMclsCtgrId: usageMedium,
    cltrUsgSclsCtgrId: usageSmall,
    lctnSdnm: sido,
    lctnSggnm: sigungu,
    lowstBidPrcStart: minPrice,
    lowstBidPrcEnd: maxPrice,
    apslEvlAmtStart: minAppraisal,
    apslEvlAmtEnd: maxAppraisal,
    landSqmsStart: minLandArea,
    landSqmsEnd: maxLandArea,
    bldSqmsStart: minBldArea,
    bldSqmsEnd: maxBldArea,
    usbdNftStart: minFailCount,
    usbdNftEnd: maxFailCount,
    bidPrdYmdStart: bidStartFrom,
    bidPrdYmdEnd: bidStartTo,
    mdfcnYmdStart: updatedFrom,
    mdfcnYmdEnd: updatedTo,
    onbidCltrNm: cltrName,
    orgNm: orgName,
    alcYn: shareOnly,
  };

  const candidates = eupmyeondong ? legalDongCandidates(eupmyeondong) : [null];
  let last = null;
  const tried = [];
  for (const emd of candidates) {
    const r = await callPaged({
      base: ONBID_BASE,
      service: "OnbidRlstListSrvc2",
      operation: "getRlstCltrList2",
      params: { ...baseParams, lctnEmdNm: emd || undefined },
      want: limit,
      perPage: Math.min(100, Math.max(limit, 10)),
      maxPages,
    });
    tried.push({ lctnEmdNm: emd, totalCount: r.totalCount, resultCode: r.resultCode });
    last = r;
    if (r.ok && r.totalCount > 0) {
      return {
        ...r,
        query: { ...baseParams, lctnEmdNm: emd },
        dongResolution:
          emd && emd !== eupmyeondong
            ? `요청하신 '${eupmyeondong}'은(는) 행정동명입니다. 온비드 소재지는 법정동 기준이라 '${emd}'으로 조회했습니다. 결과에는 ${eupmyeondong} 외 같은 법정동 내 다른 행정동 물건도 포함될 수 있습니다.`
            : undefined,
        attempts: tried,
        note: "온비드는 법원경매(법원 경매정보)가 아니라 한국자산관리공사가 집행하는 공매(公賣)입니다. 또한 이 API는 현재 입찰중이거나 입찰예정인 물건만 제공하며, 이미 종료된 과거 물건은 조회되지 않습니다.",
      };
    }
  }
  return {
    ...last,
    query: baseParams,
    attempts: tried,
    note: "온비드는 법원경매가 아니라 한국자산관리공사 공매입니다. 입찰중·입찰예정 물건만 제공되며 종료된 물건은 조회되지 않습니다.",
  };
}

export async function getOnbidRealEstateDetail({ cltrMngNo, pbctCdtnNo } = {}) {
  return callApi({
    base: ONBID_BASE,
    service: "OnbidRlstDtlSrvc2",
    operation: "getRlstDtlInf2",
    params: { resultType: "json", pageNo: 1, numOfRows: 10, cltrMngNo, pbctCdtnNo },
    timeoutMs: 25000,
  });
}

export async function getOnbidBidInfo({ cltrMngNo, pbctCdtnNo } = {}) {
  return callApi({
    base: ONBID_BASE,
    service: "OnbidCltrBidDtlSrvc2",
    operation: "getCltrBidInf2",
    params: { resultType: "json", pageNo: 1, numOfRows: 10, cltrMngNo, pbctCdtnNo },
    timeoutMs: 25000,
  });
}

// ---------------------------------------------------------------------------
// 식품의약품안전처
// ---------------------------------------------------------------------------

/** 의약품개요정보(e약은요) — 일반인용 복약안내. 전체 약 중 일부 품목만 수록되어 있다. */
export async function searchDrugEasyInfo({ itemName, entpName, itemSeq, limit = 10 } = {}) {
  const r = await callPaged({
    base: MFDS_BASE,
    service: "DrbEasyDrugInfoService",
    operation: "getDrbEasyDrugList",
    params: { type: "json", itemName, entpName, itemSeq },
    want: limit,
    perPage: Math.min(100, Math.max(limit, 10)),
    maxPages: 3,
  });
  return {
    ...r,
    note:
      "e약은요는 성분(주성분)으로 검색할 수 없고 제품명·업체명·품목기준코드로만 검색됩니다. " +
      "성분으로 찾으려면 search_drug_permission(주성분 검색)을 사용하세요. " +
      "또한 이 DB는 전체 허가 의약품의 일부만 수록합니다.",
  };
}

// 허가정보는 한 건에 효능효과·용법용량·주의사항 XML 원문(EE/UD/NB/PN_DOC_DATA)이 함께 들어와
// 응답이 매우 커진다. 기본은 제외하고, 필요할 때만 verbose로 받게 한다.
const PERMISSION_HEAVY_FIELDS = ["EE_DOC_DATA", "UD_DOC_DATA", "NB_DOC_DATA", "PN_DOC_DATA"];

export async function searchDrugPermission({
  itemName,
  entpName,
  mainIngredient,
  itemSeq,
  ediCode,
  verbose = false,
  limit = 10,
} = {}) {
  const r = await callPaged({
    base: MFDS_BASE,
    service: "DrugPrdtPrmsnInfoService07",
    operation: "getDrugPrdtPrmsnDtlInq06",
    params: {
      type: "json",
      item_name: itemName,
      entp_name: entpName,
      main_item_ingr: mainIngredient,
      item_seq: itemSeq,
      edi_code: ediCode,
    },
    want: limit,
    perPage: Math.min(100, Math.max(limit, 10)),
    maxPages: 3,
    timeoutMs: 30000,
  });
  const items = verbose
    ? r.items
    : r.items.map((it) => {
        const o = { ...it };
        for (const f of PERMISSION_HEAVY_FIELDS) delete o[f];
        return o;
      });
  return {
    ...r,
    items,
    note:
      "MAIN_ITEM_INGR은 주성분, INGR_NAME은 첨가제입니다. main_item_ingr 검색은 성분명 부분일치로 " +
      "동작하므로 '콘드로이친'처럼 짧게 넣어야 '황산 콘드로이친 나트륨'까지 걸립니다. " +
      (verbose
        ? "효능효과(EE_DOC_DATA)·용법용량(UD_DOC_DATA)·주의사항(NB_DOC_DATA) XML 원문 포함."
        : "효능효과·용법용량·주의사항 XML 원문은 응답 크기 때문에 제외했습니다. 필요하면 verbose=true로 다시 호출하세요."),
  };
}

/**
 * 의약품 낱알식별.
 * ★ 2026-08-23 실측: 이 오퍼레이션은 item_name / entp_name / item_seq / edi_code /
 *   chart(성상) / form_code_name(제형)만 실제로 필터로 동작한다. print_front·drug_shape·
 *   color_class1 등 겉모양 필드는 응답에는 있지만 **요청 파라미터로 주면 조용히 무시**되어
 *   전체 건수가 그대로 돌아온다(파라미터명 변형 10여 종을 전부 시도해 확인). 따라서
 *   "흰색 원형에 T가 적힌 알약" 식의 겉모양 역추적은 이 도구로는 불가능하다.
 */
export async function searchPillIdentification({
  itemName,
  entpName,
  itemSeq,
  ediCode,
  chart,
  formCodeName,
  limit = 10,
} = {}) {
  const r = await callPaged({
    base: MFDS_BASE,
    service: "MdcinGrnIdntfcInfoService03",
    operation: "getMdcinGrnIdntfcInfoList03",
    params: {
      type: "json",
      item_name: itemName,
      entp_name: entpName,
      item_seq: itemSeq,
      edi_code: ediCode,
      chart,
      form_code_name: formCodeName,
    },
    want: limit,
    perPage: Math.min(100, Math.max(limit, 10)),
    maxPages: 3,
  });
  return {
    ...r,
    note:
      "이 API는 제품명·업체명·품목기준코드·보험코드·성상(chart)·제형(form_code_name)으로만 검색됩니다. " +
      "각인(PRINT_FRONT)·모양(DRUG_SHAPE)·색상(COLOR_CLASS1)은 응답 필드로는 제공되지만 검색 조건으로는 " +
      "동작하지 않으므로(요청에 넣어도 무시됨), 겉모양으로 약을 역추적하려면 제품명 후보를 먼저 좁힌 뒤 " +
      "반환된 ITEM_IMAGE·PRINT_FRONT·DRUG_SHAPE 값을 대조하세요.",
  };
}

/**
 * 건강기능식품 품목정보.
 *
 * ★ 이 서비스는 오퍼레이션이 둘이고, **파라미터 표기 규칙이 서로 반대인 칸이 있다**
 *   (2026-08-23 실호출로 전수 확인). 응답 필드명(PRDUCT·ENTRPS)을 그대로 파라미터로 쓰면
 *   에러 없이 전체 건수가 돌아오므로 아래 표대로만 쓸 것.
 *
 *   | 조건 | getHtfsItem01(상세) | getHtfsList01(목록) |
 *   |---|---|---|
 *   | 제품명   | `Prduct`      | `Prduct`      |
 *   | 업체명   | (동작 안 함)   | `Entrps`      |
 *   | 신고번호 | `STTEMNT_NO`  | `Sttemnt_no`  |
 *
 *   따라서 **업체명으로 좁히려면 목록조회를 거쳐야 한다.** 목록조회는 4개 필드
 *   (ENTRPS·PRDUCT·STTEMNT_NO·REGIST_DT)만 주므로, 기능성·성상·섭취방법이 필요하면
 *   신고번호로 상세조회를 한 건씩 다시 불러 병합한다.
 */
const HTFS_DETAIL_CAP = 20; // Vercel maxDuration(60초) 안에서 안전한 상세 병합 상한

async function fetchHealthFoodDetail(statementNo) {
  const r = await callApi({
    base: MFDS_BASE,
    service: "HtfsInfoService03",
    operation: "getHtfsItem01",
    params: { type: "json", pageNo: 1, numOfRows: 1, STTEMNT_NO: statementNo },
    retries: 2,
  });
  return r.ok && r.items.length ? r.items[0] : null;
}

export async function searchHealthFood({
  productName,
  companyName,
  statementNo,
  limit = 10,
  detail = true,
} = {}) {
  // 업체명이 없으면 상세조회 한 번으로 끝난다(전 필드가 바로 온다).
  if (!companyName) {
    const r = await callPaged({
      base: MFDS_BASE,
      service: "HtfsInfoService03",
      operation: "getHtfsItem01",
      params: { type: "json", Prduct: productName, STTEMNT_NO: statementNo },
      want: limit,
      perPage: Math.min(100, Math.max(limit, 10)),
      maxPages: 3,
    });
    return {
      ...r,
      searchedVia: "getHtfsItem01",
      note:
        "제품명(Prduct)·신고번호(STTEMNT_NO)로 상세조회했습니다. MAIN_FNCTN이 기능성 내용, " +
        "SUNGSANG이 성상, INTAKE_HINT1이 섭취 시 주의사항, BASE_STANDARD가 기준규격입니다.",
    };
  }

  // 업체명이 있으면 목록조회로 좁힌 뒤, 필요하면 신고번호로 상세를 병합한다.
  const list = await callPaged({
    base: MFDS_BASE,
    service: "HtfsInfoService03",
    operation: "getHtfsList01",
    params: { type: "json", Entrps: companyName, Prduct: productName, Sttemnt_no: statementNo },
    want: limit,
    perPage: Math.min(100, Math.max(limit, 10)),
    maxPages: 3,
  });
  if (!list.ok || !list.items.length || detail === false) {
    return {
      ...list,
      searchedVia: "getHtfsList01",
      note:
        "업체명 검색이 가능한 목록조회로 조회했습니다. 목록조회는 업체명·제품명·신고번호·" +
        "등록일 4개 필드만 제공하므로, 기능성·성상·섭취방법이 필요하면 detail=true로 다시 " +
        "호출하거나 반환된 STTEMNT_NO로 이 도구를 statementNo 인자와 함께 호출하세요.",
    };
  }

  const targets = list.items.slice(0, Math.min(limit, HTFS_DETAIL_CAP));
  const merged = [];
  let failed = 0;
  // 상세는 건당 1회 호출이라 5건씩 나눠 병렬 처리한다(전체 직렬이면 상한 시간을 넘긴다).
  for (let i = 0; i < targets.length; i += 5) {
    const chunk = targets.slice(i, i + 5);
    const details = await Promise.all(
      chunk.map((it) => fetchHealthFoodDetail(it.STTEMNT_NO).catch(() => null))
    );
    details.forEach((d, idx) => {
      if (d) merged.push({ ...chunk[idx], ...d });
      else {
        failed += 1;
        merged.push(chunk[idx]);
      }
    });
  }
  const truncated = list.items.length > targets.length;
  return {
    ...list,
    items: merged,
    searchedVia: "getHtfsList01 + getHtfsItem01",
    detailMerged: merged.length - failed,
    detailFailed: failed,
    note:
      `업체명 검색은 목록조회(getHtfsList01)에서만 동작하므로 목록으로 좁힌 뒤 신고번호로 상세를 병합했습니다. ` +
      (truncated
        ? `상세 병합은 ${HTFS_DETAIL_CAP}건까지만 수행합니다(조건에 맞는 건수는 totalCount 참조). `
        : "") +
      (failed ? `${failed}건은 상세 조회에 실패해 목록 필드만 담겨 있습니다. ` : "") +
      "MAIN_FNCTN이 기능성 내용, SUNGSANG이 성상, INTAKE_HINT1이 섭취 시 주의사항, BASE_STANDARD가 기준규격입니다.",
  };
}
