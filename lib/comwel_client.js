// public-data-portal-mcp / lib/comwel_client.js
//
// 근로복지공단 「고용·산재보험 현황정보」(B490001/gySjbPstateInfoService) 래퍼.
// 2026-08-25 추가. 오퍼레이션명·파라미터명은 활용가이드(2021.06.28 v1.2) 대조 후
// 전부 실호출로 재확정한 값이다.
//
// ── 확정 사항 (2026-08-25 실호출 검증) ─────────────────────────────────────
//  · 기업 단위 조회는 getGySjBoheomBsshItem 하나뿐. 나머지 12종은 전국 집계 통계다.
//  · 검색 키는 v_saeopjaDrno(사업자등록번호 10자리) **완전일치 하나뿐**이다.
//    사업장명 파라미터가 아예 없어서 saeopjangNm 등을 넣으면 에러 없이 무시되고
//    전체 653만 건이 그대로 돌아온다(실측 totalCount 6,533,328). 앞 6자리만 넣으면 0건.
//  · 응답에 **기준시점 필드가 없다.** 날짜 필드는 seongripDt(성립일자=가입 시점)뿐이라
//    상시인원이 언제 기준인지 알 수 없다. 단독 인용이 위험하므로 caveats로 항상 알린다.
//  · 한 사업장이 산재 1행 + 고용 1행으로 나뉘어 2건 반환되며 인원이 서로 다를 수 있다
//    (실측 포니링크: 산재 131 / 고용 133).
//  · sjEopjongCd·sjEopjongNm·saeopFg는 v_saeopjaDrno를 넣었을 때만 출력된다.
//  · XML만 반환한다(dataType=json 무시). numOfRows는 5,000까지 동작하나 같은 값도
//    산발적으로 타임아웃이 나므로 callApi의 재시도에 의존한다.
//  · 산재/고용 구분 코드가 오퍼레이션마다 다르다 — 13번은 opaBoheomFg 1=산재/2=고용,
//    1번은 sjGyFg 1=산재/3=고용. 이 파일은 13번만 쓰므로 opaBoheomFg 체계를 따른다.

import { SERVICE_KEY, qs, rawFetch, parseResponse } from "./pdp_client.js";
import { normalizeCorpName, lookupCorpCode, dartBizNo } from "./bizno_resolver.js";
import { getNationalPensionWorkplace, npsSearchName } from "./nps_client.js";

const COMWEL_BASE = "https://apis.data.go.kr/B490001";
const COMWEL_SERVICE = "gySjbPstateInfoService";

const NODATA_CODES = new Set(["03", "3"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// 공통 호출
// ---------------------------------------------------------------------------

function readHeader(d) {
  const svc = d?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (svc) {
    return {
      code: String(svc.returnReasonCode ?? "ERR"),
      msg: String(svc.errMsg ?? svc.returnAuthMsg ?? ""),
    };
  }
  const h = d?.response?.header ?? d?.header ?? d?.result;
  if (h) {
    return {
      code: h.resultCode === undefined ? undefined : String(h.resultCode).padStart(2, "0"),
      msg: h.resultMsg ?? h.resultMag,
    };
  }
  return { code: undefined, msg: undefined };
}

function readBody(d) {
  return d?.response?.body ?? d?.body ?? {};
}

function readItems(d) {
  const b = readBody(d);
  const it = b.items ?? b.item;
  if (!it) return [];
  if (Array.isArray(it)) return it.flatMap((x) => (x && x.item ? asArray(x.item) : [x]));
  if (it.item) return asArray(it.item);
  return asArray(it);
}

/**
 * 공공데이터포털 GET 호출 + 재시도.
 * data.go.kr 게이트웨이는 간헐적으로 연결을 끊거나(ECONNRESET) 빈 응답을 준다.
 * 재시도가 없으면 "사업장 없음"으로 오답하게 되므로 3회까지 재시도한다.
 */
async function callApi({ base, service, operation, params, timeoutMs = 25000, retries = 3 }) {
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
      } else if (!text || !text.trim()) {
        // 빈 응답(타임아웃 계열)은 에러 메시지가 없어 그대로 파싱하면 조용히 0건이 된다.
        lastErr = "빈 응답";
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
      resultCode: undefined,
      resultMsg: `조회 실패(${retries}회 재시도): ${lastErr}`,
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
  return {
    ok: code === "00" || nodata,
    resultCode: code,
    resultMsg: msg,
    noData: nodata,
    totalCount: nodata ? 0 : Number(body.totalCount ?? items.length) || 0,
    items: nodata ? [] : items,
    endpoint: `${base}/${service}/${operation}`,
  };
}

// ---------------------------------------------------------------------------
// 회사명 → 사업자등록번호 10자리 해석
// ---------------------------------------------------------------------------
//
// 근로복지공단 API는 사업자등록번호 10자리 완전일치만 받는데, 국민연금은 앞 6자리만
// 공개하므로 두 API가 서로 연결되지 않는다. 10자리를 얻을 수 있는 곳은 DART 기업개황
// (company.json의 bizr_no)뿐이다. 그런데 회사명 → corp_code 검색 API가 OpenDART에는
// 없고, 전체 목록인 corpCode.xml은 다운로드에 3분 이상 걸려(실측 3분 39초) 요청 시점에
// 받을 수 없다. 그래서 빌드 시점에 만들어 둔 정적 인덱스(data/corp_name_index.json.gz)를
// 읽어 corp_code를 찾고, 런타임에는 company.json 한 번만 호출한다.
//
// 인덱스는 스냅샷이라 신규 법인은 빠질 수 있다. 못 찾으면 실패로 끝내지 않고
// 국민연금으로 폴백하며, 어느 경로를 탔는지 resolvedVia에 남긴다.

// 회사명 → 사업자등록번호 해석은 lib/bizno_resolver.js로 분리했다(2026-08-26).
// 식약처 의약품 도구들도 같은 해석이 필요해져 공통 파일로 옮겼다. 이 파일은 재수출만 한다.
export { normalizeCorpName, lookupCorpCode, dartBizNo, resolveBizNo } from "./bizno_resolver.js";
export { npsSearchName }; // 종전 import 경로 호환

// ---------------------------------------------------------------------------
// 국민연금 — 교차검증·폴백용
// ---------------------------------------------------------------------------
//
// 2026-10-08부터 국민연금 조회는 nps_client.js(get_national_pension_workplace 도구) 하나로
// 통일했다. 종전 이 파일의 자체 조회는 사업장명 단독 검색 60건에서 사업장을 골라, 이름이 흔한
// 회사는 남의 현장 사업장을 집었다(실측: "삼성전자" → "중원엔지니어링/일용/삼성전자 … 공사" 8명).
// 지금은 해석한 사업자등록번호 앞6자리를 함께 걸어 본사 사업장을 고른다.

async function npsLookup({ companyName, bizNo, workplaceName, months = 3 }) {
  const r = await getNationalPensionWorkplace({
    companyName: companyName || undefined,
    bizNo: bizNo || undefined,
    workplaceName: !companyName && workplaceName ? npsSearchName(workplaceName) : undefined,
    months: Math.max(1, Math.min(12, Number(months) || 3)),
    includeFlows: false,
    maxPages: 2,
    pickTopIfAmbiguous: true,
  });
  if (!r.ok) {
    return { found: false, 오류: r.사업장검색 || r.안내 || null, 해석: r.resolution || null };
  }
  if (!r.사업장) {
    return {
      found: false,
      해석: r.resolution,
      안내: r.안내 || "국민연금에서 사업장을 찾지 못했습니다.",
      ...(r.잘림 ? { 잘림: true, 유의사항: r.유의사항 } : {}),
    };
  }
  const p = r.사업장;
  return {
    found: true,
    matchMode: p.이름일치 === "정확" ? "exact" : "partial",
    사업장명: p.사업장명,
    사업장키: p.사업장키,
    사업자등록번호앞6자리: p.사업자등록번호앞6자리,
    주소: p.주소,
    업종: p.업종 ?? null,
    월별가입자수: [...r.월별]
      .reverse()
      .map((m) => ({ 기준연월: m.기준연월, 가입자수: m.가입자수, 당월고지금액: m.당월고지금액, ...(m.조회실패 ? { 조회실패: true } : {}) })),
    동명사업장수: r.사업장수,
    선택: r.선택,
    해석: r.resolution,
    ...(r.잘림 ? { 잘림: true, 유의사항: r.유의사항 } : {}),
    상세도구: "12개월 추이·신규취득·상실·사업장 후보 목록은 get_national_pension_workplace를 쓰세요(같은 로직).",
  };
}

// ---------------------------------------------------------------------------
// 도구 1 — 고용·산재보험 가입 사업장 조회
// ---------------------------------------------------------------------------

const BOHEOM_LABEL = { 1: "산재", 2: "고용" };
const SAEOP_FG_LABEL = {
  1: "계속",
  3: "일괄계속",
  4: "일괄유기",
  7: "사업개시계속",
};

function shapeWorkplaceRow(r) {
  const fg = String(r.opaBoheomFg ?? "");
  return {
    보험구분: BOHEOM_LABEL[fg] || fg,
    사업장명: r.saeopjangNm,
    사업자등록번호: String(r.saeopjaDrno ?? ""),
    상시인원: Number(r.sangsiInwonCnt) || 0,
    성립일자: String(r.seongripDt ?? ""),
    주소: r.addr,
    우편번호: String(r.post ?? ""),
    고용업종코드: r.gyEopjongCd === undefined ? null : String(r.gyEopjongCd),
    고용업종명: r.gyEopjongNm ? String(r.gyEopjongNm).trim() : null,
    산재업종코드: r.sjEopjongCd === undefined ? null : String(r.sjEopjongCd),
    산재업종명: r.sjEopjongNm ? String(r.sjEopjongNm).trim() : null,
    보험가입구분: SAEOP_FG_LABEL[String(r.saeopFg ?? "")] || (r.saeopFg ?? null),
  };
}

export async function getEmploymentInsuranceWorkplace({
  bizNo,
  companyName,
  insurance = "전체",
  includePension = true,
  pensionMonths = 3,
} = {}) {
  const resolution = { requested: { bizNo: bizNo || null, companyName: companyName || null } };
  let resolvedBizNo = bizNo ? String(bizNo).replace(/\D/g, "") : "";

  if (resolvedBizNo && resolvedBizNo.length !== 10) {
    return {
      ok: false,
      error:
        `사업자등록번호는 10자리여야 합니다(받은 값 ${resolvedBizNo.length}자리). ` +
        `이 API는 부분일치를 지원하지 않아 앞 6자리로는 0건이 나옵니다.`,
      resolution,
    };
  }

  // 회사명만 준 경우 DART 정적 인덱스 → 기업개황으로 10자리를 확보한다.
  if (!resolvedBizNo && companyName) {
    const hit = lookupCorpCode(companyName);
    if (hit) {
      resolution.corpCode = hit.corpCode;
      resolution.dartCorpName = hit.corpName;
      resolution.indexGeneratedAt = hit.indexGeneratedAt;
      const dart = await dartBizNo(hit.corpCode);
      if (dart.ok) {
        resolvedBizNo = dart.bizNo;
        resolution.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no)";
        resolution.stockCode = dart.stockCode || null;
      } else {
        resolution.dartError = dart.reason;
      }
    } else {
      resolution.dartError = "DART 고유번호 인덱스에서 회사명을 찾지 못했습니다(미공시 법인이거나 인덱스 스냅샷 이후 신규 등록).";
    }
  } else if (resolvedBizNo) {
    resolution.resolvedVia = "bizNo 직접 지정";
  }

  const out = { ok: true, resolution, caveats: [] };

  if (resolvedBizNo) {
    resolution.bizNo = resolvedBizNo;
    // ★ 20건 고정이다. 사업장이 20개를 넘는 회사는 잘리므로 아래에서 totalCount와 대조한다.
    const params = { v_saeopjaDrno: resolvedBizNo, numOfRows: 20, pageNo: 1 };
    if (insurance === "산재") params.opaBoheomFg = 1;
    if (insurance === "고용") params.opaBoheomFg = 2;
    const r = await callApi({
      base: COMWEL_BASE,
      service: COMWEL_SERVICE,
      operation: "getGySjBoheomBsshItem",
      params,
    });
    // 필터가 안 걸리면 전체 653만 건이 그대로 온다. 그 경우를 사고로 취급한다.
    if (r.ok && r.totalCount > 100000) {
      out.고용산재보험 = {
        조회됨: false,
        경고:
          `필터가 적용되지 않았습니다(totalCount ${r.totalCount}). 사업자등록번호 파라미터가 ` +
          `무시된 상태이므로 이 결과를 특정 회사의 값으로 읽지 마세요.`,
      };
    } else if (!r.ok) {
      out.고용산재보험 = { 조회됨: false, 오류: r.resultMsg, resultCode: r.resultCode };
    } else if (!r.items.length) {
      out.고용산재보험 = {
        조회됨: true,
        건수: 0,
        안내: "해당 사업자등록번호로 등록된 고용·산재보험 사업장이 없습니다. 번호가 정확한지 확인하세요.",
      };
    } else {
      const rows = r.items.map(shapeWorkplaceRow);
      out.고용산재보험 = { 조회됨: true, 건수: rows.length, 사업장: rows };
      // ★ numOfRows=20 고정이라 사업장이 많은 회사는 잘린다. totalCount와 대조해 알린다.
      if (r.totalCount > rows.length) {
        out.고용산재보험.잘림 = true;
        out.고용산재보험.유의사항 =
          `★ 이 사업자등록번호로 ${r.totalCount}건이 등록돼 있는데 ${rows.length}건만 받았습니다. ` +
          `사업장 수·상시인원 합계를 이 결과로 내지 마세요.`;
      }
      out.caveats.push(
        "근로복지공단 응답에는 기준시점 필드가 없습니다. 상시인원이 언제 기준인지 확인할 방법이 " +
          "없으므로 이 값만으로 인원을 단정하지 말고, 시점이 명시된 소스(DART 사업보고서 직원현황, " +
          "국민연금 가입자수)와 반드시 병기하세요."
      );
      if (rows.length > 1) {
        out.caveats.push(
          "한 사업장이 산재·고용 두 행으로 나뉘어 나오며 상시인원이 서로 다를 수 있습니다. " +
            "인용할 때 어느 쪽 수치인지 밝히세요."
        );
      }
      out.caveats.push(
        "업종코드(고용·산재)는 각 보험의 등록 목적에 따른 분류라 DART 업종코드·국민연금 업종과 " +
          "다릅니다. 업종 판정 근거로 쓰지 마세요."
      );
    }
  } else {
    out.고용산재보험 = {
      조회됨: false,
      안내:
        "사업자등록번호 10자리를 확보하지 못해 근로복지공단 조회를 수행하지 못했습니다. " +
        "미조회이지 미가입이 아닙니다. DART 미등록 비상장사는 10자리를 얻을 경로가 없으므로 " +
        "아래 국민연금 결과로 갈음하거나, 사업자등록번호를 직접 알려주세요.",
    };
  }

  if (includePension) {
    const wkplName = out.고용산재보험?.사업장?.[0]?.사업장명 || null;
    if (companyName || resolvedBizNo || wkplName) {
      const nps = await npsLookup({ companyName, bizNo: resolvedBizNo || null, workplaceName: wkplName, months: pensionMonths });
      out.국민연금 = nps;
      if (nps?.found) {
        out.caveats.push(
          "국민연금 가입자수는 만 60세 이상·일부 단시간 근로자가 제외되고 등기임원은 포함되는 " +
            "재직 인원의 대리지표입니다. 또한 오픈API 활용가이드상 대외 공표용 통계로는 쓸 수 없습니다."
        );
        if (nps.동명사업장수 > 1) {
          out.caveats.push(
            `국민연금에서 사업장 후보가 ${nps.동명사업장수}곳 조회되어 하나를 골랐습니다(${nps.선택?.방식 || "자동 선택"}). ` +
              `주소를 확인해 의도한 회사가 맞는지 검증하고, 후보 목록은 get_national_pension_workplace로 보세요.`
          );
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 도구 2 — 사업종류별 산재보험요율
// ---------------------------------------------------------------------------
//
// 이 오퍼레이션은 파라미터 없이 전수 반환되며 1962년부터 누적되어 있다(실측 8,623건).
// jyFromDt(적용 시작연도)로 거르지 않으면 60년 전 요율이 섞인다.
// jyYoyul은 **천분율**이고, 출퇴근재해 요율은 이 표에 포함되어 있지 않다.

let tariffCache = null;

async function fetchTariffAll() {
  if (tariffCache) return tariffCache;
  const r = await callApi({
    base: COMWEL_BASE,
    service: COMWEL_SERVICE,
    operation: "getEopjongSjBoheomTariffPyoPstateList",
    params: { numOfRows: 10000, pageNo: 1 },
    timeoutMs: 30000,
  });
  if (!r.ok || !r.items.length) return { ok: false, resultMsg: r.resultMsg, items: [] };
  tariffCache = { ok: true, items: r.items };
  return tariffCache;
}

export async function getAccidentInsuranceRate({ year, keyword, industryCode, limit = 300 } = {}) {
  const all = await fetchTariffAll();
  if (!all.ok) return { ok: false, error: `산재보험요율표 조회 실패: ${all.resultMsg}` };

  const years = [...new Set(all.items.map((r) => String(r.jyFromDt)))].sort();
  const latest = years[years.length - 1];
  const target = year ? String(year) : latest;
  if (!years.includes(target)) {
    return {
      ok: false,
      error: `${target}년 요율이 없습니다. 제공 연도 범위: ${years[0]}~${latest}`,
      제공연도범위: { 최초: years[0], 최신: latest },
    };
  }

  let rows = all.items.filter((r) => String(r.jyFromDt) === target);
  if (industryCode) {
    rows = rows.filter((r) => String(r.sjEopjongCd) === String(industryCode));
  }
  if (keyword) {
    const k = String(keyword).replace(/\s+/g, "");
    rows = rows.filter((r) => String(r.sjEopjongNm1 ?? "").replace(/\s+/g, "").includes(k));
  }

  const shaped = rows.slice(0, limit).map((r) => ({
    산재업종코드: String(r.sjEopjongCd),
    업종명: String(r.sjEopjongNm1 ?? "").trim(),
    대분류: String(r.eopjongLevel1 ?? "").replace(/\s+/g, "") || null,
    중분류: String(r.eopjongLevel2 ?? "").replace(/\s+/g, "") || null,
    요율_천분율: Number(r.jyYoyul) || 0,
    요율_퍼센트: (Number(r.jyYoyul) || 0) / 10,
    적용연도: target,
  }));

  const out = {
    ok: true,
    적용연도: target,
    최신제공연도: latest,
    전체업종수: rows.length,
    반환건수: shaped.length,
    잘림: rows.length > shaped.length,
    업종: shaped,
  };

  // 0건은 "요율이 없다"가 아니라 대개 검색어가 산재보험 업종분류 체계에 없는 말이라서다.
  // 산재보험 업종은 산업 실태가 아니라 재해위험도 기준이라 "소프트웨어" 같은 현대 업종명이
  // 아예 없다(실측: 포니링크의 산재업종은 91001 도·소매 및 소비자용품수리업).
  if (!shaped.length && (keyword || industryCode)) {
    const 전체 = all.items.filter((r) => String(r.jyFromDt) === target);
    out.안내 =
      `${target}년 요율표에 조건과 맞는 업종이 없습니다. 산재보험 업종분류는 재해위험도 기준이라 ` +
      `현대적 업종명(예: 소프트웨어, IT, 플랫폼)이 존재하지 않는 경우가 많습니다. ` +
      `특정 회사의 실제 산재업종코드는 get_employment_insurance_workplace로 확인하세요.`;
    out.대분류목록 = [...new Set(전체.map((r) => String(r.eopjongLevel1 ?? "").replace(/\s+/g, "")))].filter(Boolean);
    out.전체업종수_해당연도 = 전체.length;
  }

  return {
    ...out,
    caveats: [
      "jyYoyul은 천분율입니다. 8이면 8/1,000 = 0.8%이며, 백분율로 읽으면 10배 틀립니다. " +
        "요율_퍼센트 필드에 변환값을 함께 담았습니다.",
      "이 표에는 **출퇴근재해 요율이 포함되어 있지 않습니다.** 실제 부담 요율은 여기에 그 해 " +
        "고용노동부가 별도 고시한 출퇴근재해 요율을 더한 값입니다. 언론에 나오는 '평균 산재보험료율'은 " +
        "출퇴근재해를 포함한 수치라 이 표의 값과 직접 비교하면 어긋납니다.",
      "산재보험료는 전액 사업주 부담이며 근로자 급여에서 공제되지 않습니다.",
    ],
  };
}
