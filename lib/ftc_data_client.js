// public-data-portal-mcp / lib/ftc_data_client.js
//
// 공정거래위원회 가맹정보 — data.go.kr(1130000) 계열 4개 서비스.
//
// ★ 같은 "공정위 가맹정보"라도 franchise.ftc.go.kr(정보공개서, lib/ftc_client.js)와는
//   완전히 별개다. 이쪽은 공공데이터포털이므로 인증키가 DATA_PORTAL_KEY이고, 무엇보다
//   **공개 동의 여부와 무관하게 전체 가맹본부가 들어 있다**(정보공개서 공개본은 일부만).
//
// 서비스 4종
//   FftcJnghdqrtrsGnrlDtl3_Service/getjnghdqrtrsGnlinfo2   가맹본부 일반현황
//   FftcjnghdqrtrsFnnrInfo3_Service/getjnghdqrtrsFnlttinfo2 가맹본부 재무정보(구간값)
//   FftcBrandRlsInfo2_Service/getBrandinfo                  브랜드 목록
//   FftcBrandFrcsDropInfo3_Service/getbrandFrcsDmsstus2     브랜드 지역별 가맹점·직영점
//
// ★ 공통 필수 파라미터는 `jngBizCrtraYr`(가맹사업 기준년도)다. yr·bassYr·stdrYr 등 흔한
//   이름은 전부 ESSENTIAL_PARAMETER_ERROR가 난다.
// ★ 관리번호 필터(jnghdqrtrsMnno·brandMnno)는 동작하지만, 이름·사업자등록번호 필터
//   (jnghdqrtrsConmNm·brno)는 **에러 없이 무시된다.** 그래서 회사로 좁히려면 해당 연도
//   전량을 받아 서버에서 걸러야 한다.
// ★ numOfRows 상한은 10,000이다(20,000은 INVALID_REQUEST_PARAMETER_ERROR).

import { SERVICE_KEY, SERVICE_KEY_SOURCE } from "./pdp_client.js";
import { resolveBizNo } from "./bizno_resolver.js";

const BASE = "https://apis.data.go.kr/1130000";
const MAX_ROWS = 10000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const SERVICES = {
  hq: { path: "FftcJnghdqrtrsGnrlDtl3_Service/getjnghdqrtrsGnlinfo2", label: "가맹본부 일반현황" },
  finance: { path: "FftcjnghdqrtrsFnnrInfo3_Service/getjnghdqrtrsFnlttinfo2", label: "가맹본부 재무정보" },
  brand: { path: "FftcBrandRlsInfo2_Service/getBrandinfo", label: "브랜드 목록" },
  stores: { path: "FftcBrandFrcsDropInfo3_Service/getbrandFrcsDmsstus2", label: "브랜드 지역별 점포현황" },
};

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
      "공공데이터포털 인증키가 설정되지 않았습니다. 환경변수 DATA_PORTAL_KEY를 설정하세요.",
    keySource: SERVICE_KEY_SOURCE,
  };
}

async function callOnce(key, params, { timeoutMs = 60000, retries = 2 } = {}) {
  const svc = SERVICES[key];
  const url = `${BASE}/${svc.path}?serviceKey=${SERVICE_KEY}&resultType=json&${qs(params)}`;
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
      // 인증·서비스 오류는 OpenAPI_ServiceResponse 구조로 온다.
      const svcErr = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (svcErr) {
        throw new Error(
          `${svcErr.errMsg || "오류"} (${svcErr.returnAuthMsg || ""}, code ${svcErr.returnReasonCode || "?"})`
        );
      }
      if (data.resultCode && data.resultCode !== "00") {
        throw new Error(`${svc.label}: ${data.resultMsg} (resultCode ${data.resultCode})`);
      }
      return data;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 한 해치를 전부 받는다(10,000행씩 페이지). 인스턴스 수명 동안 캐시한다. */
const yearCache = new Map(); // `${key}:${year}` -> items[]

async function fetchAll(key, year) {
  const ck = `${key}:${year}`;
  if (yearCache.has(ck)) return yearCache.get(ck);
  const first = await callOnce(key, { jngBizCrtraYr: year, pageNo: 1, numOfRows: MAX_ROWS });
  const total = Number(first.totalCount ?? 0);
  let items = first.items ?? [];
  const pages = Math.ceil(total / MAX_ROWS);
  for (let p = 2; p <= pages; p++) {
    const next = await callOnce(key, { jngBizCrtraYr: year, pageNo: p, numOfRows: MAX_ROWS });
    items = items.concat(next.items ?? []);
  }
  const out = { items, total };
  yearCache.set(ck, out);
  return out;
}

function normalizeCorpKey(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function onlyDigits(s) {
  return String(s || "").replace(/[^0-9]/g, "");
}

function ymd(s) {
  const d = onlyDigits(s);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : s || null;
}

// 재무 구간값은 **천원 단위**다(실측 검증: 교촌에프앤비 2024 매출
// "430000000~480000000" 천원 = 4,300~4,800억원). 읽기 쉽도록 억원으로 함께 환산한다.
function scopeToEok(v) {
  if (!v) return null;
  const parts = String(v).split("~").map((x) => Number(onlyDigits(x)) * (String(x).trim().startsWith("-") ? -1 : 1));
  if (parts.some((n) => Number.isNaN(n))) return null;
  const eok = parts.map((n) => Math.round((n / 100000) * 10) / 10); // 천원 → 억원
  return { 원자료_천원: v, 억원: eok.length === 2 ? `${eok[0]}~${eok[1]}` : String(eok[0]) };
}

function mapFinance(f) {
  if (!f) return null;
  return {
    회계연도: f.acntgYr,
    결산월: f.bizYrCrtraMm,
    자산: scopeToEok(f.assetsAmtScopeVal),
    자본: scopeToEok(f.caplAmtScopeVal),
    부채: scopeToEok(f.debtAmtScopeVal),
    매출액: scopeToEok(f.slsAmtScopeVal),
    영업이익: scopeToEok(f.bsnProfitAmtScopeVal),
    당기순이익: scopeToEok(f.thstrmNtpfAmtScopeVal),
    재무제표작성여부: f.fnlttWrtYn,
    통화: f.crrncyUnitCdNm,
    note: "공정위가 구간(범위)으로만 공개하는 값입니다. 정확한 금액이 필요하면 DART 또는 정보공개서 본문을 확인하세요.",
  };
}

async function resolveTarget({ companyName, bizNo }) {
  const resolution = { 입력회사명: companyName || null };
  let target = bizNo ? onlyDigits(bizNo) : null;
  if (target) {
    resolution.resolvedVia = "bizNo 직접 지정 → brno 완전일치";
    resolution.bizNo = target;
    return { target, resolution };
  }
  if (!companyName) return { target: null, resolution: null };
  const r = await resolveBizNo(companyName);
  if (r.ok) {
    resolution.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no) → brno 완전일치";
    resolution.bizNo = r.bizNo;
    resolution.matchedCorpName = r.matchedCorpName;
    resolution.indexGeneratedAt = r.indexGeneratedAt;
    return { target: r.bizNo, resolution };
  }
  resolution.resolvedVia = "가맹본부명 부분검색(폴백)";
  resolution.bizNo = null;
  resolution.해석실패사유 = r.reason;
  resolution.note =
    "사업자등록번호 해석에 실패해 상호명 부분검색으로 조회했습니다. 계열사·동명 업체가 " +
    "섞일 수 있으니 결과의 상호명을 확인하세요. 해석 실패는 '그 회사가 없다'는 뜻이 아닙니다.";
  return { target: null, resolution };
}

// ---------------------------------------------------------------------------
// 도구 1 — 가맹본부 조회 (일반현황 + 재무 + 브랜드 목록)
// ---------------------------------------------------------------------------

export async function searchFranchiseHeadquarters({
  year,
  companyName,
  bizNo,
  corpName,
  includeFinance = true,
  includeBrands = true,
  limit = 10,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  if (!year) return { ok: false, reason: "year(가맹사업 기준년도)는 필수입니다. 예: 2025" };

  const { target, resolution } = await resolveTarget({ companyName, bizNo });
  const nameNeedle = corpName || (!target && companyName) || null;

  const hq = await fetchAll("hq", year);
  const needleKey = nameNeedle ? normalizeCorpKey(nameNeedle) : null;

  let matched = hq.items;
  if (target) matched = matched.filter((x) => onlyDigits(x.brno) === target);
  else if (needleKey)
    matched = matched.filter((x) => normalizeCorpKey(x.jnghdqrtrsConmNm).includes(needleKey));

  const sliced = matched.slice(0, limit);

  // 브랜드 목록은 한 번 받아두면 여러 건에 재사용된다.
  let brandsByHq = null;
  if (includeBrands && sliced.length > 0) {
    const bl = await fetchAll("brand", year);
    brandsByHq = new Map();
    for (const b of bl.items) {
      const k = b.jnghdqrtrsMnno;
      if (!brandsByHq.has(k)) brandsByHq.set(k, []);
      brandsByHq.get(k).push(b);
    }
  }

  const out = [];
  for (const h of sliced) {
    const rec = {
      가맹본부관리번호: h.jnghdqrtrsMnno,
      상호명: h.jnghdqrtrsConmNm,
      사업자등록번호: h.brno,
      법인등록번호: h.crno,
      대표자: h.jnghdqrtrsRprsvNm,
      사업자등록일: ymd(h.bzmnRgsDate),
      법인설립일: ymd(h.corpRgDate),
      기업규모: h.entScaleNm,
      브랜드수: h.brandCnt,
      계열사수: h.affltsCnt,
      소재지: [h.lctnAddr, h.lctnDaddr].filter(Boolean).join(" "),
      지역: h.areaNm,
      대표전화: h.jnghdqrtrsRprsTelno,
      홈페이지: h.hmpgUrladr,
      등록기관: h.jngInstNm,
    };
    if (includeBrands && brandsByHq) {
      rec.브랜드 = (brandsByHq.get(h.jnghdqrtrsMnno) || []).map((b) => ({
        브랜드관리번호: b.brandMnno,
        브랜드명: b.brandNm,
        업종: [b.indutyLclasNm, b.indutyMlsfcNm].filter(Boolean).join(" / "),
        주요상품: b.majrGdsNm,
        가맹사업개시일: ymd(b.jngBizStrtDate),
      }));
    }
    if (includeFinance) {
      try {
        const f = await callOnce("finance", {
          jngBizCrtraYr: year,
          jnghdqrtrsMnno: h.jnghdqrtrsMnno,
          pageNo: 1,
          numOfRows: 5,
        });
        rec.재무 = mapFinance((f.items || [])[0]);
      } catch (e) {
        rec.재무 = { error: String(e.message || e) };
      }
    }
    out.push(rec);
  }

  return {
    ok: true,
    기준년도: String(year),
    전체가맹본부수: hq.total,
    검색결과: matched.length,
    반환: out.length,
    resolution,
    items: out,
    note:
      "이 자료는 공개 동의 여부와 무관한 **전체 가맹본부 등록부**입니다(정보공개서 공개본 API와 " +
      "달리 대형 프랜차이즈도 포함). 원 API에 이름·사업자등록번호 필터가 없어 해당 연도 전량을 " +
      "받아 서버에서 걸렀습니다. 재무는 공정위가 구간으로만 공개하므로 정확한 금액이 아니며, " +
      "브랜드별 지역 점포수는 get_franchise_brand_stores로 조회하세요. " +
      "기준년도(jngBizCrtraYr)와 회계연도(acntgYr)는 보통 1년 차이가 나니 답변에 함께 밝히세요.",
  };
}

// ---------------------------------------------------------------------------
// 도구 2 — 브랜드 지역별 점포현황
// ---------------------------------------------------------------------------

export async function getFranchiseBrandStores({
  year,
  brandMnno,
  brandName,
  companyName,
  bizNo,
  limit = 20,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  if (!year) return { ok: false, reason: "year(가맹사업 기준년도)는 필수입니다. 예: 2025" };
  if (!brandMnno && !brandName && !companyName && !bizNo) {
    return {
      ok: false,
      reason:
        "brandMnno·brandName·companyName·bizNo 중 하나는 필요합니다. 원 API는 브랜드관리번호로만 " +
        "좁혀지므로, 이름을 주면 브랜드 목록에서 관리번호를 먼저 찾습니다.",
    };
  }

  let targets = [];
  let resolution = null;

  if (brandMnno) {
    targets = [{ brandMnno, brandNm: null, corpNm: null }];
  } else {
    const r = await resolveTarget({ companyName, bizNo });
    resolution = r.resolution;
    const bl = await fetchAll("brand", year);
    let cand = bl.items;
    if (r.target) cand = cand.filter((b) => onlyDigits(b.brno) === r.target);
    else if (companyName) {
      const k = normalizeCorpKey(companyName);
      cand = cand.filter((b) => normalizeCorpKey(b.corpNm).includes(k));
    }
    if (brandName) cand = cand.filter((b) => String(b.brandNm || "").includes(brandName));
    targets = cand.slice(0, limit);
    if (targets.length === 0) {
      return {
        ok: true,
        기준년도: String(year),
        전체브랜드수: bl.total,
        검색결과: 0,
        resolution,
        items: [],
        note:
          "해당 조건의 브랜드를 찾지 못했습니다. 기준년도를 바꿔 보거나(연도마다 등록 브랜드가 " +
          "다릅니다) 브랜드명 표기를 확인하세요. 0건이 '가맹사업을 하지 않는다'는 뜻은 아닙니다.",
      };
    }
  }

  const items = [];
  for (const t of targets) {
    const res = await callOnce("stores", {
      jngBizCrtraYr: year,
      brandMnno: t.brandMnno,
      pageNo: 1,
      numOfRows: 100,
    });
    const rows = res.items || [];
    // ★ 지역 목록에 "전체" 행이 함께 들어 있다. 그대로 합산하면 정확히 2배가 되므로
    //   반드시 분리할 것.
    const regions = rows.filter((x) => x.areaNm !== "전체");
    const totalRow = rows.find((x) => x.areaNm === "전체");
    items.push({
      브랜드관리번호: t.brandMnno,
      브랜드명: t.brandNm ?? rows[0]?.brandNm ?? null,
      가맹본부: t.corpNm ?? null,
      가맹본부관리번호: rows[0]?.jnghdqrtrsMnno ?? null,
      업종: [rows[0]?.indutyLclasNm, rows[0]?.indutyMlsfcNm].filter(Boolean).join(" / ") || null,
      회계연도: rows[0]?.acntgYr ?? null,
      합계: totalRow
        ? { 가맹점: totalRow.frcsCnt, 직영점: totalRow.dmsCnt, 전체: totalRow.allFrcsDmsCnt }
        : {
            가맹점: regions.reduce((a, x) => a + (x.frcsCnt || 0), 0),
            직영점: regions.reduce((a, x) => a + (x.dmsCnt || 0), 0),
            전체: regions.reduce((a, x) => a + (x.allFrcsDmsCnt || 0), 0),
          },
      지역별: regions
        .map((x) => ({ 지역: x.areaNm, 가맹점: x.frcsCnt, 직영점: x.dmsCnt, 계: x.allFrcsDmsCnt }))
        .sort((a, b) => b.계 - a.계),
    });
  }

  return {
    ok: true,
    기준년도: String(year),
    반환브랜드수: items.length,
    resolution,
    items,
    note:
      "원 응답의 지역 목록에는 '전체' 행이 섞여 있어 그대로 더하면 두 배가 됩니다 — 서버가 " +
      "분리해 합계로 따로 담았습니다. 기준년도와 회계연도는 보통 1년 차이가 나므로, 답변에는 " +
      "회계연도 기준임을 밝히세요.",
  };
}
