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

async function fetchAllPages(baseUrl, op, params, maxPages = 5) {
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
        maxPages
      );
      perOp.push({ 구분: meta.label, 오퍼레이션: meta.op, 기간내_전체: r.totalCount, 수집: r.items.length, 잘림: r.truncated });
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
  maxPages = 3,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };

  const { target, resolution } = await resolveTarget({ companyName, bizNo });
  const { perOp, rows, filtered } = await gatherFirmOps({
    kinds: kinds.filter((k) => REGISTRY_KINDS.includes(k)),
    sDate, eDate, area, areaDetail, target, companyName, itemName, maxPages,
  });

  const items = filtered.slice(0, limit).map((x) => ({
    구분: x.__kind,
    업체명: firmName(x),
    사업자등록번호: x.ncrMasterNum ? String(x.ncrMasterNum) : null,
    대표자: firmMaster(x),
    업종: x.ncrItemName,
    등록번호: x.ncrItemregno,
    소재지: firmAddr(x),
    지역: [x.ncrAreaName, x.ncrAreaDetailName].filter(Boolean).join(" "),
    전화: x.ncrOffTel,
    공시일: ymd(x.ncrGsDate),
    등록일: ymd(x.ncrGsRegdate),
    공고번호: x.ncrGsNumber,
    변동사유: x.ncrGsReason && x.ncrGsReason !== "-" ? x.ncrGsReason : null,
  }));

  return {
    ok: true,
    조회기간: `${ymd(sDate)} ~ ${ymd(eDate)}`,
    오퍼레이션별: perOp,
    수집행: rows.length,
    조건일치: filtered.length,
    반환: items.length,
    resolution,
    items,
    note:
      "건설업 신규등록·등록기준사항 신고·양도·법인합병·상속 공시입니다. 원 API에 업체명·사업자등록번호 " +
      "검색 파라미터가 없어 기간 전량을 받아 서버에서 걸렀습니다(동작하는 필터는 지역뿐입니다). " +
      "★ 이 결과는 **조회한 기간의 공시분**만입니다 — 0건이 '그런 업체가 없다'는 뜻이 아니므로, " +
      "특정 회사를 찾는 것이 목적이면 기간을 넓혀 다시 조회하고 답변에 조회기간을 반드시 밝히세요.",
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
  maxPages = 3,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };

  const { target, resolution } = await resolveTarget({ companyName, bizNo });
  const { perOp, rows, filtered } = await gatherFirmOps({
    kinds: kinds.filter((k) => SANCTION_KINDS.includes(k)),
    sDate, eDate, area, areaDetail, target, companyName, itemName, maxPages,
  });

  const items = filtered.slice(0, limit).map((x) => {
    const base = {
      구분: x.__kind,
      업체명: firmName(x),
      사업자등록번호: x.ncrMasterNum ? String(x.ncrMasterNum) : null,
      대표자: firmMaster(x),
      업종: x.ncrItemName,
      등록번호: x.ncrItemregno,
      지역: [x.ncrAreaName, x.ncrAreaDetailName].filter(Boolean).join(" "),
      소재지: firmAddr(x),
      공시일: ymd(x.ncrGsDate),
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

  // 처분명별 건수는 눈으로 세지 말고 코드로 집계한다.
  const byType = {};
  for (const x of filtered) {
    const k = x.ncrAdmiDename || x.__kind;
    byType[k] = (byType[k] || 0) + 1;
  }

  return {
    ok: true,
    조회기간: `${ymd(sDate)} ~ ${ymd(eDate)}`,
    오퍼레이션별: perOp,
    수집행: rows.length,
    조건일치: filtered.length,
    처분유형별: byType,
    반환: items.length,
    resolution,
    items,
    note:
      "건설산업기본법에 따른 행정처분·가처분·폐업 공시입니다. 과징금·과태료 금액 단위는 원이며, " +
      "가처분(ncrPdStatus)이 걸린 건은 처분 효력이 정지된 상태일 수 있으니 취소일과 함께 확인하세요. " +
      "★ 이 결과는 **조회한 기간의 공시분**만입니다 — **0건을 '처분 이력이 없다'로 답하지 마세요.** " +
      "실사 목적이라면 기간을 수년 단위로 넓혀 재조회하고, 답변에는 확인한 기간을 반드시 밝히세요.",
  };
}

// ---------------------------------------------------------------------------
// 도구 3 — 건설공사대장 통보 통계 (시장 동향)
// ---------------------------------------------------------------------------

export async function getConstructionNoticeStats({
  sDate,
  eDate,
  area,
  baljuGubun,
  dogubGubun,
  groupBy = "balju",
  maxPages = 10,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const bad = checkDates(sDate, eDate);
  if (bad) return { ok: false, reason: bad };

  const params = { sDate: onlyDigits(sDate), eDate: onlyDigits(eDate) };
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
      "★ **금액(amt)의 단위는 원 명세에 표기되어 있지 않습니다.** 건당 평균값으로 미루어 억원 단위로 " +
      "보이나 확인된 사실이 아니므로, 절대 금액을 인용할 때는 단위 미확인임을 함께 밝히고 추세·비중 " +
      "비교 위주로 쓰세요.",
  };
}
