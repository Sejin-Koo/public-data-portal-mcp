// public-data-portal-mcp / lib/kiscon_client.js
//
// 국토교통부 키스콘(KISCON) — 건설업체정보 + 건설공사대장 통보 통계.
//
// 두 서비스 모두 공공데이터포털 공용키(DATA_PORTAL_KEY)를 쓰고, 날짜 파라미터도 sDate·eDate로
// 같다. 응답 포맷은 `_type=json`을 줘야 JSON으로 온다(주지 않으면 XML).
//
//   ConAdminInfoSvc1/<오퍼레이션>   건설업체정보 8종 (2003-01-01 이후 공시분)
//   ConStatInfoSvc/StatCnt          건설공사대장 통보 건수
//   ConStatInfoSvc/StatAmt          건설공사대장 통보 금액
//
// ★ 이 API에는 업체명·사업자등록번호 검색 파라미터가 없다. `ncrGsKname` 같은 이름을 넣어도
//   에러 없이 전체 건수가 그대로 돌아온다. 그래서 회사로 좁히려면 기간 전량을 받아 응답의
//   `ncrMasterNum`(사업자등록번호)·업체명으로 서버에서 걸러야 한다. 동작하는 필터는 지역
//   (`ncrAreaName`·`ncrAreaDetailName`)뿐이다.
//
// ★ 기간 기반 조회다. "이 회사의 20년 행정처분 이력"처럼 장기 조회는 sDate/eDate를 길게
//   잡아야 하므로 응답이 급격히 커진다. 도구는 조회한 기간을 응답에 명시하고, 그 기간 밖은
//   확인하지 않았음을 밝힌다 — **0건을 "처분 이력이 없다"로 답하지 말 것.**
//
// ★ 같은 처분이 여러 행으로 나온다. 한 업체가 여러 업종 면허를 가지면 업종·등록번호별로
//   행이 갈리므로, 행 수와 실제 처분 건수가 다르다(실측 2003~2026 전 기간: 53,054행 /
//   고유 ncrGsSeq 47,821건, 약 10% 중복). 건수를 셀 때는 반드시 ncrGsSeq 고유값으로 센다.
//
// ★ 기간을 잘게 쪼개 조회하면 경계에 걸친 건이 양쪽에 중복 계상되어 총계가 부풀려진다
//   (실측: 2003~2026을 단일 조회하면 53,054행인데 8구간으로 나누면 53,229행). 단일 장기
//   조회에 누락은 없음을 확인했으므로(월 조회 고유 897건이 전 기간 조회 결과에 모두 포함)
//   **구간을 나누지 말고 한 번에 조회한 뒤 페이지를 끝까지 돌 것.**
//
// ★ ncrGsDate(공시일)에는 오류값이 섞여 있다(실측 범위 2000-08-07 ~ 2104-03-28). 반면
//   ncrGsRegdate(등록일)는 2003-01-04 ~ 오늘로 정상이고 sDate/eDate 필터도 등록일 계열을
//   따른다. 공시일로 기간을 판정하거나 정렬하면 어긋난다.

import { SERVICE_KEY, SERVICE_KEY_SOURCE } from "./pdp_client.js";
import { resolveBizNo } from "./bizno_resolver.js";

const FIRM_BASE = "https://apis.data.go.kr/1613000/ConAdminInfoSvc1";
const STAT_BASE = "https://apis.data.go.kr/1613000/ConStatInfoSvc";
const MAX_ROWS = 5000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 건설업체정보 8개 오퍼레이션. key는 도구에서 쓰는 짧은 이름이다.
export const FIRM_OPS = {
  reg: { op: "GongsiReg", label: "건설업 신규등록" },
  renew: { op: "GongsiRenew", label: "등록기준사항 신고" },
  trans: { op: "GongsiTrans", label: "양도신고" },
  union: { op: "GongsiUnion", label: "법인합병 신고" },
  inheri: { op: "GongsiInheri", label: "상속신고" },
  admi: { op: "GongsiAdmi", label: "행정처분" },
  admiPD: { op: "GongsiAdmiPD", label: "행정처분 가처분" },
  cess: { op: "GongsiCess", label: "폐업신고" },
};

// 통보 통계의 코드표 — 응답 데이터에서 직접 확인한 값이다(행정표준 시도코드와 다르다).
export const STAT_AREA_CODES = {
  "전체": "00", 서울: "11", 부산: "21", 대구: "22", 인천: "23", 광주: "24", 대전: "25",
  울산: "26", 세종: "29", 경기: "31", 강원: "32", 충북: "33", 충남: "34", 전북: "35",
  전남: "36", 경북: "37", 경남: "38", 제주: "39",
};
export const STAT_DOGUB_CODES = { 원도급: "1", 하도급: "2" };
export const STAT_BALJU_CODES = { 공공: "0", "민간(법인)": "1", 민간법인: "1", "민간(개인)": "2", 민간개인: "2", "전체": "3" };

// 통보 통계는 2020-07-15부터 제공된다(그 이전 날짜는 0건).
const STAT_MIN_DATE = "20200715";

const REGISTRY_KINDS = ["reg", "renew", "trans", "union", "inheri"];
const SANCTION_KINDS = ["admi", "admiPD", "cess"];

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
    reason: "공공데이터포털 인증키가 설정되지 않았습니다. 환경변수 DATA_PORTAL_KEY를 설정하세요.",
    keySource: SERVICE_KEY_SOURCE,
  };
}

function onlyDigits(s) {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

function ymd(v) {
  const d = onlyDigits(v);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : v || null;
}

function normalizeCorpKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 이 서버도 연달아 호출하면 연결을 끊는 경우가 있다. 인증 문제가 아니므로 재시도로 흡수한다.
async function callKiscon(baseUrl, op, params, { timeoutMs = 60000, retries = 2 } = {}) {
  const url = `${baseUrl}/${op}?serviceKey=${SERVICE_KEY}&_type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
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
      const svcErr = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (svcErr) {
        throw new Error(
          `${svcErr.errMsg || "오류"} (${svcErr.returnAuthMsg || ""}, code ${svcErr.returnReasonCode || "?"})`
        );
      }
      const header = data?.response?.header;
      if (header && header.resultCode !== "00") {
        throw new Error(`${op}: ${header.resultMsg} (resultCode ${header.resultCode})`);
      }
      const body = data?.response?.body ?? {};
      // 0건이면 items가 빈 문자열로 온다.
      let items = body.items;
      if (!items || typeof items === "string") items = [];
      else items = Array.isArray(items.item) ? items.item : items.item ? [items.item] : [];
      return { items, totalCount: Number(body.totalCount ?? items.length) };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchAllPages(baseUrl, op, params, maxPages = 20) {
  const first = await callKiscon(baseUrl, op, { ...params, pageNo: 1, numOfRows: MAX_ROWS });
  let items = first.items;
  const pages = Math.min(Math.ceil(first.totalCount / MAX_ROWS), maxPages);
  for (let p = 2; p <= pages; p++) {
    const next = await callKiscon(baseUrl, op, { ...params, pageNo: p, numOfRows: MAX_ROWS });
    items = items.concat(next.items);
  }
  return {
    items,
    totalCount: first.totalCount,
    truncated: first.totalCount > items.length,
  };
}

function checkDates(sDate, eDate) {
  if (!sDate || !eDate) {
    return "sDate·eDate(YYYYMMDD)는 필수입니다. 이 API는 기간 기반 조회이며 2003-01-01 이후 공시분을 제공합니다.";
  }
  if (onlyDigits(sDate).length !== 8 || onlyDigits(eDate).length !== 8) {
    return "sDate·eDate는 YYYYMMDD 8자리여야 합니다. 예: 20260101";
  }
  return null;
}

// ★ 같은 공시 1건이 보유 업종 면허 수만큼 반복되어 내려온다. 행 수 ≠ 건수.
// ncrGsSeq가 공시 단위 식별자이며, 이것이 비어 있는 응답을 대비해 공고번호·업체명을 보조 키로 쓴다.
function seqKey(x) {
  return x.ncrGsSeq != null && x.ncrGsSeq !== ""
    ? `S${x.ncrGsSeq}`
    : `F${firmName(x) || ""}|${x.ncrGsNumber || ""}|${x.ncrGsRegdate || ""}`;
}

/** 공시 고유 건수. 행 수로 세면 부풀려진다(23년치 행정처분 기준 약 10% 차이). */
function uniqueCount(rows) {
  return new Set(rows.map(seqKey)).size;
}

/** ncrGsSeq 기준으로 묶어 대표행 하나로 만들고, 업종·등록번호는 모아서 배열로 달아둔다. */
function groupBySeq(rows) {
  const map = new Map();
  for (const x of rows) {
    const k = seqKey(x);
    let cur = map.get(k);
    if (!cur) {
      cur = { rep: x, items: new Set(), regnos: new Set() };
      map.set(k, cur);
    }
    if (x.ncrItemName) cur.items.add(String(x.ncrItemName));
    if (x.ncrItemregno) cur.regnos.add(String(x.ncrItemregno));
  }
  return [...map.values()].map((v) => ({
    ...v.rep,
    __items: [...v.items],
    __regnos: [...v.regnos],
  }));
}

// 오퍼레이션마다 업체명·대표자 필드명이 다르다(등록계열 ncrGs*, 행정처분계열 ncrAdmi*).
function firmName(x) {
  return x.ncrGsKname ?? x.ncrAdmiKname ?? x.ncrKname ?? null;
}
function firmMaster(x) {
  return x.ncrGsMaster ?? x.ncrAdmiMaster ?? null;
}
function firmAddr(x) {
  return x.ncrGsAddr ?? x.ncrAdmiAddr ?? null;
}

async function resolveTarget({ companyName, bizNo }) {
  const resolution = { 입력회사명: companyName || null };
  if (bizNo) {
    resolution.resolvedVia = "bizNo 직접 지정 → 사업자등록번호 완전일치";
    resolution.bizNo = onlyDigits(bizNo);
    return { target: onlyDigits(bizNo), resolution };
  }
  if (!companyName) return { target: null, resolution: null };
  const r = await resolveBizNo(companyName);
  if (r.ok) {
    resolution.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no) → 사업자등록번호 완전일치";
    resolution.bizNo = r.bizNo;
    resolution.matchedCorpName = r.matchedCorpName;
    resolution.indexGeneratedAt = r.indexGeneratedAt;
    return { target: r.bizNo, resolution };
  }
  resolution.resolvedVia = "업체명 부분검색(폴백)";
  resolution.bizNo = null;
  resolution.해석실패사유 = r.reason;
  resolution.note =
    "사업자등록번호 해석에 실패해 업체명 부분검색으로 걸렀습니다. 동명 업체가 섞일 수 있으니 " +
    "결과의 업체명을 확인하세요. 해석 실패는 '그 회사가 없다'는 뜻이 아닙니다.";
  return { target: null, resolution };
}

async function gatherFirmOps({ kinds, sDate, eDate, area, areaDetail, target, companyName, itemName, maxPages }) {
  // ★ 특정 업체를 찾는 조회는 한 페이지라도 빠지면 결국 '이력 없음'으로 오답하게 된다.
  // 기간을 나누어 보완하지 말고(경계 중복으로 합계가 부풀람) 단일 조회를 끝까지 페이징한다.
  const pageCap = target || companyName ? Math.max(maxPages || 0, 100) : maxPages;
  const rows = [];
  const perOp = [];
  for (const k of kinds) {
    const meta = FIRM_OPS[k];
    if (!meta) continue;
    try {
      const r = await fetchAllPages(
        FIRM_BASE,
        meta.op,
        { sDate: onlyDigits(sDate), eDate: onlyDigits(eDate), ncrAreaName: area, ncrAreaDetailName: areaDetail },
        pageCap
      );
      perOp.push({
        구분: meta.label,
        오퍼레이션: meta.op,
        기간내_전체행: r.totalCount,
        수집행: r.items.length,
        수집건수_고유: uniqueCount(r.items),
        잘림: r.truncated,
      });
      for (const x of r.items) rows.push({ __kind: meta.label, ...x });
    } catch (e) {
      perOp.push({ 구분: meta.label, 오퍼레이션: meta.op, error: String(e.message || e) });
    }
  }

  const nameKey = !target && companyName ? normalizeCorpKey(companyName) : null;
  const filtered = rows.filter((x) => {
    if (target && onlyDigits(x.ncrMasterNum) !== target) return false;
    if (nameKey && !normalizeCorpKey(firmName(x)).includes(nameKey)) return false;
    if (itemName && !String(x.ncrItemName || "").includes(itemName)) return false;
    return true;
  });
  return { perOp, rows, filtered };
}

// ---------------------------------------------------------------------------
// 도구 1 — 건설업체 등록·변동 (영업 대상 발굴)
// ---------------------------------------------------------------------------

export async function searchConstructionFirms({
  sDate,
  eDate,
  kinds = REGISTRY_KINDS,
  area,
  areaDetail,
  companyName,
  bizNo,
  itemName,
  limit = 30,
  maxPages = 20,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };

  const { target, resolution } = await resolveTarget({ companyName, bizNo });
  const { perOp, rows, filtered } = await gatherFirmOps({
    kinds: kinds.filter((k) => REGISTRY_KINDS.includes(k)),
    sDate, eDate, area, areaDetail, target, companyName, itemName, maxPages,
  });

  // ★ 같은 공시가 업종 수만큼 반복되므로 공시 단위로 묶고 업종은 배열로 합친다.
  const grouped = groupBySeq(filtered);
  const items = grouped.slice(0, limit).map((x) => ({
    구분: x.__kind,
    업체명: firmName(x),
    사업자등록번호: x.ncrMasterNum ? String(x.ncrMasterNum) : null,
    대표자: firmMaster(x),
    업종: x.__items,
    등록번호: x.__regnos,
    소재지: firmAddr(x),
    지역: [x.ncrAreaName, x.ncrAreaDetailName].filter(Boolean).join(" "),
    전화: x.ncrOffTel,
    등록일: ymd(x.ncrGsRegdate),
    공고번호: x.ncrGsNumber,
    변동사유: x.ncrGsReason && x.ncrGsReason !== "-" ? x.ncrGsReason : null,
  }));

  return {
    ok: true,
    조회기간: `${ymd(sDate)} ~ ${ymd(eDate)}`,
    오퍼레이션별: perOp,
    수집행: rows.length,
    조건일치_행수: filtered.length,
    조건일치_건수: grouped.length,
    반환: items.length,
    잘림: perOp.some((o) => o.잘림),
    resolution,
    items,
    note:
      "건설업 신규등록·등록기준사항 신고·양도·법인합병·상속 공시입니다. 원 API에 업체명·사업자등록번호 " +
      "검색 파라미터가 없어 기간 전량을 받아 서버에서 걸렀습니다(동작하는 필터는 지역뿐입니다). " +
      "★ 같은 공시 1건이 보유 업종 수만큼 행으로 반복됩니다. 건수는 반드시 조건일치_건수(공시 고유 " +
      "기준)를 쓰고 조건일치_행수를 건수로 보고하지 마세요. " +
      "★ 이 결과는 **조회한 기간의 공시분**만입니다 — 0건이 '그런 업체가 없다'는 뜻이 아니므로, " +
      "특정 회사를 찾는 것이 목적이면 기간을 넓혀 다시 조회하고 답변에 조회기간을 반드시 밝히세요. " +
      "이때 기간을 여러 구간으로 쪼개지 말고 한 번에 길게 조회하세요(구간 경계에서 같은 공시가 " +
      "중복 집계됩니다). 공시일(ncrGsDate)에는 미래·과거 오류값이 섞여 있어 등록일(ncrGsRegdate)을 씁니다.",
  };
}

// ---------------------------------------------------------------------------
// 도구 2 — 행정처분·폐업 (협력사 리스크 점검)
// ---------------------------------------------------------------------------

export async function searchConstructionSanctions({
  sDate,
  eDate,
  kinds = SANCTION_KINDS,
  area,
  areaDetail,
  companyName,
  bizNo,
  itemName,
  limit = 30,
  maxPages = 20,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };

  const { target, resolution } = await resolveTarget({ companyName, bizNo });
  const { perOp, rows, filtered } = await gatherFirmOps({
    kinds: kinds.filter((k) => SANCTION_KINDS.includes(k)),
    sDate, eDate, area, areaDetail, target, companyName, itemName, maxPages,
  });

  // ★ 같은 처분 1건이 보유 업종 수만큼 반복되므로 공시 단위로 묶는다.
  const grouped = groupBySeq(filtered);
  const items = grouped.slice(0, limit).map((x) => {
    const base = {
      구분: x.__kind,
      업체명: firmName(x),
      사업자등록번호: x.ncrMasterNum ? String(x.ncrMasterNum) : null,
      대표자: firmMaster(x),
      업종: x.__items,
      등록번호: x.__regnos,
      지역: [x.ncrAreaName, x.ncrAreaDetailName].filter(Boolean).join(" "),
      소재지: firmAddr(x),
      공시일: ymd(x.ncrGsRegdate),
      공고번호: x.ncrGsNumber,
    };
    if (x.ncrAdmiDename !== undefined) {
      base.처분명 = x.ncrAdmiDename;
      base.위반내용 = x.ecodeAdmiCon;
      base.근거조문 = x.ecodeAdmiGround;
      base.처분사유 = x.ncrAdmiReason;
      base.과징금 = x.ncrAdmiFine || 0;
      base.과태료 = x.ncrAdmiPenalty || 0;
      base.영업정지_시작 = x.ncrAdmiStopSdate && x.ncrAdmiStopSdate !== "-" ? ymd(x.ncrAdmiStopSdate) : null;
      base.영업정지_종료 = x.ncrAdmiStopEdate && x.ncrAdmiStopEdate !== "-" ? ymd(x.ncrAdmiStopEdate) : null;
      base.취소일 = x.ncrAdmiCanceldate && x.ncrAdmiCanceldate !== "-" ? ymd(x.ncrAdmiCanceldate) : null;
      base.가처분여부 = x.ncrPdStatus;
    }
    return base;
  });

  // 처분명별 건수는 눈으로 세지 말고 코드로 집계한다. 반드시 중복 제거 후 집계할 것.
  const byType = {};
  for (const x of grouped) {
    const k = x.ncrAdmiDename || x.__kind;
    byType[k] = (byType[k] || 0) + 1;
  }
  const byViolation = {};
  for (const x of grouped) {
    const k = x.ecodeAdmiCon;
    if (!k) continue;
    byViolation[k] = (byViolation[k] || 0) + 1;
  }
  const topViolations = Object.fromEntries(
    Object.entries(byViolation).sort((a, b) => b[1] - a[1]).slice(0, 15)
  );
  const money = grouped.reduce(
    (acc, x) => {
      acc.과징금 += Number(x.ncrAdmiFine || 0);
      acc.과태료 += Number(x.ncrAdmiPenalty || 0);
      return acc;
    },
    { 과징금: 0, 과태료: 0 }
  );

  return {
    ok: true,
    조회기간: `${ymd(sDate)} ~ ${ymd(eDate)}`,
    오퍼레이션별: perOp,
    수집행: rows.length,
    조건일치_행수: filtered.length,
    조건일치_건수: grouped.length,
    처분유형별: byType,
    위반내용_상위: topViolations,
    위반내용_종류수: Object.keys(byViolation).length,
    금액합계_원: money,
    반환: items.length,
    잘림: perOp.some((o) => o.잘림),
    resolution,
    items,
    note:
      "건설산업기본법에 따른 행정처분·가처분·폐업 공시입니다. 과징금·과태료 금액 단위는 원이며, " +
      "가처분(ncrPdStatus)이 걸린 건은 처분 효력이 정지된 상태일 수 있으니 취소일과 함께 확인하세요. " +
      "★ 같은 처분 1건이 보유 업종 수만큼 행으로 반복됩니다. 처분유형별·위반내용_상위·금액합계는 이미 " +
      "공시 고유 기준으로 집계했으니 그대로 쓰고, 건수는 조건일치_건수를 쓰세요(조건일치_행수는 건수가 아닙니다). " +
      "★ 이 결과는 **조회한 기간의 공시분**만입니다 — **0건을 '처분 이력이 없다'로 답하지 마세요.** " +
      "실사 목적이라면 기간을 수년 단위로 넓혀 재조회하되, 여러 구간으로 쪼개지 말고 한 번에 길게 " +
      "조회하세요(구간 경계에서 같은 공시가 중복 집계되어 합계가 부풀려집니다). 업체명·사업자등록번호 " +
      "필터를 준 조회는 자동으로 마지막 페이지까지 수집하며, 답변에는 확인한 기간을 반드시 밝히세요.",
  };
}

// ---------------------------------------------------------------------------
// 도구 3 — 건설공사대장 통보 통계 (시장 동향)
// ---------------------------------------------------------------------------

function toCode(map, v) {
  if (v === undefined || v === null || v === "") return undefined;
  const raw = String(v).trim();
  if (map[raw]) return map[raw];
  // 이미 코드로 준 경우 그대로 통과시킨다.
  return Object.values(map).includes(raw) ? raw : undefined;
}

export async function getConstructionNoticeStats({
  sDate,
  eDate,
  area,
  balju,
  dogub,
  groupBy = "balju",
  maxPages = 10,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };
  if (onlyDigits(sDate) < STAT_MIN_DATE) {
    return {
      ok: false,
      reason:
        `통보 통계는 ${ymd(STAT_MIN_DATE)}부터 제공됩니다. 그 이전 날짜를 넣으면 0건이 돌아옵니다 ` +
        "(건설업체정보는 2003-01-01부터라 시작일이 서로 다릅니다).",
    };
  }

  const areaCode = toCode(STAT_AREA_CODES, area);
  const baljuCode = toCode(STAT_BALJU_CODES, balju);
  const dogubCode = toCode(STAT_DOGUB_CODES, dogub);
  const unresolved = [
    area && !areaCode ? `area="${area}"` : null,
    balju && !baljuCode ? `balju="${balju}"` : null,
    dogub && !dogubCode ? `dogub="${dogub}"` : null,
  ].filter(Boolean);

  const params = {
    sDate: onlyDigits(sDate),
    eDate: onlyDigits(eDate),
    area: areaCode,
    balju: baljuCode,
    dogub: dogubCode,
  };
  const [cnt, amt] = await Promise.all([
    fetchAllPages(STAT_BASE, "StatCnt", params, maxPages),
    fetchAllPages(STAT_BASE, "StatAmt", params, maxPages),
  ]);

  // ★ 응답에는 areaName="전체", baljuGubun="전체" 합계 행이 실제 항목과 같은 배열에 섞여 있다.
  //   그대로 더하면 중복 계상되므로 반드시 분리한다.
  const isTotalRow = (x) => x.areaName === "전체" || x.baljuGubun === "전체";

  const amtKey = (x) => `${x.notiDate}|${x.areaCode}|${x.baljuCode}|${x.dogubCode}`;
  const amtMap = new Map(amt.items.map((x) => [amtKey(x), Number(x.amt) || 0]));

  const merged = cnt.items.map((x) => ({
    일자: ymd(x.notiDate),
    지역: x.areaName,
    발주구분: x.baljuGubun,
    도급구분: x.dogubGubun,
    건수: Number(x.cnt) || 0,
    금액: amtMap.get(amtKey(x)) ?? null,
    __total: isTotalRow(x),
  }));

  const detail = merged.filter((x) => !x.__total);
  const keyOf = (x) =>
    groupBy === "area" ? x.지역 : groupBy === "dogub" ? x.도급구분 : groupBy === "date" ? x.일자 : x.발주구분;

  const agg = {};
  for (const x of detail) {
    const k = keyOf(x);
    if (!agg[k]) agg[k] = { 건수: 0, 금액: 0 };
    agg[k].건수 += x.건수;
    agg[k].금액 += x.금액 || 0;
  }
  const 집계 = Object.entries(agg)
    .map(([k, v]) => ({ 구분: k, ...v }))
    .sort((a, b) => b.건수 - a.건수);

  const 합계 = detail.reduce(
    (acc, x) => ({ 건수: acc.건수 + x.건수, 금액: acc.금액 + (x.금액 || 0) }),
    { 건수: 0, 금액: 0 }
  );

  return {
    ok: true,
    조회기간: `${ymd(sDate)} ~ ${ymd(eDate)}`,
    적용필터: {
      지역: areaCode ? `${area} (${areaCode})` : "전체",
      발주구분: baljuCode ? `${balju} (${baljuCode})` : "전체",
      도급구분: dogubCode ? `${dogub} (${dogubCode})` : "전체",
    },
    미해석필터: unresolved.length ? unresolved : undefined,
    원본행: { 건수: cnt.totalCount, 금액: amt.totalCount },
    수집행: merged.length,
    집계기준: { balju: "발주구분", area: "지역", dogub: "도급구분", date: "일자" }[groupBy] || "발주구분",
    합계,
    집계,
    잘림: cnt.truncated || amt.truncated,
    note:
      "건설공사대장 통보 실적을 일자 × 지역 × 발주구분(공공/민간법인/민간개인) × 도급구분(원도급/하도급)으로 " +
      "집계한 자료입니다. 건수와 금액은 별도 오퍼레이션이라 서버가 같은 축으로 결합했습니다. " +
      "★ 원 응답에는 지역 '전체'·발주구분 '전체' 합계 행이 실제 항목과 섞여 있어 그대로 더하면 " +
      "중복 계상됩니다 — 서버가 제외하고 집계했으니 반환된 집계값을 다시 합산하지 마세요. " +
      "★ **금액(amt)의 단위는 억원으로 판단됩니다.** 원 명세에는 표기가 없으나, 건설공사대장 통보 " +
      "대상이 도급금액 1억원 이상(건설산업기본법 시행령 제26조제1항)인데 실측 건당 평균이 4.4로 " +
      "나와 억원 외의 단위로는 성립하지 않습니다(2020-08-13 서울·공공·원도급 38건에 166). " +
      "명세로 확인된 값은 아니므로 대외 인용 시에는 근거를 함께 밝히세요.",
  };
}
