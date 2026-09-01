// public-data-portal-mcp / lib/pdp_client.js
//
// 공공데이터포털·D2B·NIA 등 여러 소스의 raw API를 감싸서, it-bid-daily-scan 예정작업이
// 매일 직접 curl로 처리하던 파싱/중복제거/헤더 quirk 로직을 서버 쪽으로 옮긴 모듈입니다.
// 오탐(false positive) 필터링과 "검토가치 판단" 같은 주관적 판단은 여기서 하지 않고,
// 원문 매칭 결과만 정규화해서 반환합니다 — 그 판단은 호출하는 쪽(에이전트)의 몫입니다.

import { XMLParser } from "fast-xml-parser";

// 공공데이터포털 인증키.
//
// ★ 환경변수명은 DATA_PORTAL_KEY다. 2026-08-26 이전에는 PUBLIC_DATA_PORTAL_KEY였는데,
//   그 "PUBLIC"은 "공공데이터포털(Public Data Portal)"의 약자였지만 Vercel은 `PUBLIC_`
//   접두어를 "브라우저에 노출할 공개 변수"로 해석해 Secret 타입 저장을 거부한다
//   (Astro·Vite 등이 PUBLIC_* 를 클라이언트 번들에 심는 관례 때문). 이 서버에는 클라이언트
//   번들이 없어 당시 실제 노출 경로는 없었으나, 나중에 빌드 도구가 붙으면 진짜로 샐 수 있는
//   이름이라 접두어를 뗐다. **옛 이름으로 되돌리지 말 것.**
export const SERVICE_KEY = process.env.DATA_PORTAL_KEY || "";

/** 키 설정 여부 진단용. 키 값 자체는 절대 노출하지 않는다. */
export const SERVICE_KEY_SOURCE = SERVICE_KEY ? "DATA_PORTAL_KEY" : "미설정";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const DEFAULT_KEYWORDS = [
  "AI",
  "생성형",
  "클라우드",
  "정보시스템",
  "빅데이터",
  "데이터센터",
  "디지털전환",
  "챗봇",
  "RPA",
  "RAG",
  "Agent",
  "지능형",
];

// parseTagValue를 반드시 false로 둘 것: 기본값(true)이면 "00" 같은 resultCode 문자열이
// 숫자 0으로 변환되어("00"→0) 성공 코드 비교가 전부 깨진다(2026-07-24 실제 테스트로 확인된
// 버그 — kdhc/kra/klid 등 XML 응답 소스에서 resultCode="00"이 0으로 파싱되어 정상 응답을
// 오류로 오판했었음). 금액 등 숫자 필드도 문자열로 남지만 이 서버는 산술 연산을 하지 않으므로
// 문제 없다.
const xmlParser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });

// ---------------------------------------------------------------------------
// 공통 유틸
// ---------------------------------------------------------------------------

export function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function normalizeSpace(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/\s+/g, "").replace(/　/g, "");
}

export function matchesKeywords(text, keywords) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return keywords.some((k) => t.includes(String(k).toLowerCase()));
}

// data.go.kr 계열은 UA를 안 보내면 WAF가 400을 내는 경우가 있고, 일부 API는 응답에
// charset이 없어 자동 인코딩 추정이 틀릴 수 있으므로 항상 바이트 단위로 받아 UTF-8로
// 명시적으로 디코딩한다.
//
// 2026-07-30: 타임아웃이 전혀 없어서 upstream API 중 하나만 응답이 늦어도 fetch가
// 무한정 대기하는 문제가 확인되었다(특히 scan_narajangteo_procurement가 4단계x12키워드=
// 48회를 순차 호출하면서 그 중 하나라도 걸리면 Vercel maxDuration(60초)을 넘겨 전체가
// hang 상태로 보였음). AbortController로 개별 호출에 timeoutMs(기본 15초) 상한을 둬서,
// 한 호출이 느려도 그 호출만 실패하고 나머지는 진행되게 한다.
export async function rawFetch(url, extraHeaders = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": UA, ...extraHeaders },
      signal: controller.signal,
    });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(buf);
    return { status: res.status, text };
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// JSON 우선 시도, 실패하면 XML로 파싱 (9번/13번 방위사업청 API처럼 type=json을 줘도
// XML로만 응답하는 경우 대응).
export function parseResponse(text) {
  try {
    return { format: "json", data: JSON.parse(text) };
  } catch {
    try {
      return { format: "xml", data: xmlParser.parse(text) };
    } catch (e) {
      return { format: "error", data: null, error: e.message, raw: text.slice(0, 500) };
    }
  }
}

// 지역정보개발원처럼 최상위 태그명이 표준 header/body가 아닌 경우(openXmlBiddingInfo-header 등)를
// 위해, 키 이름이 특정 접미사로 끝나는 값을 재귀적으로 찾는다.
export function findBySuffix(obj, suffix, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === suffix || k.endsWith(suffix)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findBySuffix(v, suffix, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// response.header.resultCode / response.body.items.item 표준 구조를 우선 시도하고,
// 실패하면 접미사 검색으로 대체한다.
export function getResultCode(parsed) {
  const std =
    parsed?.response?.header?.resultCode ??
    parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode;
  if (std !== undefined) return String(std);
  const alt = findBySuffix(parsed, "resultCode");
  return alt !== undefined ? String(alt) : undefined;
}

export function getItems(parsed) {
  // 나라장터 신형 JSON 응답(예: 입찰공고정보서비스)은 body.items가 바로 배열이고
  // ({response:{body:{items:[{...}]}}}), 구형 XML 유래 응답(kdhc/kra/klid/d2b 등)은
  // body.items.item 형태({response:{body:{items:{item:[...]}}}})다. 둘 다 지원한다.
  const bodyItems = parsed?.response?.body?.items;
  if (Array.isArray(bodyItems)) return bodyItems;
  if (bodyItems && typeof bodyItems === "object" && bodyItems.item !== undefined) {
    return asArray(bodyItems.item);
  }
  const alt = findBySuffix(parsed, "item");
  if (alt !== undefined) return asArray(alt);
  const altItems = findBySuffix(parsed, "items");
  if (Array.isArray(altItems)) return altItems;
  return [];
}

export function getTotalCount(parsed) {
  const std = parsed?.response?.body?.totalCount;
  if (std !== undefined) return Number(std);
  const alt = findBySuffix(parsed, "totalCount");
  return alt !== undefined ? Number(alt) : undefined;
}

// ---------------------------------------------------------------------------
// 시각 유틸 (KST 기준, since/until은 YYYYMMDDHHMM 문자열)
// ---------------------------------------------------------------------------

function kstNow() {
  const now = new Date();
  // UTC + 9시간
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

function fmtYYYYMMDDHHMM(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(
    d.getUTCMinutes()
  )}`;
}

function parseYYYYMMDDHHMM(s) {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10) || "0");
  const mi = Number(s.slice(10, 12) || "0");
  return new Date(Date.UTC(y, mo, d, h, mi));
}

export function nowKstStr() {
  return fmtYYYYMMDDHHMM(kstNow());
}

// 27일 제한: since가 until 기준 27일보다 이전이면 27일 전으로 당긴다.
// { since, until, truncated } 반환.
export function clampRange(since, untilInput) {
  const until = untilInput || nowKstStr();
  const untilDate = parseYYYYMMDDHHMM(until);
  const sinceDate = parseYYYYMMDDHHMM(since);
  const minDate = new Date(untilDate.getTime() - 27 * 24 * 60 * 60 * 1000);
  if (sinceDate < minDate) {
    return { since: fmtYYYYMMDDHHMM(minDate), until, truncated: true };
  }
  return { since, until, truncated: false };
}

export function toYYYYMMDD(yyyymmddhhmm) {
  return yyyymmddhhmm.slice(0, 8);
}
export function toYYYYMM(yyyymmddhhmm) {
  return yyyymmddhhmm.slice(0, 6);
}

// since~until 사이에 걸친 YYYYMM 목록 (월 단위 조회 API용)
export function monthsBetween(since, until) {
  const out = [];
  let y = Number(since.slice(0, 4));
  let m = Number(since.slice(4, 6));
  const endY = Number(until.slice(0, 4));
  const endM = Number(until.slice(4, 6));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (k === undefined || k === null || k === "") {
      out.push(it);
      continue;
    }
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 나라장터 4종 (조달요청 → 발주계획 → 사전규격 → 입찰공고)
// ---------------------------------------------------------------------------

// ★★ 한 페이지에 받는 행 수. 종전 50은 **조용한 누락**을 만들고 있었다 —
//   실측(2026-09-01, 입찰공고 2026-08 · 공고명 "시스템"): totalCount가 644인데 50행만
//   받아 594건(92%)이 사라졌고, 응답 어디에도 그 사실이 없었다.
//
// ★ numOfRows 상한은 999다. 실측 반환 행수:
//     50 → 50 / 100 → 100 / 500 → 500 / 999 → 644(전량) / **2000 → 10**
//   네 자리를 넘기면 에러 없이 조용히 10행으로 되돌아간다. 절대 넘기지 말 것.
const PAGE_ROWS = 999;

// totalCount가 PAGE_ROWS를 넘을 때 추가로 받을 페이지 수의 상한.
// 나라장터 4종은 4단계 × 키워드 수만큼 병렬 호출하므로 무제한 페이지네이션은
// Vercel maxDuration(60초)과 일일 요청한도를 함께 위협한다. 실측상 대부분 1페이지로
// 끝나므로(관측 최대 644건) 3페이지까지만 받고 그래도 남으면 잘림으로 알린다.
const MAX_EXTRA_PAGES = 2;

const NARAJANGTEO_STAGES = [
  {
    stage: 1,
    id: "req",
    label: "나라장터 조달요청현황",
    source: "조달청 나라장터 조달요청서비스",
    url: "https://apis.data.go.kr/1230000/ao/PrcrmntReqInfoService/getPrcrmntReqInfoListGnrlServcPPSSrch",
    // ★ 2026-08-26 교정. 종전에는 keywordParam이 prdctClsfcNoNm이었는데 그건 **품목분류명**
    //   필드다("정보시스템유지관리서비스" 같은 값). 사업명 검색용이 아니라서 "AI"를 넣으면
    //   에러 없이 0건이 나왔고, 이 단계만 늘 빈 결과였다(실측 2026-08-26: 기준 81건,
    //   prdctClsfcNoNm=AI → 0건, prcrmntReqNm=AI → 5건). 사업명 필드는 prcrmntReqNm이다.
    //   참고로 bizNm은 이 오퍼레이션에서 **무시**된다(넣어도 81건 그대로) — 다른 단계에서
    //   쓰는 이름이라고 그대로 가져다 쓰면 안 된다.
    keywordParam: "prcrmntReqNm",
    needsOriginReferer: false,
    // 이 단계만 upstream이 느리다(실측: 최초 13.4초, 이후 4.2초). 기본 15초 상한으로는
    // 콜드스타트 시점에 12개 키워드가 한꺼번에 타임아웃으로 떨어진다.
    timeoutMs: 30000,
    idField: "prcrmntReqNo",
    titleField: "prcrmntReqNm",
    buildParams: ({ keyword, since, until }) => ({
      serviceKey: SERVICE_KEY,
      pageNo: 1,
      numOfRows: PAGE_ROWS,
      type: "json",
      inqryDiv: 1,
      inqryBgnDt: since,
      inqryEndDt: until,
      prcrmntReqNm: keyword,
    }),
    mapItem: (it) => ({
      title: it.prcrmntReqNm,
      orderInsttNm: it.orderInsttNm,
      category: it.rprsntPrdctClsfcNoNm,
      budget: it.bdgtAmt,
      amount: it.rprsntAmt,
      date: it.rcptDt,
      manager: it.prcrmntReqOfclNm,
      id: it.prcrmntReqNo,
      detailUrl: null,
    }),
  },
  {
    stage: 2,
    id: "plan",
    label: "나라장터 발주계획현황",
    source: "조달청 나라장터 발주계획현황서비스",
    url: "https://apis.data.go.kr/1230000/ao/OrderPlanSttusService/getOrderPlanSttusListServcPPSSrch",
    keywordParam: "bizNm",
    needsOriginReferer: false,
    idField: "orderPlanUntyNo",
    titleField: "bizNm",
    buildParams: ({ keyword, since, until }) => ({
      serviceKey: SERVICE_KEY,
      pageNo: 1,
      numOfRows: PAGE_ROWS,
      type: "json",
      orderBgnYm: toYYYYMM(since),
      orderEndYm: toYYYYMM(until),
      inqryBgnDt: since,
      inqryEndDt: until,
      bizNm: keyword,
    }),
    mapItem: (it) => ({
      title: it.bizNm,
      orderInsttNm: it.orderInsttNm,
      totlmngInsttNm: it.totlmngInsttNm,
      budget: it.sumOrderAmt,
      orderMnth: it.orderMnth,
      date: it.nticeDt,
      dept: it.deptNm,
      manager: it.ofclNm,
      tel: it.telNo,
      id: it.orderPlanUntyNo,
      detailUrl: null,
    }),
  },
  {
    stage: 3,
    id: "prespec",
    label: "나라장터 사전규격현황",
    source: "조달청 나라장터 사전규격정보서비스",
    url: "https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService/getPublicPrcureThngInfoServcPPSSrch",
    keywordParam: "prdctClsfcNoNm",
    needsOriginReferer: true,
    idField: "bfSpecRgstNo",
    titleField: "prdctClsfcNoNm",
    buildParams: ({ keyword, since, until }) => ({
      serviceKey: SERVICE_KEY,
      pageNo: 1,
      numOfRows: PAGE_ROWS,
      type: "json",
      inqryDiv: 1,
      inqryBgnDt: since,
      inqryEndDt: until,
      prdctClsfcNoNm: keyword,
    }),
    mapItem: (it) => ({
      title: it.prdctClsfcNoNm,
      orderInsttNm: it.orderInsttNm,
      rlDminsttNm: it.rlDminsttNm,
      budget: it.asignBdgtAmt,
      date: it.rcptDt,
      opinionCloseDt: it.opninRgstClseDt,
      manager: it.ofclNm,
      tel: it.ofclTelNo,
      id: it.bfSpecRgstNo,
      swBizObjYn: it.swBizObjYn,
      dlvrDaynum: it.dlvrDaynum,
      detailUrl: it.specDocFileUrl1 || null,
    }),
  },
  {
    stage: 4,
    id: "notice",
    label: "나라장터 입찰공고현황",
    source: "조달청 나라장터 입찰공고정보서비스",
    url: "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServcPPSSrch",
    keywordParam: "bidNtceNm",
    needsOriginReferer: false,
    idField: "bidNtceNo",
    titleField: "bidNtceNm",
    buildParams: ({ keyword, since, until }) => ({
      serviceKey: SERVICE_KEY,
      pageNo: 1,
      numOfRows: PAGE_ROWS,
      inqryDiv: 1,
      type: "json",
      inqryBgnDt: since,
      inqryEndDt: until,
      bidNtceNm: keyword,
    }),
    mapItem: (it) => ({
      title: it.bidNtceNm,
      ntceInsttNm: it.ntceInsttNm,
      dminsttNm: it.dminsttNm,
      date: it.bidNtceDt,
      closeDt: it.bidClseDt,
      openDt: it.opengDt,
      presumedPrice: it.presmptPrce,
      budget: it.asignBdgtAmt,
      id: it.bidNtceNo,
      detailUrl: it.bidNtceDtlUrl || null,
    }),
  },
];

/**
 * 한 단계·한 키워드를 조회한다. totalCount가 한 페이지에 안 담기면 MAX_EXTRA_PAGES까지
 * 이어 받고, 그래도 남으면 truncations에 기록한다.
 *
 * ★ 종전에는 pageNo=1·numOfRows=50 한 번만 부르고 totalCount를 읽지 않았다. 그래서
 *   50건을 넘는 조회는 51번째부터 **아무 표시 없이 사라졌다**(실측: 644건 중 50건만 반환).
 *   getTotalCount는 정의만 되어 있고 이 경로에서 쓰이지 않던 함수였다.
 */
async function fetchNarajangteoStage(stageConfig, keyword, since, until, errors, truncations) {
  const headers = stageConfig.needsOriginReferer
    ? {
        Origin: "https://www.data.go.kr",
        Referer: "https://www.data.go.kr/data/15129437/openapi.do",
      }
    : {};

  const fetchPage = async (pageNo) => {
    const params = { ...stageConfig.buildParams({ keyword, since, until }), pageNo };
    const url = `${stageConfig.url}?${qs(params)}`;
    const { status, text } = await rawFetch(url, headers, stageConfig.timeoutMs ?? 15000);
    const { data, format, error } = parseResponse(text);
    if (format === "error") throw new Error(`parse error: ${error}`);
    const resultCode = getResultCode(data);
    if (resultCode !== "00" && resultCode !== "03") {
      throw new Error(`resultCode=${resultCode} httpStatus=${status}`);
    }
    return { items: getItems(data), totalCount: getTotalCount(data) ?? 0 };
  };

  try {
    const first = await fetchPage(1);
    const out = [...first.items];
    const total = first.totalCount;

    if (total > out.length) {
      const totalPages = Math.ceil(total / PAGE_ROWS);
      const lastPage = Math.min(totalPages, 1 + MAX_EXTRA_PAGES);
      for (let p = 2; p <= lastPage; p++) {
        const got = await fetchPage(p);
        out.push(...got.items);
        if (got.items.length === 0) break;
      }
      if (out.length < total) {
        // ★ 여기까지 왔으면 남은 건이 있다는 뜻이다. 조용히 넘기지 않는다.
        truncations.push({
          stage: stageConfig.id,
          keyword,
          받은건수: out.length,
          전체건수: total,
          안내: `키워드 "${keyword}"의 ${stageConfig.label}이 ${total}건인데 ${out.length}건만 받았습니다. 기간을 좁히거나 키워드를 나눠 다시 조회하세요.`,
        });
      }
    }
    return out.map(stageConfig.mapItem);
  } catch (e) {
    errors.push({ stage: stageConfig.id, keyword, error: e.message });
    return [];
  }
}

// 나라장터 4종을 조회하고, "4종 교차 중복 제거 원칙"(조달요청 < 발주계획 < 사전규격 < 입찰공고,
// 뒤 단계에 이미 있는 사업명은 앞 단계에서 제외)을 적용해 반환한다.
// keywords 생략 시 DEFAULT_KEYWORDS 사용.
//
// 2026-07-30: 기존에는 "4단계 순차 for-loop 안에 12키워드 순차 for-loop"로 최악의 경우
// 48회 외부 API 호출을 전부 순차(await)로 처리했다. data.go.kr 쪽 응답이 조금만 느려져도
// Vercel의 maxDuration(60초, vercel.json)을 넘기면서 사실상 무응답(행)으로 보이는 문제가
// 있었다(호출 자체는 rawFetch에 타임아웃도 없어 한 번 걸리면 더 오래 막힘). 4단계x키워드
// 조합 전체를 Promise.all로 완전 병렬화해서, rawFetch의 15초 타임아웃 상한 안에서 전체가
// 끝나도록 바꿨다. 단계 간 순서는 최종 결과의 dedup 로직(뒤 단계 우선)에서만 의미가 있고
// 호출 자체는 순서와 무관하므로, 병렬화해도 결과 로직은 동일하다.
export async function scanNarajangteoProcurement({ keywords, since, until } = {}) {
  const kws = keywords && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const range = clampRange(since, until);
  const errors = [];
  const truncations = [];

  const stageResults = await Promise.all(
    NARAJANGTEO_STAGES.map(async (stageConfig) => {
      const perKeyword = await Promise.all(
        kws.map((kw) =>
          fetchNarajangteoStage(stageConfig, kw, range.since, range.until, errors, truncations)
        )
      );
      let items = perKeyword.flat();
      items = dedupeBy(items, (it) => it.id);
      return { id: stageConfig.id, items };
    })
  );
  const byStage = {};
  for (const r of stageResults) byStage[r.id] = r.items;

  // 뒤 단계(입찰공고 쪽)부터 확인하면서, 이미 더 진전된 단계에 등장한 사업명을 앞 단계에서 제거.
  const seenTitles = new Set();
  const order = [...NARAJANGTEO_STAGES].reverse(); // notice, prespec, plan, req
  const result = {};
  let totalBeforeDedup = 0;
  let totalAfterDedup = 0;
  for (const stageConfig of order) {
    const items = byStage[stageConfig.id];
    totalBeforeDedup += items.length;
    const kept = items.filter((it) => {
      const norm = normalizeSpace(it.title);
      if (!norm) return true;
      if (stageConfig.id !== "notice" && seenTitles.has(norm)) return false;
      return true;
    });
    for (const it of items) {
      const norm = normalizeSpace(it.title);
      if (norm) seenTitles.add(norm);
    }
    result[stageConfig.id] = kept;
    totalAfterDedup += kept.length;
  }

  return {
    since: range.since,
    until: range.until,
    truncatedTo27Days: range.truncated,
    keywords: kws,
    stages: NARAJANGTEO_STAGES.map((s) => ({
      id: s.id,
      label: s.label,
      source: s.source,
      items: result[s.id],
    })),
    totalBeforeDedup,
    totalAfterDedup,
    errors,
    ...(truncations.length
      ? {
          잘림: true,
          잘린조회: truncations,
          유의사항: [
            `★ 조회 ${truncations.length}건이 반환 상한에 걸려 일부만 담겼습니다 — 이 결과는 전수가 아닙니다. 건수·합계를 내지 말고, 잘린조회에 적힌 키워드·단계만 기간을 좁혀 다시 조회해 합치세요.`,
          ],
        }
      : { 잘림: false }),
  };
}

// ---------------------------------------------------------------------------
// 5~12번: 그 외 기관 자체 공고 (에이전트 쪽에서 나라장터 결과와 최종 교차중복 제거 수행)
// ---------------------------------------------------------------------------

export const AGENCY_LIST = [
  "kwater_bid",
  "kwater_prespec",
  "kra",
  "dapa_overseas",
  "dapa_bid",
  "klid",
  "kospo",
  "kdhc",
];

const AGENCY_CONFIGS = {
  kwater_bid: {
    label: "한국수자원공사_전자조달 입찰공고",
        // ★ 페이지 상한 100 — 실측: 101 이상을 주면 **0행**이 온다(에러 없음). 상한이 정확히 100이므로 페이지네이션 필수
    monthly: true,
    successCodes: ["00"],
    idField: "tndrPbanno",
    titleField: "tndrPblancNm",
    dateField: "tndrPblancDe",
    buildUrl: (month) =>
      `https://apis.data.go.kr/B500001/ebid/tndr3/servcList?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 100,
        searchDt: month,
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.tndrPblancNm,
      date: it.tndrPblancDe,
      endDt: it.tndrPblancEnddt,
      amount: it.tndrPlnprc,
      dept: it.cntrctDeptNm,
      manager: it.intnChargerNm,
      status: it.tndrStat,
      id: it.tndrPbanno,
    }),
  },
  kwater_prespec: {
    label: "한국수자원공사_전자조달 사전규격공개",
        // ★ 페이지 상한 100 — 위와 같은 기관 API라 100으로 둔다(2026-08 totalCount가 마침 100이라 상한 판정이 불가했음)
    monthly: true,
    successCodes: ["00"],
    idField: null, // 고유 ID 없음 -> title+date 조합
    titleField: "tndrKndnm",
    dateField: "othbcStrtDe",
    buildUrl: (month) =>
      `https://apis.data.go.kr/B500001/ebid/stndrd3/servcList?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 100,
        searchDt: month,
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.tndrKndnm,
      amount: it.ordgAmt,
      date: it.othbcStrtDe,
      closeDt: it.othbcClosDe,
      manager: it.chargerNm,
      tel: it.bsnsChargerTelno,
      id: null,
    }),
  },
  kra: {
    label: "한국마사회 전자입찰 공고정보",
        // ★ 페이지 상한 999 — 실측: 999 요청에 317행 전량 반환(종전 100 → 217건 누락 중이었다)
    monthly: false,
    successCodes: ["00"],
    idField: "BCode",
    titleField: "bidName",
    dateField: "noticeDate",
    buildUrl: () =>
      `https://apis.data.go.kr/B551015/API182/E-noticeInfo?${qs({
        ServiceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.bidName,
      date: it.noticeDate,
      time: it.noticeTime,
      endDate: it.bidEndDate,
      endTime: it.bidEndTime,
      workType: it.workType,
      status: it.status,
      id: it.BCode,
    }),
  },
  dapa_overseas: {
    label: "방위사업청_해외입찰정보",
        // ★ 페이지 상한 999 — 실측: totalCount 7,205건. 999·2000 모두 요청한 만큼 반환된다(종전 100 → 7,105건 누락 중이었다)
    monthly: false,
    successCodes: ["00"],
    idField: "seqn",
    titleField: "bidNameKor",
    dateField: "infoAcquireFrom",
    buildUrl: (_m, { since, until }) =>
      `https://apis.data.go.kr/1690000/DCAIBidInfoService/getDCAIBidInfoList?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
        bidFrom: toYYYYMMDD(since),
        bidTo: toYYYYMMDD(until),
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.bidNameKor,
      titleEng: it.bidNameEng,
      country: it.orgPlaceNm,
      bidFrom: it.bidFrom,
      bidTo: it.bidTo,
      date: it.infoAcquireFrom,
      id: it.seqn,
    }),
    note: "이 데이터셋은 2019년 이후 갱신이 거의 없는 것으로 알려져 있습니다(과거 확인 기준). 매칭이 없으면 정상입니다.",
  },
  dapa_bid: {
    label: "방위사업청_군수품조달정보 입찰공고",
        // ★ 페이지 상한 999 — 키워드별 호출이라 건수가 적지만(실측 3건) 상한을 맞춰 둔다
    monthly: false,
    successCodes: ["00"],
    idField: "g2bPblancNo",
    titleField: "bidNm",
    dateField: "pblancDate",
    keywordParam: "bidNm",
    perKeyword: true,
    buildUrl: (_m, { since, until, keyword }) =>
      `https://apis.data.go.kr/1690000/BidPblancInfoService/getDmstcCmpetBidPblancList?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
        anmtDateBegin: toYYYYMMDD(since),
        anmtDateEnd: toYYYYMMDD(until),
        bidNm: keyword,
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.bidNm,
      dept: it.ornt,
      date: it.pblancDate,
      openDt: it.opengDt,
      amount: it.bsicExpt,
      busiDivs: it.busiDivs,
      id: it.g2bPblancNo || it.dcsNo,
    }),
    note: "busiDivs가 '물품'인 장비·비품 구매 건은 IT/SI 솔루션 구축이 아닐 수 있으니 검토가치 판단 시 참고하세요.",
  },
  klid: {
    label: "한국지역정보개발원_입찰정보 조회 서비스",
        // ★ 페이지 상한 999 — 실측: 999 요청에 436행 — **totalCount(413)보다 많이 온다.** totalCount를 페이지 수 계산에만 쓰고 종료 판정은 '받은 행이 0이면 중단'으로 한다
    monthly: false,
    successCodes: ["0"],
    idField: null, // No + ENT_NAME 조합
    titleField: "TITLE",
    dateField: "REG_DATE",
    buildUrl: (_m, { since, until }) =>
      `https://apis.data.go.kr/B551982/openApiBiddingInfo3/openXmlBiddingInfo2?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
        ac_year: since.slice(0, 4),
        from_month: since.slice(4, 6),
        to_month: until.slice(4, 6),
        sidoCd: "",
        type: "xml",
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.TITLE,
      entName: it.ENT_NAME,
      sido: it.SIDO_NAME,
      writer: it.USER_NAME,
      date: it.REG_DATE,
      id: it.No && it.ENT_NAME ? `${it.No}_${it.ENT_NAME}` : null,
      // 2026-08-03 수정: 원본 API에는 상세페이지 LINK 필드가 존재하는데(예:
      // https://cleaneye.go.kr/user/bidInfoDetail.do?num=...) 이 서버가 그동안 이 필드를
      // 매핑하지 않고 버려서, it-bid-daily-scan 예정작업이 지역정보개발원 섹션에는 링크를
      // 표시하지 못하는 회귀가 있었다(2026-07-16 발견 당시엔 반영했으나 이후 이 서버로
      // 로직을 옮기며 누락됨). 다른 소스와 동일하게 detailUrl로 통일해 반환한다.
      detailUrl: it.LINK || null,
    }),
  },
  kospo: {
    label: "한국남부발전(주)_입찰공고현황",
        // ★ 페이지 상한 999 — 실측 시점에 resultCode 800이 계속 떨어져 상한을 확인하지 못했다. 값은 잠정
    monthly: true,
    monthlyRangeParams: true,
    successCodes: ["800"],
    idField: "announceno",
    titleField: "title",
    dateField: "annday3",
    buildUrl: (_m, { since, until }) =>
      `https://apis.data.go.kr/B552520/BidsInfo/getDataService?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
        strSdate: toYYYYMM(since),
        strEdate: toYYYYMM(until),
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.title,
      date: it.annday3,
      estPrice: it.estprc3 || it.estprcv3,
      deadline: it.deadl2,
      dept: it.dprtnm,
      manager: it.name,
      tel: it.ofcphn,
      id: it.announceno,
    }),
    note: "이 API는 데이터 갱신이 지연되는 경우가 있었습니다(과거 확인 기준). 매칭 0건이 계속되면 갱신 지연 가능성을 참고하세요.",
  },
  kdhc: {
    label: "한국지역난방공사_입찰정보 조회 서비스",
        // ★ 페이지 상한 999 — 실측 시점에 HTTP 504(업스트림 타임아웃)가 계속 떨어져 상한을 확인하지 못했다. 값은 잠정
    monthly: false,
    successCodes: ["00"],
    idField: "bidAnnoNo",
    titleField: "caseNm",
    dateField: "regiDt",
    buildUrl: (_m, { since, until }) =>
      `https://apis.data.go.kr/B550373/kdhcbidding2/bidding2?${qs({
        serviceKey: SERVICE_KEY,
        pageNo: 1,
        numOfRows: 999,
        startDate: toYYYYMMDD(since),
        endDate: toYYYYMMDD(until),
      })}`,
    headers: {},
    mapItem: (it) => ({
      title: it.caseNm,
      date: it.regiDt,
      bidDt: it.bidDt,
      dept: it.gdeptNm,
      status: it.status,
      id: it.bidAnnoNo,
    }),
  },
};

/**
 * 기관 소스 한 번 조회. `totalCount`가 한 페이지에 안 담기면 MAX_EXTRA_PAGES까지 이어 받고,
 * 그래도 남으면 truncations에 기록한다.
 *
 * ★ 종전에는 `pageNo=1`만 부르고 `totalCount`를 읽지 않아 조용히 잘렸다. 실측(2026-08):
 *   방위사업청 해외입찰이 7,205건 중 100건(1.4%)만, 지역정보개발원이 413건 중 100건만,
 *   마사회가 317건 중 100건만 반환되고 있었다.
 *
 * ★ 종료 판정에 `totalCount`를 쓰지 않는다 — 지역정보개발원은 999 요청에 436행을 주는데
 *   `totalCount`는 413이었다(응답이 total보다 많다). **받은 행이 0이거나 요청한 페이지
 *   크기보다 적으면 중단**하는 쪽이 안전하다. totalCount는 페이지 수 상한 계산에만 쓴다.
 */
async function fetchOneAgencyCall(cfg, url, errors, agencyKey, extra = {}, truncations = []) {
  const rows = cfg.numOfRows ?? 100;

  const fetchPage = async (pageNo) => {
    const pageUrl =
      pageNo === 1 ? url : url.replace(/([?&])pageNo=\d+/, `$1pageNo=${pageNo}`);
    const { status, text } = await rawFetch(pageUrl, cfg.headers || {}, cfg.timeoutMs);
    const { data, format, error } = parseResponse(text);
    if (format === "error") throw new Error(`parse error: ${error}`);
    const resultCode = getResultCode(data);
    if (!cfg.successCodes.includes(resultCode)) {
      throw new Error(`resultCode=${resultCode} httpStatus=${status}`);
    }
    return { items: getItems(data), totalCount: getTotalCount(data) ?? 0 };
  };

  try {
    const first = await fetchPage(1);
    const out = [...first.items];
    const total = first.totalCount;

    // 첫 페이지가 꽉 찼으면 더 있을 수 있다. totalCount는 부정확할 수 있으므로
    // "가득 찬 페이지가 왔다"를 계속 받는 조건으로 삼는다.
    if (out.length >= rows) {
      const cap = total > rows ? Math.min(Math.ceil(total / rows), 1 + MAX_EXTRA_PAGES) : 1 + MAX_EXTRA_PAGES;
      for (let pg = 2; pg <= cap; pg++) {
        const got = await fetchPage(pg);
        if (got.items.length === 0) break;
        out.push(...got.items);
        if (got.items.length < rows) break;
      }
      if (total > out.length) {
        truncations.push({
          agency: agencyKey,
          ...extra,
          받은건수: out.length,
          전체건수: total,
          안내: `${cfg.label}이 ${total}건인데 ${out.length}건만 받았습니다. 기간을 좁혀 다시 조회하세요.`,
        });
      }
    }
    return out.map(cfg.mapItem);
  } catch (e) {
    errors.push({ agency: agencyKey, ...extra, error: e.message });
    return [];
  }
}

// 기관 1곳을 조회한다. keywords 생략 시 DEFAULT_KEYWORDS.
// 서버 쪽에 키워드 파라미터가 없는 API(대부분)는 전체를 가져온 뒤 클라이언트에서 필터링하고,
// dapa_bid처럼 키워드 파라미터가 있는 API는 키워드별로 호출한다.
export async function scanAgencyBids({ agency, keywords, since, until } = {}) {
  const cfg = AGENCY_CONFIGS[agency];
  if (!cfg) {
    return { agency, error: `알 수 없는 기관 코드입니다. 사용 가능: ${AGENCY_LIST.join(", ")}` };
  }
  const kws = keywords && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const range = clampRange(since, until);
  const errors = [];
  const truncations = [];
  let rawItems = [];

  if (cfg.perKeyword) {
    for (const kw of kws) {
      const url = cfg.buildUrl(null, { since: range.since, until: range.until, keyword: kw });
      const found = await fetchOneAgencyCall(cfg, url, errors, agency, { keyword: kw }, truncations);
      rawItems = rawItems.concat(found);
    }
  } else if (cfg.monthly) {
    const months = monthsBetween(range.since, range.until);
    for (const month of months) {
      const url = cfg.buildUrl(month, { since: range.since, until: range.until });
      const found = await fetchOneAgencyCall(cfg, url, errors, agency, { month }, truncations);
      rawItems = rawItems.concat(found);
    }
  } else {
    const url = cfg.buildUrl(null, { since: range.since, until: range.until });
    rawItems = await fetchOneAgencyCall(cfg, url, errors, agency, {}, truncations);
  }

  rawItems = dedupeBy(rawItems, (it) => (cfg.idField ? it.id : `${normalizeSpace(it.title)}_${it.date}`));

  // 키워드 파라미터가 서버에 없는 API는 클라이언트에서 제목 필드 기준으로 재필터링.
  const filtered = cfg.perKeyword
    ? rawItems
    : rawItems.filter((it) => matchesKeywords(it.title, kws));

  // 날짜 필드가 있는 항목은 since 이후 것만 남긴다 (문자열 비교, 포맷이 YYYYMMDD.. 계열이라 가능).
  const dateFiltered = filtered.filter((it) => {
    if (!it.date) return true;
    const d = String(it.date).replace(/[^0-9]/g, "");
    return d.length >= 8 ? d.slice(0, 8) >= toYYYYMMDD(range.since) : true;
  });

  return {
    agency,
    label: cfg.label,
    since: range.since,
    until: range.until,
    truncatedTo27Days: range.truncated,
    keywords: kws,
    items: dateFiltered,
    totalRaw: rawItems.length,
    note: cfg.note || null,
    errors,
    ...(truncations.length
      ? { 잘림: true, 잘린조회: truncations }
      : { 잘림: false }),
    유의사항: [
      ...(truncations.length
        ? [
            `★ 조회 ${truncations.length}건이 반환 상한에 걸려 일부만 담겼습니다 — 전수가 아닙니다. 건수·합계를 내지 말고 잘린조회에 적힌 구간만 좁혀 다시 조회하세요.`,
          ]
        : []),
      // ★ 오류가 났는데 결과가 0건이면 "발주 없음"으로 오독되기 쉽다. errors에만 담아두지
      //   않고 유의사항으로 올린다(실측: 남부발전 resultCode 800, 지역난방 HTTP 504가
      //   계속 떨어지는데 결과는 조용히 0건이었다).
      ...(errors.length && dateFiltered.length === 0
        ? [
            `★★ **조회가 실패했습니다 — 0건은 "발주가 없다"는 뜻이 아닙니다.** 업스트림 오류 ${errors.length}건: ${errors
              .map((e) => e.error)
              .slice(0, 3)
              .join(" / ")}. 이 결과로 "해당 기관 발주 없음"이라고 답하지 마세요.`,
          ]
        : []),
      ...(errors.length && dateFiltered.length > 0
        ? [
            `일부 구간에서 업스트림 오류 ${errors.length}건이 있었습니다 — 반환된 ${dateFiltered.length}건은 성공한 구간만의 결과입니다.`,
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// 13) 방위사업청 D2B 조달계획 — ID(dcsNo) 기반, 날짜 필터 없음.
//     "신규" 판정(seen 파일 비교)은 이 서버가 상태를 갖지 않으므로 호출하는 쪽(에이전트)의
//     책임입니다. 이 도구는 매번 "현재 조달계획 전체 중 키워드 매칭분"을 반환합니다.
// ---------------------------------------------------------------------------

export async function scanDapaPlan({ keywords } = {}) {
  const kws = keywords && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const errors = [];
  let items = [];
  for (const kw of kws) {
    const url = `http://openapi.d2b.go.kr/openapi/service/PrcurePlanInfoService/getDmstcPrcurePlanList?${qs({
      serviceKey: SERVICE_KEY,
      pageNo: 1,
      numOfRows: 100,
      reprsntPrdlstNm: kw,
    })}`;
    try {
      const { status, text } = await rawFetch(url);
      const { data, format, error } = parseResponse(text);
      if (format === "error") {
        errors.push({ keyword: kw, error: `parse error: ${error}` });
        continue;
      }
      const resultCode = getResultCode(data);
      if (resultCode !== "00") {
        errors.push({ keyword: kw, error: `resultCode=${resultCode} httpStatus=${status}` });
        continue;
      }
      const found = getItems(data).map((it) => ({
        title: it.reprsntPrdlstNm,
        org: it.ornt,
        demandYear: it.demandYear,
        orderPrearngeMt: it.orderPrearngeMt,
        excutTy: it.excutTy,
        cntrctMth: it.cntrctMth,
        status: it.progrsSttus,
        id: it.dcsNo,
        budget: it.budgetAmount || null,
      }));
      items = items.concat(found);
    } catch (e) {
      errors.push({ keyword: kw, error: e.message });
    }
  }
  items = dedupeBy(items, (it) => it.id).filter((it) => matchesKeywords(it.title, kws));
  return { items, keywords: kws, errors };
}

// ---------------------------------------------------------------------------
// 14) NIA 알림마당 입찰공고 게시판 — Open API 없음, HTML 목록을 정규식으로 파싱.
//     "신규" 판정(seen 파일 비교)도 13번과 마찬가지로 에이전트 책임입니다.
// ---------------------------------------------------------------------------

export async function scanNiaBoard({ pages = 5, keywords } = {}) {
  const kws = keywords && keywords.length ? keywords : DEFAULT_KEYWORDS;
  const errors = [];
  const items = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://www.nia.or.kr/site/nia_kor/ex/bbs/List.do?cbIdx=78336&pageIndex=${p}`;
    try {
      const { text } = await rawFetch(url);
      // 링크 앵커 블록 단위로 분리해서 제목과 날짜, bcIdx를 함께 추출.
      const anchorRe = /<a[^>]*onclick="[^"]*doBbsFView\('78336','(\d+)'[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      const blocks = [];
      while ((m = anchorRe.exec(text)) !== null) {
        blocks.push({ bcIdx: m[1], titleRaw: m[2], index: m.index });
      }
      const dateRe = /<em>(\d{4}\.\d{2}\.\d{2})<\/em>/g;
      const dates = [];
      let dm;
      while ((dm = dateRe.exec(text)) !== null) {
        dates.push({ date: dm[1], index: dm.index });
      }
      for (const b of blocks) {
        // 앵커 블록 안에는 제목 외에 "첨부파일 있음"/"new" 같은 배지 텍스트도 함께 들어있어,
        // 태그 제거 후 공백을 한 칸으로 합치고, 그 뒤에 오는 배지 텍스트는 잘라낸다
        // (2026-07-24 실제 응답으로 확인된 패턴 — 정확한 마크업이 바뀌면 이 휴리스틱도
        // 갱신이 필요할 수 있다).
        let title = b.titleRaw
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        title = title.replace(/\s*(첨부파일\s*있음|첨부파일|\bnew\b).*$/i, "").trim();
        if (!title) continue;
        // 해당 블록 뒤에 가장 가까운 날짜를 매칭.
        const nearestDate = dates.find((d) => d.index >= b.index);
        items.push({
          title,
          bcIdx: b.bcIdx,
          date: nearestDate ? nearestDate.date : null,
          detailUrl: `https://www.nia.or.kr/site/nia_kor/ex/bbs/View.do?cbIdx=78336&bcIdx=${b.bcIdx}&parentSeq=${b.bcIdx}`,
        });
      }
    } catch (e) {
      errors.push({ page: p, error: e.message });
    }
  }
  const deduped = dedupeBy(items, (it) => it.bcIdx);
  const filtered = deduped.filter((it) => matchesKeywords(it.title, kws));
  return { items: filtered, allFetchedIds: deduped.map((it) => it.bcIdx), keywords: kws, errors };
}

// ---------------------------------------------------------------------------
// 공휴일 정보 (한국천문연구원 특일정보)
// ---------------------------------------------------------------------------

export async function getHolidayInfo({ year, month } = {}) {
  const url = `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo?${qs({
    solYear: year,
    solMonth: String(month).padStart(2, "0"),
    ServiceKey: SERVICE_KEY,
    _type: "json",
    numOfRows: 30,
  })}`;
  try {
    const { status, text } = await rawFetch(url);
    const { data, format, error } = parseResponse(text);
    if (format === "error") {
      return { error: `parse error: ${error}`, raw: text.slice(0, 300) };
    }
    const resultCode = getResultCode(data);
    if (resultCode !== "00") {
      return { error: `resultCode=${resultCode} httpStatus=${status}` };
    }
    const items = getItems(data).map((it) => ({
      dateName: it.dateName,
      locdate: String(it.locdate),
      isHoliday: it.isHoliday,
    }));
    return { items };
  } catch (e) {
    return { error: e.message };
  }
}
