// public-data-portal-mcp / lib/ftc_client.js
//
// 공정거래위원회 가맹사업 정보제공시스템(franchise.ftc.go.kr) 오픈API 래퍼.
//
// ★ 이 API는 공공데이터포털(data.go.kr)이 아니라 공정위가 직접 운영하는 별도 포털이다.
//   인증키도 별도로 발급받아야 하고(환경변수 FTC_FRANCHISE_KEY), 인증키 파라미터명은
//   data.go.kr 계열의 ServiceKey가 아니라 serviceKey(첫 글자 소문자)다.
//
// 제공 오퍼레이션 (활용가이드 기준, 전부 GET):
//   search.do?type=list     — 정보공개서 공개본 목록 (필수: yr, serviceKey)
//   search.do?type=title    — 정보공개서 목차       (필수: jngIfrmpSn, serviceKey)
//   search.do?type=content  — 정보공개서 본문 XML   (필수: jngIfrmpSn, serviceKey)
//   viewer.do               — 정보공개서 뷰어 HTML  (필수: jngIfrmpSn, serviceKey)
//
// ★ 목록 조회에는 회사명·브랜드명·업종 필터가 규격 자체에 없다. corpNm 같은 이름을 넣어도
//   에러 없이 전체가 그대로 돌아온다(data.go.kr 계열과 같은 "조용한 실패"). 따라서 회사로
//   좁히려면 해당 연도 전량을 받아 응답의 brno(사업자등록번호)로 걸러야 한다. 다행히
//   numOfRows를 크게 주면 한 해치를 한 번에 받을 수 있다(실측: 2025년 2,728건 단일 호출).

import { XMLParser } from "fast-xml-parser";
import { resolveBizNo } from "./bizno_resolver.js";

const FTC_BASE = "https://franchise.ftc.go.kr/api";

export const FTC_KEY = process.env.FTC_FRANCHISE_KEY || "";
export const FTC_KEY_SOURCE = FTC_KEY ? "FTC_FRANCHISE_KEY" : "미설정";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const xmlParser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false });

// 정보공개서 105개 절 가운데 기업분석·제휴검토·M&A 실사에서 먼저 보는 절.
// attr 코드는 본문 XML의 h1~h5 태그 attr 속성값이며, 서식이 바뀌어도 유지되는 의미 코드다.
export const CORE_SECTIONS = [
  "JNGHDQRTRS_GNRL_INFO",          // 가맹본부 일반 정보(설립일·사업자등록일 포함)
  "SPCL_PRTCT_INFO",               // 특수관계인
  "JNGHDQRTRS_ACPTN_MERGE_INFO",   // 인수합병 내역
  "RB_TTYR_FNNR_STUS",             // 직전 3개 사업연도 재무상황(재무상태표·손익계산서)
  "RB_TTYR_SLS_AMT_STUS",          // 가맹사업 관련 매출액
  "JNGHDQRTRS_EXCTV_CARR_INFO",    // 임원 명단 및 사업경력
  "JNGHDQRTRS_RB_BIZ_YR_EMP_CNT",  // 직전 사업연도 말 임직원 수
  "INDUTY",                        // 업종
  "RB_TTYR_BSN_FRCS_DMS_CNT",      // 직전 3년 가맹점 및 직영점 총 수
  "RB_TTYR_FRCS_CNT",              // 직전 3년 가맹점 수(신규개점·계약종료·해지·명의변경)
  "RB_BIZ_YR_FYER_AVRG_SLS_AMT",   // 가맹점사업자 연간 평균 매출액
  "FRCS_AVRG_BSN_PD",              // 가맹점 평균 영업기간
  "FRCS_BZMN_FRST_JNNT_INFO",      // 최초 가맹금
  "ADVRTS_PROMTN_EXPND_DTLS",      // 광고판촉 지출 내역
  "COREC_ACTN_INFO",               // 공정위·시도지사 시정조치 등
  "CVLST_INFO",                    // 민사소송·화해
  "PETY_ADJU_INFO",                // 형의 선고
];

// ---------------------------------------------------------------------------
// 공통 유틸
// ---------------------------------------------------------------------------

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
      "공정위 가맹사업 정보제공시스템 인증키가 설정되지 않았습니다. 환경변수 " +
      "FTC_FRANCHISE_KEY를 설정하세요(공공데이터포털 키 DATA_PORTAL_KEY와는 별개의 키입니다).",
    keySource: FTC_KEY_SOURCE,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 이 서버는 짧은 간격으로 연달아 호출하면 연결을 그냥 끊는다(ECONNRESET / connect timeout).
//   인증이나 파라미터 문제가 아니라 서버 쪽 유량 제어이므로, 간격을 두고 재시도하면 살아난다.
//   한 번 실패했다고 "이 API는 안 된다"고 판단하지 말 것.
async function ftcFetch(path, params, timeoutMs = 30000, retries = 3) {
  // serviceKey는 발급 시점에 이미 URL 인코딩된 형태(%2F 포함)로 주어진다.
  // qs()로 다시 인코딩하면 %2F가 %252F가 되어 인증이 깨지므로 직접 이어붙인다.
  const url = `${FTC_BASE}/${path}?${qs(params)}&serviceKey=${FTC_KEY}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/xml,text/xml,*/*" },
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, text, attempts: attempt + 1 };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `공정위 서버 연결 실패(${retries + 1}회 시도): ${lastErr?.message || lastErr}. ` +
      "이 서버는 연달아 호출하면 연결을 끊으므로 잠시 뒤 다시 시도하세요."
  );
}

// 인증키·필수 파라미터 오류는 HTTP 200에 Error/errorCn 형태로 온다(공공데이터포털의
// response.header 구조가 아니라 최상위 평면 구조라는 점에 주의).
function detectError(text) {
  const m = /<errorCn>([\s\S]*?)<\/errorCn>/.exec(text);
  return m ? m[1].trim() : null;
}

function normalizeCorpKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// 1. 정보공개서 목록 (type=list)
// ---------------------------------------------------------------------------

const listCache = new Map(); // yr -> { items, total }

async function fetchYearAll(year) {
  if (listCache.has(year)) return listCache.get(year);
  const { status, text } = await ftcFetch(
    "search.do",
    { type: "list", yr: year, numOfRows: 5000, pageNo: 1 },
    60000
  );
  const err = detectError(text);
  if (err) throw new Error(`공정위 API 오류: ${err} (HTTP ${status})`);
  const parsed = xmlParser.parse(text);
  let items = parsed?.root?.items?.item ?? [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  const total = Number(parsed?.root?.totalCount ?? items.length);
  const out = { items, total };
  listCache.set(year, out);
  return out;
}

/**
 * 정보공개서 공개본 목록을 조회한다.
 *
 * 원 API에는 이름 필터가 없으므로, companyName·corpName·brandName·bizNo 중 하나라도 주면
 * 해당 연도 전량을 한 번에 받아 서버에서 걸러낸다(응답의 filteredLocally=true).
 */
export async function searchFranchiseDisclosure({
  year,
  companyName,
  bizNo,
  corpName,
  brandName,
  pageNo = 1,
  numOfRows = 100,
  limit = 50,
} = {}) {
  if (!FTC_KEY) return keyMissing();
  if (!year) return { ok: false, reason: "year(기준년도)는 필수입니다. 예: 2025" };

  const resolution = { 입력회사명: companyName || null };
  let targetBizNo = bizNo ? String(bizNo).replace(/[^0-9]/g, "") : null;

  if (!targetBizNo && companyName) {
    const r = await resolveBizNo(companyName);
    if (r.ok) {
      targetBizNo = r.bizNo;
      resolution.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no) → brno 완전일치";
      resolution.bizNo = r.bizNo;
      resolution.matchedCorpName = r.matchedCorpName;
      resolution.indexGeneratedAt = r.indexGeneratedAt;
    } else {
      resolution.resolvedVia = "가맹본부명 부분검색(폴백)";
      resolution.bizNo = null;
      resolution.reason = r.reason;
    }
  } else if (targetBizNo) {
    resolution.resolvedVia = "bizNo 직접 지정 → brno 완전일치";
    resolution.bizNo = targetBizNo;
  }

  const nameNeedle = corpName || (!targetBizNo && companyName) || null;
  const filtering = Boolean(targetBizNo || nameNeedle || brandName);

  let items;
  let total;
  let filteredLocally = false;

  if (filtering) {
    const all = await fetchYearAll(year);
    total = all.total;
    const needleKey = nameNeedle ? normalizeCorpKey(nameNeedle) : null;
    items = all.items.filter((it) => {
      if (targetBizNo && String(it.brno) !== targetBizNo) return false;
      if (needleKey && !normalizeCorpKey(it.corpNm).includes(needleKey)) return false;
      if (brandName && !String(it.brandNm || "").includes(brandName)) return false;
      return true;
    });
    filteredLocally = true;
  } else {
    const { status, text } = await ftcFetch(
      "search.do",
      { type: "list", yr: year, pageNo, numOfRows },
      60000
    );
    const err = detectError(text);
    if (err) return { ok: false, reason: `공정위 API 오류: ${err}`, httpStatus: status };
    const parsed = xmlParser.parse(text);
    let arr = parsed?.root?.items?.item ?? [];
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];
    items = arr;
    total = Number(parsed?.root?.totalCount ?? arr.length);
  }

  const sliced = items.slice(0, limit).map((it) => ({
    jngIfrmpSn: String(it.jngIfrmpSn),
    corpNm: it.corpNm,
    brandNm: it.brandNm,
    brno: String(it.brno ?? ""),
    jngIfrmpRgsno: String(it.jngIfrmpRgsno ?? ""),
  }));

  return {
    ok: true,
    year: String(year),
    totalCountInYear: total,
    matched: items.length,
    returned: sliced.length,
    filteredLocally,
    resolution: Object.keys(resolution).length > 1 ? resolution : null,
    items: sliced,
    note:
      "jngIfrmpSn(정보공개서 일련번호)을 get_franchise_disclosure에 넣으면 본문 전체를 조회할 수 " +
      "있습니다. 한 가맹본부가 브랜드마다 별도 정보공개서를 등록하므로 같은 brno가 여러 건 나올 수 " +
      "있습니다. " +
      (filteredLocally
        ? "원 API에는 회사명·브랜드명 필터가 없어 해당 연도 전량을 받아 서버에서 걸렀습니다."
        : "yr(기준년도)은 정보공개서가 공개된 연도 기준이라, 찾는 가맹본부가 없으면 인접 연도도 확인하세요."),
  };
}

// ---------------------------------------------------------------------------
// 2. 정보공개서 목차·본문 (type=title / type=content)
// ---------------------------------------------------------------------------

const CELL_SEP = "\u0001"; // 셀 경계 표시용 제어문자 (본문에는 나타나지 않는 값)

// 본문 XML은 각 표 칸마다 인라인 CSS가 붙어 있어 원문 크기의 대부분이 서식이다
// (실측: 578KB 중 순수 텍스트 38KB). 표는 행·열 구조를 보존해야 재무·가맹점수를 읽을 수
// 있으므로, 셀 경계만 남기고 나머지 태그를 걷어낸다.
function stripToText(fragment) {
  let s = fragment;
  s = s.replace(/<\/t[dh]>/gi, CELL_SEP);
  s = s.replace(/<\/tr>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  const lines = s.split("\n").map((line) => {
    const cells = line
      .split(CELL_SEP)
      .map((c) => c.replace(/\s+/g, " ").trim())
      .filter((c) => c !== "");
    return cells.join(" | ");
  });
  return lines.filter((l) => l !== "").join("\n");
}

const HEADING_RE = /<(h[1-5])\s+attrb_sn="([^"]*)"\s+attr="([^"]*)"\s+title="([^"]*)"[^>]*>/g;

function splitSections(contentXml) {
  const marks = [];
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(contentXml)) !== null) {
    marks.push({
      index: m.index,
      level: Number(m[1].slice(1)),
      attrbSn: m[2],
      attr: m[3],
      title: m[4],
    });
  }
  return marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : contentXml.length;
    const body = contentXml.slice(mk.index, end).replace(HEADING_RE, " ");
    return { ...mk, text: stripToText(body) };
  });
}

/**
 * 정보공개서 본문을 조회한다.
 *
 * mode
 *   core    (기본) 재무·가맹점수·평균매출 등 핵심 절만
 *   toc     목차만 (본문을 받지 않고 type=title 호출)
 *   section section으로 지정한 절(attr 코드 또는 제목 일부)의 전문
 *   keyword 전체 절 본문을 훑어 keyword가 나온 절만
 *   full    전체 절 전문
 */
export async function getFranchiseDisclosure({
  jngIfrmpSn,
  mode = "core",
  section,
  keyword,
  maxChars = 60000,
} = {}) {
  if (!FTC_KEY) return keyMissing();
  if (!jngIfrmpSn) {
    return {
      ok: false,
      reason:
        "jngIfrmpSn(정보공개서 일련번호)은 필수입니다. search_franchise_disclosure로 먼저 찾으세요.",
    };
  }

  if (mode === "toc") {
    const { status, text } = await ftcFetch("search.do", { type: "title", jngIfrmpSn }, 30000);
    const err = detectError(text);
    if (err) return { ok: false, reason: `공정위 API 오류: ${err}`, httpStatus: status };
    const parsed = xmlParser.parse(text);
    let toc = parsed?.root?.tocList?.tocObj ?? [];
    if (!Array.isArray(toc)) toc = toc ? [toc] : [];
    return {
      ok: true,
      jngIfrmpSn: String(jngIfrmpSn),
      mode: "toc",
      sectionCount: toc.length,
      toc: toc.map((t) => ({
        attrbMnno: t["@_attrbMnno"],
        level: t["@_level"] || null,
        hasChild: t["@_hasChild"] === "true",
        title: t.title,
      })),
      note:
        "목차의 attrbMnno는 본문 절의 attrb_sn과 같은 코드입니다. 특정 절 전문이 필요하면 " +
        'mode="section"에 그 절의 제목 일부나 attr 코드를 넣으세요.',
    };
  }

  const { status, text } = await ftcFetch("search.do", { type: "content", jngIfrmpSn }, 60000);
  const err = detectError(text);
  if (err) return { ok: false, reason: `공정위 API 오류: ${err}`, httpStatus: status };

  const all = splitSections(text);
  if (all.length === 0) {
    return {
      ok: false,
      reason: "본문 XML에서 절 구조를 찾지 못했습니다. 서식이 바뀌었을 수 있습니다.",
      httpStatus: status,
      rawLength: text.length,
    };
  }

  const totalChars = all.reduce((a, s) => a + s.text.length, 0);
  let picked;
  let modeNote;

  if (mode === "full") {
    picked = all;
    modeNote = "전체 절 전문입니다.";
  } else if (mode === "section") {
    if (!section) return { ok: false, reason: 'mode="section"에는 section이 필요합니다.' };
    const needle = String(section).toLowerCase();
    picked = all.filter(
      (s) =>
        s.attr.toLowerCase() === needle ||
        s.attr.toLowerCase().includes(needle) ||
        s.title.includes(section)
    );
    modeNote = `section="${section}"과 일치한 절만 반환했습니다.`;
  } else if (mode === "keyword") {
    if (!keyword) return { ok: false, reason: 'mode="keyword"에는 keyword가 필요합니다.' };
    picked = all.filter((s) => s.text.includes(keyword) || s.title.includes(keyword));
    modeNote = `전체 절 본문을 검색해 "${keyword}"가 나온 절만 반환했습니다.`;
  } else {
    const order = new Map(CORE_SECTIONS.map((a, i) => [a, i]));
    picked = all
      .filter((s) => order.has(s.attr))
      .sort((a, b) => order.get(a.attr) - order.get(b.attr));
    modeNote =
      "핵심 절만 반환했습니다. 나머지 절도 모두 조회 가능합니다 — " +
      'mode="toc"로 목차를, mode="section"으로 특정 절을, mode="keyword"로 본문 전체 검색을, ' +
      'mode="full"로 전문을 받으세요.';
  }

  // 컨텍스트 보호: 상한을 넘으면 뒤쪽 절을 잘라내되, 무엇이 잘렸는지 반드시 밝힌다.
  const out = [];
  let used = 0;
  let truncatedAt = null;
  for (const s of picked) {
    if (used + s.text.length > maxChars) {
      truncatedAt = s.attr;
      break;
    }
    out.push({ attr: s.attr, attrbSn: s.attrbSn, level: s.level, title: s.title, text: s.text });
    used += s.text.length;
  }

  return {
    ok: true,
    jngIfrmpSn: String(jngIfrmpSn),
    mode,
    sectionCountTotal: all.length,
    sectionCountMatched: picked.length,
    sectionCountReturned: out.length,
    charsTotal: totalChars,
    charsReturned: used,
    truncatedAt,
    sections: out,
    viewerUrl: `${FTC_BASE}/viewer.do?jngIfrmpSn=${jngIfrmpSn}`,
    note:
      modeNote +
      (truncatedAt
        ? ` 상한 maxChars(${maxChars}자)에 걸려 ${truncatedAt} 절부터 잘렸습니다 — maxChars를 올리거나 mode="section"으로 나눠 받으세요.`
        : "") +
      " 정보공개서는 등록 시점의 자료이므로 최신 실적과 다를 수 있습니다 — 조회한 기준년도를 답변에 함께 밝히세요.",
  };
}
