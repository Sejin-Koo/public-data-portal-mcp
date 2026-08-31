// lib/housing_client.js
// ────────────────────────────────────────────────────────────────────────────
// 국토교통부 건축HUB **주택인허가정보**(주택법 사업계획승인 대장) +
// 한국부동산원 **청약홈 분양정보**(odcloud).
//
// 엔드포인트
//   주택인허가 https://apis.data.go.kr/1613000/HsPmsHubService/<오퍼레이션>
//   청약홈     https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/<오퍼레이션>
//   법정동코드 archhub_client.js의 resolveBjdong 재사용
// 인증키는 둘 다 공공데이터포털 공용키(DATA_PORTAL_KEY).
//
// ★★ 왜 두 소스를 한 파일에 두는가 — 서로가 가진 것이 다르고, 붙여야 답이 나온다.
//
//   |               | 주택인허가          | 청약홈            |
//   |---------------|---------------------|-------------------|
//   | 모집단        | **전수**(사업계획승인 전건) | 분양분만  |
//   | 시행사        | 있음(관리공동형별개요) | 있음           |
//   | **시공사**    | **없음**            | 있음              |
//   | 사업계획승인일 | 있음               | 없음              |
//   | 착공일        | 있음(단, 아래 주의) | 없음              |
//   | 사용검사예정일 | 있음               | 없음              |
//   | 입주예정월    | 없음                | 있음              |
//   | 난방방식·연료 | 있음                | 없음              |
//   | 조회 단위     | **법정동**          | 전국 일괄         |
//
//   지역주택조합 조합원분 전량·임대·후분양은 청약홈에 **구조적으로** 없다. 실측:
//   힐스테이트 마포더퍼스트(488세대)·동작 하이팰리스(608세대)가 청약홈에는 없고
//   주택인허가에는 있었다. 반대로 시공사를 알려면 청약홈이 유일하다.
//
// ★★ 실측으로 확인한 함정 (2026-08-31)
//
//   1) **numOfRows 상한이 100이다.** 활용가이드에 명시돼 있고 건축인허가와 같다.
//      크게 줘도 조용히 깎인다.
//   2) **조회 단위가 법정동이다.** sigunguCd만 주면 resultCode "00"과 함께 빈 결과가 온다.
//   3) **22자리 mgmHsrgstPk가 JSON 파싱에서 깨진다.** 문자열로 감싸 보존한다.
//   4) **착공일(stcnsDay)은 준공 후에야 채워진다.** 실측 8개 단지 중 준공된 4건은 전부
//      착공일이 있고, 시공 중인 4건은 전부 비어 있었다(착공예정일만 있음).
//      **진행 중 현장의 실제 착공일을 이 API로 얻겠다는 계획은 성립하지 않는다.**
//      공정 역산은 사용검사예정일(useInsptSchedDay)로 해야 한다.
//   5) **행정구역 개편이 조용히 0건을 만든다.** 광주광역시가 행정표준코드에서
//      "전남광주통합특별시"로 바뀌어 시군구코드가 29170 → 12300으로 이동했다.
//      구 코드로 조회하면 에러 없이 0건이다. resolveBjdong이 표준코드 API를 실시간
//      조회하므로 지역명을 주면 자동으로 신 코드를 쓴다 — **코드를 직접 박지 말 것.**
//   6) **청약홈의 totalCount는 필터를 무시한다.** cond를 걸어도 totalCount는 전체
//      건수 그대로이고 실제 결과 수는 matchCount다. 혼동하면 건수를 통째로 틀린다.
//   7) **청약홈 미문서화 필터.** 기술문서의 요청 파라미터 목록에는 house_nm·house_secd·
//      subscrpt_area_code_nm·hssply_adres·rcrit_pblanc_de 등만 있는데, 실제로는
//      CNSTRCT_ENTRPS_NM(시공사)·MVN_PREARNGE_YM(입주예정월)에도 cond가 먹는다.
//      언젠가 막힐 수 있으므로 **서버측 필터 결과가 전체 건수와 같으면 무시된 것으로 보고
//      로컬 필터로 폴백**한다(applyLocal 플래그로 응답에 밝힌다).
//   8) **오피스텔·생활숙박시설은 주택법 대상이 아니다.** 건축법이므로 주택인허가에
//      없고 건축인허가(search_arch_permits)로 가야 한다. 실측: THE GALLERY 832
//      (강남 역삼동 오피스텔)가 역삼동 주택인허가 200건에 없었다.
//   9) **대장 명칭이 브랜드명과 다른 경우가 흔하다.** 실측: 힐스테이트 동작 시그니처는
//      대장에 "동작 하이팰리스"(조합명), 더샵 의정부역 링크시티는 "의정부 캠프라과디아
//      도시개발사업 공동주택"으로 등재돼 있다. 브랜드명으로만 찾으면 못 찾는다.
//  10) **사업계획승인 지번과 모집공고 지번이 다를 수 있다.** 실측: 힐스테이트 이천역
//      1단지는 대장 증일동 393, 청약홈 공고 증일동 79-4다. 지번으로 좁히면 놓친다.
// ────────────────────────────────────────────────────────────────────────────

import { SERVICE_KEY, SERVICE_KEY_SOURCE } from "./pdp_client.js";
import { resolveBjdong } from "./archhub_client.js";

const HS = "https://apis.data.go.kr/1613000/HsPmsHubService";
const ODC = "https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1";

// ★ 활용가이드 명시: "API 요청시 1회 요청 가능한 목록 수(numOfRows) 최대 100건 제한"
const MAX_ROWS = 100;
const ODC_MAX_PER_PAGE = 1000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trim = (s) => {
  const v = s == null ? "" : String(s).trim();
  return v || null;
};
const onlyDigits = (s) => String(s ?? "").replace(/[^0-9]/g, "");
const ymdDash = (v) => {
  const d = onlyDigits(v);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null;
};
const norm = (s) => String(s ?? "").replace(/[\s()（）㈜（주）]/g, "").toLowerCase();

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

const unwrap = (json) => (json && json.response ? json.response : json);

// ★ 22자리 관리주택대장PK가 그대로 JSON.parse되면 정밀도를 잃어 다시 못 찾는다.
//   이름이 Pk로 끝나는 숫자 값을 전부 문자열로 감싼다(건축인허가와 동일한 처리).
function bigIntSafe(text) {
  return text.replace(/"([A-Za-z]*Pk)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
}

// ────────────────────────────────────────────────────────────────────────────
// 주택인허가 (HsPmsHubService)
// ────────────────────────────────────────────────────────────────────────────

export const HS_OPS = {
  기본개요: "getHpBasisOulnInfo",
  관리공동형별개요: "getHpMgmCoopTpOulnInfo",
  동별개요: "getHpDongOulnInfo",
  행위개요: "getHpActOulnInfo",
};

async function callHs(op, params, { timeoutMs = 30000, retries = 5 } = {}) {
  const url = `${HS}/${op}?serviceKey=${SERVICE_KEY}&_type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();
      // 연속 호출 시 HTTP 200에 빈 본문이 오는 일이 있다(레이트리밋 성격).
      if (!text.trim()) {
        throw new Error(`빈 응답 (HTTP ${res.status}) — 연속 호출에 따른 일시적 제한으로 보입니다`);
      }
      let data;
      try {
        data = JSON.parse(bigIntSafe(text));
      } catch {
        throw new Error(`JSON 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      const svcErr = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (svcErr) {
        throw new Error(
          `${svcErr.errMsg || "오류"} (${svcErr.returnAuthMsg || ""}, code ${svcErr.returnReasonCode || "?"})`
        );
      }
      const payload = unwrap(data);
      const header = payload?.header ?? {};
      if (header.resultCode && String(header.resultCode) !== "00") {
        throw new Error(`${op}: ${header.resultMsg} (resultCode ${header.resultCode})`);
      }
      const body = payload?.body ?? {};
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

async function fetchHsPages(op, params, maxPages = 10) {
  const first = await callHs(op, { ...params, pageNo: 1, numOfRows: MAX_ROWS });
  let items = first.items;
  // ★ 페이지 수를 상한값으로 계산하지 않고 실제로 받은 행 수로 판단한다.
  const perPage = first.items.length || MAX_ROWS;
  const pages = Math.min(Math.ceil(first.totalCount / perPage) || 1, maxPages);
  const 실패페이지 = [];
  for (let p = 2; p <= pages; p++) {
    if (p % 10 === 0) await sleep(300);
    try {
      const got = await callHs(op, { ...params, pageNo: p, numOfRows: MAX_ROWS });
      items = items.concat(got.items);
      if (!got.items.length) break;
    } catch (e) {
      실패페이지.push({ 페이지: p, 오류: String(e.message || e) });
    }
  }
  return {
    items,
    totalCount: first.totalCount,
    truncated: first.totalCount > items.length,
    ...(실패페이지.length ? { 실패페이지 } : {}),
  };
}

// 진행 상태 판정 — 사용검사일이 있으면 준공, 없으면 시공/예정
function stageOf(x) {
  if (trim(x.useInsptDay)) return "준공";
  if (trim(x.stcnsDay)) return "시공중";
  if (trim(x.stcnsSchedDay)) return "착공예정";
  if (trim(x.apprvDay)) return "승인";
  return "미상";
}

function mapBasis(x) {
  return {
    관리주택대장PK: trim(x.mgmHsrgstPk),
    단지명: trim(x.bldNm),
    대지위치: trim(x.platPlc),
    주용도: trim(x.purpsCdNm),
    구조: trim(x.strctCdNm),
    주건축물수: Number(x.mainBldCnt ?? 0) || null,
    총세대수: Number(x.totHhldCnt ?? 0) || null,
    "연면적_㎡": Number(x.totArea ?? 0) || null,
    사업계획승인일: ymdDash(x.apprvDay),
    착공예정일: ymdDash(x.stcnsSchedDay),
    착공일: ymdDash(x.stcnsDay),
    사용검사예정일: ymdDash(x.useInsptSchedDay),
    사용검사일: ymdDash(x.useInsptDay),
    진행상태: stageOf(x),
    생성일: ymdDash(x.crtnDay),
    시군구코드: trim(x.sigunguCd),
    법정동코드: trim(x.bjdongCd),
    대지구분: trim(x.platGbCd),
    번: trim(x.bun),
    지: trim(x.ji),
  };
}

// ★ 관리공동형별개요에는 **mgmHsrgstPk가 없다.** PK 필드명이 mgmCoophsrgstPk로 서로 달라
//   기본개요와 PK로는 결합되지 않는다. 지번(시군구+법정동+대지구분+번+지)으로 붙여야 한다.
//   필드명도 기본개요와 규칙이 달라(heatMthdCdNm·maxFlrCnt·exuseArea) 추측하면 전부 null이 된다.
function mapMgm(x) {
  return {
    관리공동주택대장PK: trim(x.mgmCoophsrgstPk),
    단지명: trim(x.cmplxNm),
    대지위치: trim(x.platPlc),
    사업주체명: trim(x.bizBodyNm),
    사업승인일: ymdDash(x.bizApprvDay),
    사용검사일: ymdDash(x.useInsptDay),
    형별구분: trim(x.typeGb),
    기타형별: trim(x.etcType),
    "전용면적_㎡": Number(x.exuseArea ?? 0) || null,
    세대수: Number(x.hhldCnt ?? 0) || null,
    주건축물수: Number(x.mainBldCnt ?? 0) || null,
    최고층수: Number(x.maxFlrCnt ?? 0) || null,
    구조: trim(x.strctCdNm),
    승강기_승용: Number(x.elvtRideUse ?? 0) || null,
    승강기_비상: Number(x.elvtEmgen ?? 0) || null,
    "대지면적_㎡": Number(x.platArea ?? 0) || null,
    "연면적_㎡": Number(x.totArea ?? 0) || null,
    난방방식: trim(x.heatMthdCdNm),
    사용연료: trim(x.useFuel),
    복도형식: trim(x.hwayModeCdNm),
    급수방식: trim(x.wtspCdNm),
    관리방식: trim(x.mgmMthdCdNm),
    주택유형: trim(x.hsTypeGbCdNm),
    주택형별: trim(x.hsStyleGbCdNm),
    시군구코드: trim(x.sigunguCd),
    법정동코드: trim(x.bjdongCd),
    대지구분: trim(x.platGbCd),
    번: trim(x.bun),
    지: trim(x.ji),
  };
}

function mapDong(x) {
  return {
    관리주택대장PK: trim(x.mgmHsrgstPk),
    관리동별개요PK: trim(x.mgmDongOulnPk),
    대지위치: trim(x.platPlc),
    건물명: trim(x.bldNm),
    동명칭: trim(x.dongNm),
    주용도: trim(x.mainPurpsCdNm),
    구조: trim(x.strctCdNm),
    지상층수: Number(x.grndFlrCnt ?? 0) || null,
    지하층수: Number(x.ugrndFlrCnt ?? 0) || null,
    "높이_m": Number(x.heit ?? 0) || null,
    "연면적_㎡": Number(x.totArea ?? 0) || null,
    승용승강기수: Number(x.rideUseElvtCnt ?? 0) || null,
    비상용승강기수: Number(x.emgenUseElvtCnt ?? 0) || null,
    세대수_민간분양: Number(x.hhldCntCvlLotou ?? 0) || null,
    세대수_민간임대: Number(x.hhldCntCvlRent ?? 0) || null,
    세대수_공공분양: Number(x.hhldCntPubLotou ?? 0) || null,
    세대수_공공임대계: Number(x.hhldCntPubRentTot ?? 0) || null,
    주부속구분: trim(x.mainAtchGbCdNm),
    지붕: trim(x.roofCdNm),
  };
}

function mapAct(x) {
  return {
    관리주택대장PK: trim(x.mgmHsrgstPk),
    단지명: trim(x.cmplxNm),
    대지위치: trim(x.platPlc),
    행위구분: trim(x.actGbCdNm),
    주용도: trim(x.mainPurpsCdNm),
    기타용도: trim(x.etcPurps),
    시설명: trim(x.fcNm),
    "공사면적_㎡": Number(x.constArea ?? 0) || null,
    "연면적_㎡": Number(x.totArea ?? 0) || null,
    지상층수: Number(x.grndFlrCnt ?? 0) || null,
    세대수: Number(x.hhldCnt ?? 0) || null,
    총사업비: Number(x.totWkp ?? 0) || null,
    착공예정일: ymdDash(x.stcnsSchedDay),
    사용검사예정일: ymdDash(x.useInsptSchedDay),
  };
}

const MAPPERS = {
  기본개요: mapBasis,
  관리공동형별개요: mapMgm,
  동별개요: mapDong,
  행위개요: mapAct,
};

const HS_CAVEATS = [
  "착공일(stcnsDay)은 사용검사 시점에 채워지는 경향이 있습니다 — 실측에서 시공 중인 단지는 전부 비어 있고 착공예정일만 있었습니다. 공정 역산은 사용검사예정일로 하세요.",
  "오피스텔·생활숙박시설·도시형생활주택 일부는 주택법이 아니라 건축법 대상이라 이 대장에 없습니다. 그때는 search_arch_permits(건축인허가)로 가세요.",
  "대장 명칭이 분양 브랜드명과 다른 경우가 흔합니다(조합명·사업명으로 등재). 브랜드명으로 못 찾으면 세대수·지번으로 대조하세요.",
  "사업계획승인 지번과 분양 모집공고 지번이 다를 수 있으므로, 지번(bun·ji)으로 좁히면 놓칠 수 있습니다.",
];

/**
 * 주택인허가를 지역(법정동) 단위로 조회해 단지 정보로 결합한다.
 */
export async function searchHousingPermits({
  region,
  sigunguCd,
  bjdongCd,
  bun,
  ji,
  sections = ["기본개요", "관리공동형별개요"],
  minHouseholds,
  approvedFrom,
  approvedTo,
  useInsptSchedFrom,
  useInsptSchedTo,
  stage,
  nameContains,
  maxDongs = 20,
  maxPagesPerOp = 10,
  limit = 50,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();

  const wanted = sections.filter((s) => HS_OPS[s]);
  if (!wanted.length) {
    return {
      ok: false,
      reason: `sections가 비어 있거나 알 수 없는 값입니다. 사용 가능: ${Object.keys(HS_OPS).join(", ")}`,
    };
  }

  // ── 조회 대상 법정동 확정
  let targets = [];
  let 지역해석 = null;
  if (sigunguCd && bjdongCd) {
    targets = [{ 법정동명: null, sigunguCd, bjdongCd }];
  } else if (region) {
    const r = await resolveBjdong(region);
    지역해석 = { 지역명: region, 해석된_법정동수: r.법정동수 };
    if (!r.법정동수) {
      return {
        ok: false,
        지역해석,
        reason:
          "그 이름으로 법정동을 찾지 못했습니다. 시군구명을 정확히 주세요(예: '강남구', '성남시 분당구'). " +
          "행정동 이름은 법정동 체계에 없어 조회되지 않습니다. " +
          "★ 행정구역 개편으로 시도명이 바뀐 지역이 있습니다 — 실측: 광주광역시가 '전남광주통합특별시'로 " +
          "바뀌어 시군구코드가 29170에서 12300으로 이동했습니다. 옛 시도명으로는 0건이 나옵니다.",
      };
    }
    // ★ 지역명이 여러 시군구에 걸치는지 먼저 본다. "북구"처럼 전국에 같은 이름이
    //   있는 시군구를 그냥 주면 부산·대구·광주·울산·포항 북구가 전부 섞여 들어온다
    //   (실측: "북구" → 193개 법정동, 844개 단지). 조용히 섞이면 결과를 신뢰할 수 없다.
    const sggSet = new Map();
    for (const d of r.법정동) {
      const cd = String(d.법정동코드).slice(0, 5);
      if (!sggSet.has(cd)) sggSet.set(cd, String(d.법정동명 || "").split(/\s+/).slice(0, 2).join(" "));
    }
    지역해석.해석된_시군구수 = sggSet.size;
    if (sggSet.size > 1) {
      return {
        ok: false,
        지역해석,
        해석된_시군구: Array.from(sggSet.entries()).map(([cd, nm]) => ({ 시군구코드: cd, 지역: nm })).slice(0, 20),
        reason:
          `'${region}'이 ${sggSet.size}개 시군구에 걸칩니다. 그대로 순회하면 서로 다른 지역이 한 결과에 섞입니다. ` +
          "시도명을 함께 주세요(예: '광주광역시 북구'가 아니라 행정표준코드 현행 명칭 기준으로 " +
          "'전남광주통합특별시 북구', 또는 '부산광역시 북구'). 아래 해석된_시군구에서 골라 " +
          "sigunguCd로 직접 지정해도 됩니다.",
      };
    }
    targets = r.법정동.slice(0, maxDongs).map((d) => ({
      법정동명: d.법정동명,
      sigunguCd: String(d.법정동코드).slice(0, 5),
      bjdongCd: d.법정동부코드,
    }));
    지역해석.순회_법정동수 = targets.length;
    지역해석.잘림 = r.법정동수 > targets.length;
  } else {
    return {
      ok: false,
      reason:
        "region(시군구명) 또는 sigunguCd+bjdongCd 조합이 필요합니다. " +
        "★ 이 API는 조회 단위가 법정동입니다 — 시군구코드만 주면 원 API가 오류 없이 빈 결과를 돌려줍니다.",
    };
  }

  // ── 섹션별 수집
  const collected = {};
  const 실패 = [];
  let 총행수 = 0;
  for (const sec of wanted) {
    const rows = [];
    for (const t of targets) {
      const params = { sigunguCd: t.sigunguCd, bjdongCd: t.bjdongCd };
      if (bun) params.bun = String(bun).padStart(4, "0");
      if (ji) params.ji = String(ji).padStart(4, "0");
      try {
        const got = await fetchHsPages(HS_OPS[sec], params, maxPagesPerOp);
        총행수 += got.items.length;
        for (const x of got.items) rows.push(MAPPERS[sec](x));
        if (got.실패페이지) 실패.push({ 섹션: sec, 법정동: t.법정동명 || t.bjdongCd, ...{ 실패페이지: got.실패페이지 } });
      } catch (e) {
        실패.push({ 섹션: sec, 법정동: t.법정동명 || t.bjdongCd, 오류: String(e.message || e) });
      }
    }
    collected[sec] = rows;
  }

  // ── 기본개요를 축으로 단지 결합
  const basis = collected["기본개요"] || [];
  // ★ 관리공동형별개요는 PK 필드명이 mgmCoophsrgstPk라 기본개요의 mgmHsrgstPk와 결합되지
  //   않는다. 지번(시군구+법정동+대지구분+번+지)이 유일하게 통하는 키다.
  //   번·지의 zero-padding이 대장마다 갈리므로 4자리로 맞춰서 비교한다.
  //   대지위치 문자열은 "…번지" 접미가 붙고 안 붙고가 갈려 보조 키로만 쓴다.
  const padKey = (r) =>
    [r.시군구코드, r.법정동코드, r.대지구분, String(r.번 ?? "").padStart(4, "0"), String(r.지 ?? "").padStart(4, "0")].join("-");
  const platKey = (v) => norm(String(v || "").replace(/번지$/, ""));
  const mgmByJibun = new Map();
  const mgmByPlat = new Map();
  for (const m of collected["관리공동형별개요"] || []) {
    const k = padKey(m);
    // 같은 지번에 형별(84A·84B·상가…)이 여러 행으로 나뉘므로 세대수가 가장 큰 행을 대표로 둔다.
    const prev = mgmByJibun.get(k);
    if (!prev || (m.세대수 || 0) > (prev.세대수 || 0)) mgmByJibun.set(k, m);
    const pk = platKey(m.대지위치);
    const prevP = mgmByPlat.get(pk);
    if (pk && (!prevP || (m.세대수 || 0) > (prevP.세대수 || 0))) mgmByPlat.set(pk, m);
  }

  let 단지 = basis.map((b) => {
    const m = mgmByJibun.get(padKey(b)) || mgmByPlat.get(platKey(b.대지위치)) || null;
    return {
      ...b,
      단지명_대장: m?.단지명 ?? null,
      사업주체명: m?.사업주체명 ?? null,
      사업승인일_형별: m?.사업승인일 ?? null,
      난방방식: m?.난방방식 ?? null,
      사용연료: m?.사용연료 ?? null,
      주택유형: m?.주택유형 ?? null,
      최고층수: m?.최고층수 ?? null,
      승강기_승용: m?.승강기_승용 ?? null,
      복도형식: m?.복도형식 ?? null,
      관리방식: m?.관리방식 ?? null,
      형별결합: m ? "지번" : null,
    };
  });

  // ── 필터
  const before = 단지.length;
  if (minHouseholds) 단지 = 단지.filter((d) => (d.총세대수 || 0) >= minHouseholds);
  if (approvedFrom) 단지 = 단지.filter((d) => d.사업계획승인일 && d.사업계획승인일 >= ymdDash(approvedFrom));
  if (approvedTo) 단지 = 단지.filter((d) => d.사업계획승인일 && d.사업계획승인일 <= ymdDash(approvedTo));
  if (useInsptSchedFrom)
    단지 = 단지.filter((d) => d.사용검사예정일 && d.사용검사예정일 >= ymdDash(useInsptSchedFrom));
  if (useInsptSchedTo)
    단지 = 단지.filter((d) => d.사용검사예정일 && d.사용검사예정일 <= ymdDash(useInsptSchedTo));
  if (stage) 단지 = 단지.filter((d) => d.진행상태 === stage);
  if (nameContains) {
    const q = norm(nameContains);
    단지 = 단지.filter((d) => norm(d.단지명).includes(q) || norm(d.단지명_대장).includes(q));
  }

  단지.sort((a, b) => String(b.사용검사예정일 || b.사업계획승인일 || "").localeCompare(String(a.사용검사예정일 || a.사업계획승인일 || "")));
  const 반환 = 단지.slice(0, limit);

  const out = {
    ok: true,
    조회조건: {
      지역: region ?? null,
      시군구코드: sigunguCd ?? null,
      법정동코드: bjdongCd ?? null,
      번지: bun ? `${bun}${ji ? "-" + ji : ""}` : null,
      섹션: wanted,
    },
    ...(지역해석 ? { 지역해석 } : {}),
    수집행수: 총행수,
    필터전_단지수: before,
    조건일치_단지수: 단지.length,
    반환_단지수: 반환.length,
    단지: 반환,
    caveats: HS_CAVEATS,
  };
  // 기본개요·관리공동형별개요 외의 섹션은 결합하지 않고 원자료로 함께 돌려준다.
  for (const sec of wanted) {
    if (sec === "기본개요" || sec === "관리공동형별개요") continue;
    out[sec] = (collected[sec] || []).slice(0, limit);
    out[`${sec}_건수`] = (collected[sec] || []).length;
  }
  if (실패.length) out.실패 = 실패;
  if (지역해석?.잘림) {
    out.잘림 =
      `그 시군구에 법정동이 ${지역해석.해석된_법정동수}개인데 ${지역해석.순회_법정동수}개만 순회했습니다. ` +
      "maxDongs를 늘리거나 법정동을 지정해 다시 조회하세요.";
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 청약홈 분양정보 (odcloud)
// ────────────────────────────────────────────────────────────────────────────

export const SALE_TYPES = {
  APT: "getAPTLttotPblancDetail",
  오피스텔등: "getUrbtyOfctlLttotPblancDetail",
  APT무순위: "getRemndrLttotPblancDetail",
  공공지원민간임대: "getPblPvtRentLttotPblancDetail",
  임의공급: "getOPTLttotPblancDetail",
};

async function callOdc(op, { page = 1, perPage = ODC_MAX_PER_PAGE, cond = {} } = {}, { retries = 4 } = {}) {
  const params = { serviceKey: SERVICE_KEY, page, perPage };
  const parts = [qs(params)];
  for (const [k, v] of Object.entries(cond)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(`cond[${k}]`)}=${encodeURIComponent(v)}`);
  }
  const url = `${ODC}/${op}?${parts.join("&")}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!text.trim()) throw new Error(`빈 응답 (HTTP ${res.status})`);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`JSON 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      // odcloud는 미신청 키에 {"code":-4,"msg":"등록되지 않은 인증키 입니다."}를 준다.
      if (data && data.code !== undefined && data.data === undefined) {
        throw new Error(
          `청약홈 API 오류(code ${data.code}): ${data.msg || ""} ` +
            "— 이 데이터셋(한국부동산원_청약홈 분양정보 조회 서비스, data.go.kr 15098547)의 활용신청이 필요합니다."
        );
      }
      return {
        rows: data.data || [],
        // ★ totalCount는 필터를 무시한 전체 건수다. 실제 결과 수는 matchCount.
        totalCount: Number(data.totalCount ?? 0),
        matchCount: data.matchCount === undefined ? null : Number(data.matchCount),
        currentCount: Number(data.currentCount ?? (data.data || []).length),
      };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("timeout after 60000ms") : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function pullOdcAll(op, cond, maxPages = 8) {
  const first = await callOdc(op, { page: 1, cond });
  let rows = first.rows;
  const target = first.matchCount ?? first.totalCount;
  for (let p = 2; p <= maxPages; p++) {
    if (rows.length >= target) break;
    const got = await callOdc(op, { page: p, cond });
    if (!got.rows.length) break;
    rows = rows.concat(got.rows);
  }
  return { rows, totalCount: first.totalCount, matchCount: first.matchCount, 수집: rows.length };
}

function mapSale(r, type) {
  return {
    유형: type,
    주택명: trim(r.HOUSE_NM),
    주택구분: trim(r.HOUSE_SECD_NM),
    주택상세구분: trim(r.HOUSE_DTL_SECD_NM),
    분양구분: trim(r.RENT_SECD_NM),
    공급지역: trim(r.SUBSCRPT_AREA_CODE_NM),
    공급위치: trim(r.HSSPLY_ADRES),
    공급규모: Number(r.TOT_SUPLY_HSHLDCO ?? 0) || null,
    모집공고일: trim(r.RCRIT_PBLANC_DE),
    입주예정월: trim(r.MVN_PREARNGE_YM),
    "사업주체(시행사)": trim(r.BSNS_MBY_NM),
    시공사: trim(r.CNSTRCT_ENTRPS_NM),
    정비사업: trim(r.IMPRMN_BSNS_AT),
    공공주택지구: trim(r.PUBLIC_HOUSE_EARTH_AT),
    문의처: trim(r.MDHS_TELNO),
    공고URL: trim(r.PBLANC_URL),
    공고번호: trim(r.PBLANC_NO),
  };
}

const SALE_CAVEATS = [
  "청약홈은 모집공고가 올라온 분양분만 담습니다. 지역주택조합 조합원분 전량·임대·후분양은 구조적으로 빠집니다 — 전수가 필요하면 search_housing_permits(주택인허가)를 함께 쓰세요.",
  "오피스텔·생활숙박시설 오퍼레이션에는 시공사(CNSTRCT_ENTRPS_NM) 컬럼이 없어 시행사만 나옵니다.",
  "응답의 totalCount는 필터를 무시한 전체 건수이고, 조건에 맞는 건수는 matchCount입니다. 이 서버는 조건일치_건수로 정규화해 돌려줍니다.",
];

/**
 * 청약홈 분양정보를 조회한다.
 * 시공사·입주예정월은 미문서화 필터라 서버측 cond가 무시될 수 있으므로,
 * 필터가 먹지 않은 것으로 판단되면 로컬 필터로 폴백한다.
 */
export async function searchHousingSales({
  types = ["APT"],
  houseName,
  contractor,
  developer,
  areaName,
  addressContains,
  moveInFrom,
  moveInTo,
  noticeFrom,
  noticeTo,
  minHouseholds,
  limit = 50,
  maxPages = 8,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();

  const wanted = types.filter((t) => SALE_TYPES[t]);
  if (!wanted.length) {
    return { ok: false, reason: `types가 비어 있거나 알 수 없는 값입니다. 사용 가능: ${Object.keys(SALE_TYPES).join(", ")}` };
  }

  const 소스별 = {};
  let all = [];
  const 실패 = [];
  let 서버필터_무시됨 = false;

  for (const t of wanted) {
    // 문서화된 필터만 서버측으로 보낸다(미문서화 필터는 폴백 판정이 필요해 로컬에서 건다).
    const cond = {};
    if (houseName) cond["HOUSE_NM::LIKE"] = houseName;
    if (areaName) cond["SUBSCRPT_AREA_CODE_NM::EQ"] = areaName;
    if (addressContains) cond["HSSPLY_ADRES::LIKE"] = addressContains;
    if (noticeFrom) cond["RCRIT_PBLANC_DE::GTE"] = noticeFrom;
    if (noticeTo) cond["RCRIT_PBLANC_DE::LTE"] = noticeTo;
    try {
      const got = await pullOdcAll(SALE_TYPES[t], cond, maxPages);
      // 조건을 걸었는데 matchCount가 totalCount와 같으면 서버가 필터를 무시한 것이다.
      if (Object.keys(cond).length && got.matchCount !== null && got.matchCount === got.totalCount) {
        서버필터_무시됨 = true;
      }
      소스별[t] = { totalCount: got.totalCount, 조건일치_건수: got.matchCount ?? got.수집, 수집: got.수집 };
      all = all.concat(got.rows.map((r) => mapSale(r, t)));
    } catch (e) {
      실패.push({ 유형: t, 오류: String(e.message || e) });
    }
  }

  // ── 로컬 필터 (미문서화 필드 + 서버필터 폴백)
  const before = all.length;
  let rows = all;
  if (서버필터_무시됨) {
    if (houseName) rows = rows.filter((r) => norm(r.주택명).includes(norm(houseName)));
    if (areaName) rows = rows.filter((r) => norm(r.공급지역) === norm(areaName));
    if (addressContains) rows = rows.filter((r) => norm(r.공급위치).includes(norm(addressContains)));
    if (noticeFrom) rows = rows.filter((r) => r.모집공고일 && r.모집공고일 >= noticeFrom);
    if (noticeTo) rows = rows.filter((r) => r.모집공고일 && r.모집공고일 <= noticeTo);
  }
  if (contractor) {
    const list = Array.isArray(contractor) ? contractor : [contractor];
    rows = rows.filter((r) => list.some((c) => norm(r.시공사).includes(norm(c))));
  }
  if (developer) {
    const list = Array.isArray(developer) ? developer : [developer];
    rows = rows.filter((r) => list.some((c) => norm(r["사업주체(시행사)"]).includes(norm(c))));
  }
  if (moveInFrom) rows = rows.filter((r) => r.입주예정월 && r.입주예정월 >= onlyDigits(moveInFrom));
  if (moveInTo) rows = rows.filter((r) => r.입주예정월 && r.입주예정월 <= onlyDigits(moveInTo));
  if (minHouseholds) rows = rows.filter((r) => (r.공급규모 || 0) >= minHouseholds);

  rows.sort((a, b) => String(a.입주예정월 || "999999").localeCompare(String(b.입주예정월 || "999999")));

  return {
    ok: true,
    조회조건: {
      유형: wanted,
      주택명: houseName ?? null,
      시공사: contractor ?? null,
      시행사: developer ?? null,
      공급지역: areaName ?? null,
      입주예정월: moveInFrom || moveInTo ? `${moveInFrom ?? ""}~${moveInTo ?? ""}` : null,
      모집공고일: noticeFrom || noticeTo ? `${noticeFrom ?? ""}~${noticeTo ?? ""}` : null,
    },
    소스별,
    수집_전체건수: before,
    조건일치_건수: rows.length,
    반환_건수: Math.min(rows.length, limit),
    ...(서버필터_무시됨
      ? { 필터경로: "서버측 cond가 무시되어 로컬 필터로 처리했습니다(미문서화 파라미터가 막혔을 가능성)." }
      : { 필터경로: "문서화 필터는 서버측 cond, 시공사·시행사·입주예정월·세대수는 로컬 필터" }),
    분양: rows.slice(0, limit),
    caveats: SALE_CAVEATS,
    ...(실패.length ? { 실패 } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 수주 파이프라인 — 청약홈(시공사) × 주택인허가(공정) 교차
// ────────────────────────────────────────────────────────────────────────────

const 시도약칭 = {
  서울: "서울특별시", 부산: "부산광역시", 대구: "대구광역시", 인천: "인천광역시",
  광주: "광주광역시", 대전: "대전광역시", 울산: "울산광역시", 세종: "세종특별자치시",
  경기: "경기도", 강원: "강원특별자치도", 충북: "충청북도", 충남: "충청남도",
  전북: "전북특별자치도", 전남: "전라남도", 경북: "경상북도", 경남: "경상남도",
  제주: "제주특별자치도",
};

// "충청남도 아산시 탕정면 매곡리 869" → "아산시"
function sigunguFromAddress(addr) {
  const s = String(addr || "").trim();
  const m = s.match(/([가-힣]+(?:특별자치도|특별자치시|특별시|광역시|도))\s+([가-힣]+시\s+[가-힣]+구|[가-힣]+시|[가-힣]+군|[가-힣]+구)/);
  return m ? m[2].replace(/\s+/g, " ") : null;
}

/**
 * 시공사 목록과 입주예정 기간으로 수주 파이프라인을 산출한다.
 * enrich=true면 각 현장의 시군구를 해석해 주택인허가로 사용검사예정일까지 보강한다
 * (호출량이 커서 기본은 off).
 */
export async function scanConstructionPipeline({
  contractors = ["현대건설", "현대엔지니어링", "포스코이앤씨"],
  moveInFrom,
  moveInTo,
  types = ["APT"],
  areaName,
  minHouseholds,
  enrich = false,
  enrichLimit = 5,
  limit = 200,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();

  const sales = await searchHousingSales({
    types,
    contractor: contractors,
    areaName,
    moveInFrom,
    moveInTo,
    minHouseholds,
    limit: 1000,
  });
  if (!sales.ok) return sales;

  const rows = sales.분양;

  // ── 집계 (코드로 계산한 값을 그대로 사용한다 — 눈으로 다시 세지 않는다)
  const 연도별 = {};
  const 시공사별 = {};
  let 세대합계 = 0;
  for (const r of rows) {
    세대합계 += r.공급규모 || 0;
    const y = String(r.입주예정월 || "").slice(0, 4) || "미상";
    연도별[y] = (연도별[y] || 0) + 1;
    for (const c of contractors) {
      if (norm(r.시공사).includes(norm(c))) 시공사별[c] = (시공사별[c] || 0) + 1;
    }
  }

  // ── 주택인허가 보강 (선택)
  const 보강 = [];
  if (enrich) {
    const seen = new Set();
    for (const r of rows) {
      if (보강.length >= enrichLimit) break;
      const sgg = sigunguFromAddress(r.공급위치);
      if (!sgg || seen.has(sgg + r.주택명)) continue;
      seen.add(sgg + r.주택명);
      try {
        const hp = await searchHousingPermits({
          region: sgg,
          sections: ["기본개요"],
          minHouseholds: Math.max(30, Math.floor((r.공급규모 || 100) * 0.3)),
          maxDongs: 8,
          limit: 300,
        });
        // ★ 지역 단지를 그대로 나열하면 쓸모가 없다(실측: 분당구 161건). 이름 토큰 일치와
        //   세대수 근접도로 점수를 매겨 상위만 남기고, 점수와 근거를 함께 돌려준다.
        //   대장 명칭이 브랜드명과 다른 사례가 많아 이름만으로는 못 찾으므로 세대수를 함께 본다.
        const 공고세대 = r.공급규모 || 0;
        // ★ norm()은 공백을 지우므로 토큰 분리는 **norm 전에** 해야 한다.
        //   norm 후 match를 돌리면 이름 전체가 토큰 1개가 되어 점수가 항상 0 또는 1이 된다.
        const 토큰 = String(r.주택명 || "")
          .split(/[\s()·,]+/)
          .map(norm)
          .filter((t) => t.length >= 2 && !/^\d+(차|단지|회차|블록|bl)?$/.test(t));
        const 전체명 = norm(r.주택명);
        const scored = (hp.단지 || [])
          .filter((d) => d.진행상태 !== "준공" || (d.사용검사일 && d.사용검사일 >= "2025-01-01"))
          .map((d) => {
            const nm = norm(d.단지명) + "|" + norm(d.단지명_대장);
            const 이름점수 = 토큰.filter((t) => nm.includes(t)).length;
            // 정규화한 이름이 통째로 들어 있으면 사실상 확정이다.
            const 완전일치 = 전체명 && nm.includes(전체명) ? 1 : 0;
            let 세대점수 = 0;
            if (공고세대 && d.총세대수) {
              // ★ 공고 세대수는 일반분양분만인 경우가 많아 대장 세대수보다 작다
              //   (실측: 힐스테이트 이천역 2단지 공고 168세대 / 대장 885세대).
              //   따라서 비율 근접은 약한 신호로만 쓰고, 이름 일치에 무게를 둔다.
              const ratio = Math.min(공고세대, d.총세대수) / Math.max(공고세대, d.총세대수);
              세대점수 = ratio >= 0.9 ? 2 : ratio >= 0.5 ? 1 : 0;
            }
            return {
              점수: 완전일치 * 8 + 이름점수 * 3 + 세대점수,
              이름완전일치: !!완전일치,
              이름일치토큰: 이름점수,
              세대근접: 세대점수,
              ...d,
            };
          })
          .filter((d) => d.점수 > 0)
          .sort((a, b) => b.점수 - a.점수);
        보강.push({
          주택명: r.주택명,
          공고세대: 공고세대,
          해석된_시군구: sgg,
          지역_후보군: (hp.단지 || []).length,
          매칭후보수: scored.length,
          후보: scored.slice(0, 3),
          매칭방법: "단지명 완전일치(8) + 토큰 일치(각 3) + 세대수 근접(최대 2). 8점 이상이면 사실상 확정, 3점 이하면 동명이 아닐 수 있으니 대지위치로 확인하세요. 공고 세대수는 일반분양분만인 경우가 많아 대장 세대수보다 작습니다.",
        });
      } catch (e) {
        보강.push({ 주택명: r.주택명, 해석된_시군구: sgg, 오류: String(e.message || e) });
      }
    }
  }

  return {
    ok: true,
    조회조건: {
      시공사: contractors,
      입주예정월: `${moveInFrom ?? ""}~${moveInTo ?? ""}`,
      유형: types,
      공급지역: areaName ?? null,
      최소세대수: minHouseholds ?? null,
    },
    수집_전체건수: sales.수집_전체건수,
    조건일치_현장수: rows.length,
    총공급세대_합계: 세대합계,
    연도별_현장수: Object.fromEntries(Object.entries(연도별).sort()),
    시공사별_현장수: 시공사별,
    현장: rows.slice(0, limit),
    ...(enrich ? { 주택인허가_보강: 보강 } : {}),
    caveats: [
      ...SALE_CAVEATS,
      "이 목록은 파이프라인의 **하한**입니다. 청약홈에 공고가 올라오지 않은 현장(지역주택조합 조합원분 전량 등)은 빠져 있으므로, 전수가 필요하면 search_housing_permits로 지역별 보강 조회를 하세요.",
      "시공사 이름은 표기가 흔들립니다((주)·주식회사·컨소시엄 병기). 부분일치로 걸러내며, 컨소시엄 건은 참여 시공사 전부에 잡힙니다.",
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// MCP 도구 등록 — server.js에서 registerHousingTools(server, z)로 호출한다.
// (도구 정의를 클라이언트와 같은 파일에 두어, 이 소스를 다루는 사람이 함정 주석과
//  도구 설명을 한 화면에서 보게 한다.)
// ────────────────────────────────────────────────────────────────────────────

export function registerHousingTools(server, z) {
  // ── 주택인허가 · 청약홈 분양정보 ──────────────────────────────────────────
  server.tool(
    "search_housing_permits",
    "국토교통부 건축HUB **주택인허가정보**(주택법 사업계획승인 대장)를 지역 단위로 조회해 " +
      "**단지 정보로 결합**해 돌려줍니다. 기본개요(사업계획승인일·착공일·사용검사예정일·총세대수)와 " +
      "관리공동형별개요(**사업주체=시행사**·난방방식·사용연료·주택유형)를 관리주택대장PK와 대지위치로 " +
      "붙여, 단지 한 줄에 공정과 시행사가 함께 나오게 합니다. 동별개요·행위개요도 선택할 수 있습니다.\n" +
      "★ **이것이 분양 여부와 무관한 전수 소스입니다.** 청약홈(search_housing_sales)에는 지역주택조합 " +
      "조합원분 전량·임대·후분양이 구조적으로 빠지는데, 이 대장에는 사업계획승인을 받은 공동주택이 " +
      "전부 들어옵니다(실측: 힐스테이트 마포더퍼스트 488세대, 동작 하이팰리스 608세대가 청약홈에는 " +
      "없고 여기에는 있었습니다).\n" +
      "★ **시공사는 이 대장에 없습니다** — 시행사만 있습니다. 시공사가 필요하면 search_housing_sales와 " +
      "함께 쓰세요.\n" +
      "★ **착공일은 준공 후에야 채워집니다.** 시공 중인 단지는 착공예정일만 있고 착공일이 비어 있는 것이 " +
      "정상입니다. 공정 역산은 사용검사예정일로 하세요.\n" +
      "★ **조회 단위가 법정동입니다.** region에 시군구명을 주면 서버가 법정동 목록을 해석해 순회합니다. " +
      "시군구코드만으로는 원 API가 오류 없이 빈 결과를 돌려줍니다.\n" +
      "★ **행정구역 개편에 주의하세요.** 광주광역시가 행정표준코드에서 '전남광주통합특별시'로 바뀌어 " +
      "시군구코드가 29170→12300으로 이동했습니다. 코드를 직접 박지 말고 region으로 주면 자동 해석됩니다.\n" +
      "★ 오피스텔·생활숙박시설은 주택법이 아니라 건축법 대상이라 여기 없습니다 — search_arch_permits로 가세요.",
    {
      region: z.string().optional().describe("시군구명(예: '이천시', '동작구', '성남시 분당구'). sigunguCd+bjdongCd 대신 이걸 주면 법정동을 해석해 순회합니다"),
      sigunguCd: z.string().optional().describe("시군구코드 5자리. bjdongCd와 함께 주면 그 법정동만 조회"),
      bjdongCd: z.string().optional().describe("법정동코드 5자리"),
      bun: z.string().optional().describe("번. 4자리로 자동 zero-padding. ★ 사업계획승인 지번과 모집공고 지번이 다를 수 있어 좁히면 놓칠 수 있습니다"),
      ji: z.string().optional().describe("지. 4자리로 자동 zero-padding"),
      sections: z.array(z.string()).optional().describe("조회할 대장. 기본 ['기본개요','관리공동형별개요']. 사용 가능: " + Object.keys(HS_OPS).join(", ")),
      nameContains: z.string().optional().describe("단지명 부분검색. ★ 대장 명칭이 분양 브랜드명과 다른 경우가 흔합니다(조합명·사업명으로 등재)"),
      minHouseholds: z.number().int().optional().describe("최소 총세대수"),
      approvedFrom: z.string().optional().describe("사업계획승인일 시작 YYYYMMDD"),
      approvedTo: z.string().optional().describe("사업계획승인일 종료 YYYYMMDD"),
      useInsptSchedFrom: z.string().optional().describe("사용검사예정일 시작 YYYYMMDD — 공정 역산의 기준"),
      useInsptSchedTo: z.string().optional().describe("사용검사예정일 종료 YYYYMMDD"),
      stage: z.enum(["승인", "착공예정", "시공중", "준공", "미상"]).optional().describe("진행상태 필터"),
      maxDongs: z.number().int().min(1).max(200).optional().describe("순회할 최대 법정동 수 (기본 20). 일일 트래픽 10,000건이라 전국 전수는 불가"),
      maxPagesPerOp: z.number().int().min(1).max(50).optional().describe("대장별 최대 페이지 (기본 10). 페이지당 100행 상한"),
      limit: z.number().int().min(1).max(300).optional().describe("반환 단지 수 (기본 50)"),
    },
    async (args) => {
      const result = await searchHousingPermits(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_housing_sales",
    "한국부동산원 **청약홈 분양정보**를 조회합니다. APT·오피스텔등·APT무순위·공공지원민간임대·임의공급 " +
      "5종을 한 도구로 다루며, **사업주체(시행사)·시공사·공급규모·공급위치·모집공고일·입주예정월**을 " +
      "돌려줍니다.\n" +
      "★ **시공사를 알 수 있는 유일한 소스입니다.** 주택인허가 대장에는 시행사만 있습니다.\n" +
      "★ **분양분만 담깁니다.** 지역주택조합 조합원분 전량·임대·후분양은 구조적으로 빠집니다. " +
      "전수가 필요하면 search_housing_permits를 함께 쓰세요.\n" +
      "★ 오피스텔·생활숙박시설 오퍼레이션에는 시공사 컬럼이 아예 없어 시행사만 나옵니다.\n" +
      "★ 원 API의 totalCount는 필터를 무시한 전체 건수입니다. 이 서버는 조건일치_건수로 정규화해 " +
      "돌려주므로 그 값을 쓰세요.\n" +
      "★ 시공사·입주예정월은 원 기술문서에 없는 미문서화 필터라 서버측 조건이 무시될 수 있습니다. " +
      "이 서버는 전수를 받아 로컬에서 거르므로 막혀도 결과가 달라지지 않습니다(필터경로 필드로 밝힙니다).",
    {
      types: z.array(z.string()).optional().describe("조회할 분양 유형. 기본 ['APT']. 사용 가능: " + Object.keys(SALE_TYPES).join(", ")),
      houseName: z.string().optional().describe("주택명 부분검색"),
      contractor: z.union([z.string(), z.array(z.string())]).optional().describe("시공사 부분검색. 배열로 여러 개 가능(OR)"),
      developer: z.union([z.string(), z.array(z.string())]).optional().describe("사업주체(시행사) 부분검색. 배열 가능"),
      areaName: z.string().optional().describe("공급지역명(예: '서울', '경기', '충남')"),
      addressContains: z.string().optional().describe("공급위치 부분검색"),
      moveInFrom: z.string().optional().describe("입주예정월 시작 YYYYMM"),
      moveInTo: z.string().optional().describe("입주예정월 종료 YYYYMM"),
      noticeFrom: z.string().optional().describe("모집공고일 시작 YYYY-MM-DD"),
      noticeTo: z.string().optional().describe("모집공고일 종료 YYYY-MM-DD"),
      minHouseholds: z.number().int().optional().describe("최소 공급규모(세대)"),
      limit: z.number().int().min(1).max(1000).optional().describe("반환 건수 (기본 50)"),
      maxPages: z.number().int().min(1).max(20).optional().describe("유형별 최대 페이지 (기본 8, 페이지당 1,000건)"),
    },
    async (args) => {
      const result = await searchHousingSales(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "scan_construction_pipeline",
    "**설비·자재 협력사의 수주 파이프라인을 산출합니다.** 시공사 목록과 입주예정 기간을 주면 청약홈에서 " +
      "해당 현장을 뽑아 **연도별 현장수·시공사별 현장수·총공급세대 합계**까지 계산해 돌려줍니다. " +
      "냉난방·설비 공사는 준공 12~24개월 전에 들어가므로, 입주예정월을 앞으로 당겨 잡으면 그것이 곧 " +
      "영업 타깃 목록이 됩니다.\n" +
      "★ enrich=true를 주면 각 현장의 시군구를 주소에서 해석해 주택인허가로 **사용검사예정일까지 보강**합니다. " +
      "호출량이 커서 기본은 off이고 enrichLimit(기본 5)으로 제한합니다.\n" +
      "★ **결과는 파이프라인의 하한입니다.** 청약홈에 공고가 올라오지 않은 현장은 빠지므로, " +
      "특정 지역을 파려면 search_housing_permits로 보강 조회를 하세요.\n" +
      "★ 컨소시엄 현장은 참여 시공사 전부에 잡히므로 시공사별 합계는 현장수 합계보다 클 수 있습니다.",
    {
      contractors: z.array(z.string()).optional().describe("시공사 목록(부분일치, OR). 기본 ['현대건설','현대엔지니어링','포스코이앤씨']"),
      moveInFrom: z.string().optional().describe("입주예정월 시작 YYYYMM"),
      moveInTo: z.string().optional().describe("입주예정월 종료 YYYYMM"),
      types: z.array(z.string()).optional().describe("분양 유형. 기본 ['APT']"),
      areaName: z.string().optional().describe("공급지역명으로 한정"),
      minHouseholds: z.number().int().optional().describe("최소 공급규모(세대)"),
      enrich: z.boolean().optional().describe("주택인허가로 사용검사예정일 보강 (기본 false)"),
      enrichLimit: z.number().int().min(1).max(20).optional().describe("보강할 현장 수 (기본 5)"),
      limit: z.number().int().min(1).max(500).optional().describe("반환 현장 수 (기본 200)"),
    },
    async (args) => {
      const result = await scanConstructionPipeline(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

}
