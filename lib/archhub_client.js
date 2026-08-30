// public-data-portal-mcp / lib/archhub_client.js
//
// 국토교통부 건축HUB 건축인허가정보 (세움터) + 행정안전부 행정표준코드 법정동코드.
//
//   건축HUB   https://apis.data.go.kr/1613000/ArchPmsHubService/<오퍼레이션>
//   법정동코드 https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList
//
// 두 서비스 모두 공공데이터포털 공용키(DATA_PORTAL_KEY)를 쓴다. 건축CALS와 달리 별도 키가
// 필요 없다.
//
// ── 실측으로 확인한 함정 (2026-08-29) ────────────────────────────────────────
//
// ★★ **조회 단위가 법정동이다.** sigunguCd(시군구)만 주면 body가 빈 객체로 오는데
//   resultCode는 "00"(정상)이다 — 에러가 아니라 조용히 0건이다. sigunguCd + bjdongCd가
//   함께 있어야 조회된다. 그래서 지역 스캔은 법정동 목록을 먼저 확보해 순회해야 한다.
//
// ★★ **startDate·endDate는 건축허가일이 아니라 crtnDay(데이터 생성일) 기준이다.**
//   실측: 2026년 구간으로 조회했더니 archPmsDay가 2007년인 행이 섞여 나왔다. "○○년에
//   허가난 건"을 뽑으려면 서버가 archPmsDay로 다시 걸러야 한다(permitFrom/permitTo).
//
// ★ 응답 래퍼가 결과 유무에 따라 다르다. 데이터가 있으면 {response:{header,body}}인데
//   없으면 {body,header}가 루트로 온다. 건설CALS와 같은 패턴이라 unwrap()으로 둘 다 받는다.
//
// ★ resultCode는 공공데이터포털 표준인 두 자리 "00"이다(건설CALS의 한 자리 "0"과 다르다).
//
// ★ apis.data.go.kr이 간헐적으로 연결을 끊는다("Recv failure: Connection reset by peer").
//   인증 문제가 아니므로 재시도로 흡수한다.
//
// ★ 법정동코드 API의 응답 구조가 비표준이다.
//     {"StanReginCd":[{"head":[{totalCount},{numOfRows,pageNo,type},{RESULT:{resultCode}}]},
//                     {"row":[...]}]}
//   배열 안에 head와 row가 별개 객체로 들어 있고, resultCode는 "00"이 아니라 "INFO-0"이며
//   메시지는 "NOMAL SERVICE"로 오타가 있다. 표준 파서를 그대로 쓰면 터진다.
//
// ★ 법정동코드 10자리는 그대로 쪼개 쓴다 — region_cd "1168010300" = sigunguCd "11680" +
//   bjdongCd "10300". 실측으로 확인했다.
//
// ── 데이터 범위 ─────────────────────────────────────────────────────────────
//
// 전국 자치단체 세움터 건축행정정보이며, 민간 건축공사를 덮는다. 건설CALS(국토관리청 토목)
// 나 키스콘(건설업체 등록·처분)이 못 보는 영역이다.
//
// ★ 최신성: 실측 crtnDay 최대 2026-07-30, realStcnsDay 최대 2026-07-28으로 약 1개월 지연이다
//   (건설CALS 품질검사가 2024-08-30에서 멈춰 있는 것과 대비된다). 선행지표로 쓸 수 있다.
//
// ★ 일일 트래픽 10,000건이다. 전국 법정동은 20,560개라 하루에 전국 전수 스캔은 불가능하다.
//   지역을 좁혀 쓰는 것을 전제로 설계했다(실측 서울 강남구 법정동 15개).

import { SERVICE_KEY, SERVICE_KEY_SOURCE } from "./pdp_client.js";

const HUB = "https://apis.data.go.kr/1613000/ArchPmsHubService";
const REGION = "https://apis.data.go.kr/1741000/StanReginCd/getStanReginCdList";
// ★★ 건축HUB는 페이지당 100행이 상한이다. numOfRows에 200·500·1000을 줘도 에러 없이
//   응답의 numOfRows를 100으로 되돌리고 100행만 준다(실측). 상한을 1,000으로 잡고
//   페이지 수를 전체건수÷1,000으로 계산하면 **의도한 양의 1/10만 수집**하게 되고,
//   그 표본으로 통계를 내면 숫자는 나오지만 무엇의 통계인지 말할 수 없다.
//   잘린 100건은 무작위 표본이 아니라 원 API가 첫 페이지에 주는 순서대로의 100건이며,
//   그 정렬 기준은 명세에 없다.
const MAX_ROWS = 100;
// 법정동코드 API는 별개 서비스라 상한이 다르다(1,000까지 정상).
const REGION_MAX_ROWS = 1000;

export const ARCHHUB_DATA_LAG = "약 1개월 (실측 최신 생성일 2026-07-30)";
export const TOTAL_BJDONG = 20560;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onlyDigits = (s) => String(s ?? "").replace(/[^0-9]/g, "");
const trim = (s) => {
  const v = s == null ? "" : String(s).trim();
  return v || null;
};
const ymdDash = (v) => {
  const d = onlyDigits(v);
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null;
};

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

// 성공이면 {response:{...}}, 0건이면 {...}가 루트로 온다.
const unwrap = (json) => (json && json.response ? json.response : json);

// ★ 관리번호(mgmPmsrgstPk)가 22자리 정수로 오는데, 그대로 JSON.parse하면
//   1.0000000000000008e+21처럼 정밀도를 잃어 **다시는 그 건을 찾을 수 없게 된다.**
//   실측에서 강남구 청담동 건이 이렇게 깨졌다. 파싱 전에 문자열로 바꿔 보존한다.
//   (13자리로 오는 건도 있어 자릿수와 무관하게 전부 감싼다.)
function bigIntSafe(text) {
  // mgmPmsrgstPk 외에 mgmDongOulnPk 등 다른 Pk 필드도 같은 위험이 있으므로
  // 이름이 Pk로 끝나는 숫자 값은 전부 문자열로 감싼다.
  return text.replace(/"([A-Za-z]*Pk)"\s*:\s*(-?\d+)/g, '"$1":"$2"');
}

async function callHub(op, params, { timeoutMs = 30000, retries = 3 } = {}) {
  const url = `${HUB}/${op}?serviceKey=${SERVICE_KEY}&_type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
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
      // 0건이면 body가 빈 객체이고 items 자체가 없다.
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

async function fetchHubPages(op, params, maxPages = 20) {
  const first = await callHub(op, { ...params, pageNo: 1, numOfRows: MAX_ROWS });
  let items = first.items;
  // ★ 페이지 수를 totalCount로 미리 계산하지 않고 **실제로 받은 행 수**로 진행을 판단한다.
  //   원 API가 numOfRows를 조용히 깎는 이력이 있어, 계산식에 상한을 박아두면 다시 어긋난다.
  const perPage = first.items.length || MAX_ROWS;
  const pages = Math.min(Math.ceil(first.totalCount / perPage) || 1, maxPages);
  for (let p = 2; p <= pages; p++) {
    const got = await callHub(op, { ...params, pageNo: p, numOfRows: MAX_ROWS });
    items = items.concat(got.items);
    if (!got.items.length) break;
  }
  return {
    items,
    totalCount: first.totalCount,
    truncated: first.totalCount > items.length,
    페이지당_실제행수: perPage,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 법정동코드 해석
// ────────────────────────────────────────────────────────────────────────────

async function callRegion(params, { timeoutMs = 30000, retries = 3 } = {}) {
  const url = `${REGION}?serviceKey=${SERVICE_KEY}&type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(800 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();
      const data = JSON.parse(text);
      // ★ 비표준 구조: 배열 안에 head와 row가 별개 객체로 들어 있다.
      const arr = data?.StanReginCd;
      if (!Array.isArray(arr)) {
        const err = data?.RESULT || data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
        const code = String(err?.resultCode ?? "");
        // ★ INFO-3은 "데이터없음"이라 오류가 아니다. 없는 지역명을 준 정상적인 경우이므로
        //   빈 결과로 돌려줘야 한다. 던지면 상위 도구가 통째로 실패한다.
        if (code === "INFO-3") return { rows: [], totalCount: 0 };
        throw new Error(`법정동코드 조회 실패: ${JSON.stringify(err || data).slice(0, 200)}`);
      }
      const head = arr.find((x) => x.head)?.head ?? [];
      const totalCount = Number(head.find((h) => h.totalCount)?.totalCount ?? 0);
      const rows = arr.find((x) => x.row)?.row ?? [];
      return { rows, totalCount };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 지역명(시군구명 또는 "시도 시군구")으로 법정동 목록을 해석한다.
 * region_cd 10자리를 sigunguCd(앞 5) + bjdongCd(뒤 5)로 쪼갠다.
 */
export async function resolveBjdong(regionName, { limit = 500 } = {}) {
  const got = await callRegion({ locatadd_nm: regionName, pageNo: 1, numOfRows: Math.min(limit, REGION_MAX_ROWS) });
  const dongs = got.rows
    .map((r) => ({
      법정동코드: String(r.region_cd),
      시군구코드: String(r.region_cd).slice(0, 5),
      법정동부코드: String(r.region_cd).slice(5),
      주소: trim(r.locatadd_nm),
      동명: trim(r.locallow_nm),
      상위코드: String(r.locathigh_cd || ""),
      리코드: String(r.ri_cd || ""),
    }))
    // 리(里) 단위는 건축HUB 조회 단위가 아니므로 제외한다(ri_cd가 "00"인 것만 법정동).
    .filter((d) => d.리코드 === "00" && d.법정동부코드 !== "00000");
  return { 전체건수: got.totalCount, 법정동수: dongs.length, 법정동: dongs };
}

// ────────────────────────────────────────────────────────────────────────────
// 공통 — 기본개요 행 정규화 및 필터
// ────────────────────────────────────────────────────────────────────────────

function mapBasis(x) {
  return {
    관리번호: String(x.mgmPmsrgstPk ?? "").trim() || null,
    대지위치: trim(x.platPlc),
    건물명: trim(x.bldNm),
    건축구분: trim(x.archGbCdNm),
    주용도: trim(x.mainPurpsCdNm),
    "대지면적_㎡": x.platArea ?? null,
    "건축면적_㎡": x.archArea ?? null,
    "연면적_㎡": x.totArea ?? null,
    건폐율: x.bcRat ?? null,
    용적률: x.vlRat ?? null,
    주건축물수: x.mainBldCnt ?? null,
    세대수: x.hhldCnt ?? null,
    호수: x.hoCnt ?? null,
    가구수: x.fmlyCnt ?? null,
    총주차수: x.totPkngCnt ?? null,
    건축허가일: ymdDash(x.archPmsDay),
    착공예정일: ymdDash(x.stcnsSchedDay),
    착공연기일: ymdDash(x.stcnsDelayDay),
    실제착공일: ymdDash(x.realStcnsDay),
    사용승인일: ymdDash(x.useAprDay),
    생성일: ymdDash(x.crtnDay),
    시군구코드: trim(x.sigunguCd),
    법정동코드: trim(x.bjdongCd),
    대지구분: trim(x.platGbCd),
    번: trim(x.bun),
    지: trim(x.ji),
  };
}

function applyFilters(rows, { archGb, mainPurps, minTotArea, permitFrom, permitTo, stage }) {
  let out = rows;
  if (archGb) out = out.filter((r) => (r.건축구분 || "").includes(archGb));
  if (mainPurps) out = out.filter((r) => (r.주용도 || "").includes(mainPurps));
  if (minTotArea != null) out = out.filter((r) => Number(r["연면적_㎡"] || 0) >= Number(minTotArea));
  if (permitFrom) out = out.filter((r) => r.건축허가일 && r.건축허가일.replace(/-/g, "") >= onlyDigits(permitFrom));
  if (permitTo) out = out.filter((r) => r.건축허가일 && r.건축허가일.replace(/-/g, "") <= onlyDigits(permitTo));
  if (stage === "허가") out = out.filter((r) => r.건축허가일 && !r.실제착공일);
  else if (stage === "착공") out = out.filter((r) => r.실제착공일 && !r.사용승인일);
  else if (stage === "사용승인") out = out.filter((r) => r.사용승인일);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 지역 스캔 — 여러 법정동을 순회해 신규 허가·착공을 발굴한다
// ────────────────────────────────────────────────────────────────────────────

export async function scanArchPermits({
  region,
  sigunguCd,
  bjdongCds,
  since,
  until,
  archGb,
  mainPurps,
  minTotArea,
  permitFrom,
  permitTo,
  stage,
  maxDongs = 20,
  limit = 50,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  if (!region && !(sigunguCd && bjdongCds?.length)) {
    return {
      ok: false,
      reason: "region(지역명) 또는 sigunguCd + bjdongCds 조합이 필요합니다.",
      안내:
        "원 API는 시군구만으로는 조용히 0건을 돌려주므로(resultCode는 00) 법정동 단위로 나눠 호출해야 합니다. " +
        "region에 '강남구'처럼 시군구명을 주면 서버가 법정동 목록을 해석해 순회합니다.",
    };
  }

  let targets = [];
  let 해석 = null;
  if (region) {
    const r = await resolveBjdong(region);
    해석 = { 지역명: region, 해석된_법정동수: r.법정동수 };
    if (!r.법정동수) {
      return {
        ok: true,
        조회조건: { 지역: region },
        해석: 해석,
        결과: [],
        안내:
          "그 이름으로 법정동을 찾지 못했습니다. 시군구명을 정확히 주세요(예: '강남구', '성남시 분당구'). " +
          "행정동 이름은 법정동 체계에 없어 조회되지 않습니다.",
      };
    }
    targets = r.법정동.slice(0, maxDongs).map((d) => ({
      sigunguCd: d.시군구코드,
      bjdongCd: d.법정동부코드,
      주소: d.주소,
    }));
    해석.순회한_법정동수 = targets.length;
    해석.잘림 = r.법정동수 > targets.length;
  } else {
    targets = bjdongCds.map((b) => ({ sigunguCd, bjdongCd: onlyDigits(b), 주소: null }));
  }

  const 결과 = [];
  const 동별집계 = [];
  const 오류 = [];
  for (const t of targets) {
    try {
      const got = await fetchHubPages(
        "getApBasisOulnInfo",
        {
          sigunguCd: t.sigunguCd,
          bjdongCd: t.bjdongCd,
          startDate: since ? onlyDigits(since) : undefined,
          endDate: until ? onlyDigits(until) : undefined,
        },
        1
      );
      const mapped = got.items.map(mapBasis);
      const filtered = applyFilters(mapped, { archGb, mainPurps, minTotArea, permitFrom, permitTo, stage });
      동별집계.push({ 법정동: t.주소 || `${t.sigunguCd}-${t.bjdongCd}`, 원본건수: got.totalCount, 필터후: filtered.length });
      결과.push(...filtered);
    } catch (e) {
      오류.push({ 법정동: t.주소 || `${t.sigunguCd}-${t.bjdongCd}`, 오류: String(e.message || e) });
    }
  }

  // 착공이 임박했거나 진행 중인 건이 앞에 오도록 정렬한다.
  결과.sort((a, b) =>
    String(b.실제착공일 || b.착공예정일 || b.건축허가일 || "").localeCompare(
      String(a.실제착공일 || a.착공예정일 || a.건축허가일 || "")
    )
  );

  const 용도별 = {};
  const 구분별 = {};
  for (const r of 결과) {
    if (r.주용도) 용도별[r.주용도] = (용도별[r.주용도] || 0) + 1;
    if (r.건축구분) 구분별[r.건축구분] = (구분별[r.건축구분] || 0) + 1;
  }

  return {
    ok: true,
    조회조건: {
      지역: region ?? `${sigunguCd} / ${bjdongCds?.join(",")}`,
      생성일_구간: since || until ? `${since || "-"}~${until || "-"}` : null,
      건축구분: archGb ?? null,
      주용도: mainPurps ?? null,
      "최소연면적_㎡": minTotArea ?? null,
      허가일_구간: permitFrom || permitTo ? `${permitFrom || "-"}~${permitTo || "-"}` : null,
      단계: stage ?? null,
    },
    ...(해석 ? { 지역해석: 해석 } : {}),
    호출한_법정동수: targets.length,
    필터후건수: 결과.length,
    구분별,
    용도별,
    동별집계,
    ...(오류.length ? { 조회실패: 오류 } : {}),
    결과: 결과.slice(0, limit),
    기간필터_주의:
      "since·until은 건축허가일이 아니라 데이터 생성일(crtnDay) 기준입니다. 허가일로 좁히려면 " +
      "permitFrom·permitTo를 쓰세요 — 서버가 archPmsDay로 다시 거릅니다.",
    데이터범위:
      "전국 자치단체 세움터 건축인허가 정보이며 민간 건축공사를 포함합니다. " +
      `데이터 지연은 ${ARCHHUB_DATA_LAG}입니다. ` +
      `법정동 단위 조회라 지역 전체를 보려면 그 시군구의 법정동을 모두 돌아야 하고(전국 ${TOTAL_BJDONG.toLocaleString()}개), ` +
      "일일 트래픽 10,000건 안에서 써야 합니다.",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. 단일 조회 — 특정 법정동·지번의 건축인허가
// ────────────────────────────────────────────────────────────────────────────

export async function searchArchPermits({
  sigunguCd,
  bjdongCd,
  platGbCd,
  bun,
  ji,
  since,
  until,
  permitFrom,
  permitTo,
  archGb,
  mainPurps,
  minTotArea,
  stage,
  limit = 30,
  maxPages = 3,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  if (!sigunguCd || !bjdongCd) {
    return {
      ok: false,
      reason: "sigunguCd(시군구코드 5자리)와 bjdongCd(법정동코드 5자리)가 모두 필요합니다.",
      안내:
        "시군구만 주면 원 API가 에러 없이 빈 결과를 돌려줍니다(resultCode는 00). " +
        "코드를 모르면 scan_arch_permits에 region으로 시군구명을 주세요. " +
        "법정동코드 10자리는 앞 5자리가 시군구, 뒤 5자리가 법정동입니다(예: 1168010300 = 11680 + 10300).",
    };
  }
  const got = await fetchHubPages(
    "getApBasisOulnInfo",
    {
      sigunguCd: onlyDigits(sigunguCd),
      bjdongCd: onlyDigits(bjdongCd),
      platGbCd,
      bun: bun ? String(bun).padStart(4, "0") : undefined,
      ji: ji ? String(ji).padStart(4, "0") : undefined,
      startDate: since ? onlyDigits(since) : undefined,
      endDate: until ? onlyDigits(until) : undefined,
    },
    maxPages
  );
  const mapped = got.items.map(mapBasis);
  const rows = applyFilters(mapped, { archGb, mainPurps, minTotArea, permitFrom, permitTo, stage });

  return {
    ok: true,
    조회조건: {
      시군구코드: onlyDigits(sigunguCd),
      법정동코드: onlyDigits(bjdongCd),
      번지: bun ? `${bun}-${ji || ""}` : null,
      생성일_구간: since || until ? `${since || "-"}~${until || "-"}` : null,
      허가일_구간: permitFrom || permitTo ? `${permitFrom || "-"}~${permitTo || "-"}` : null,
    },
    전체건수: got.totalCount,
    수집행수: got.items.length,
    잘림: got.truncated,
    필터후건수: rows.length,
    결과: rows.slice(0, limit),
    기간필터_주의:
      "since·until은 건축허가일이 아니라 데이터 생성일(crtnDay) 기준입니다. " +
      "허가일 기준으로 좁히려면 permitFrom·permitTo를 쓰세요.",
    데이터범위: `전국 세움터 건축인허가 정보이며 데이터 지연은 ${ARCHHUB_DATA_LAG}입니다.`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. 상세 — 동·층·호·면적·주차장·주택유형 등
// ────────────────────────────────────────────────────────────────────────────

const DETAIL_OPS = {
  동별개요: "getApDongOulnInfo",
  층별개요: "getApFlrOulnInfo",
  호별개요: "getApHoOulnInfo",
  전유공용면적: "getApExposPubuseAreaInfo",
  호별전유공용면적: "getApHoExposPubuseAreaInfo",
  주차장: "getApPklotInfo",
  부설주차장: "getApAtchPklotInfo",
  주택유형: "getApHsTpInfo",
  지역지구구역: "getApJijiguInfo",
  도로명대장: "getApRoadRgstInfo",
  대지위치: "getApPlatPlcInfo",
};
export const DETAIL_SECTIONS = Object.keys(DETAIL_OPS);

export async function getArchPermitDetail({
  sigunguCd,
  bjdongCd,
  platGbCd,
  bun,
  ji,
  sections,
  mgmPmsrgstPk,
  limitPerSection = 20,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  if (!sigunguCd || !bjdongCd) {
    return {
      ok: false,
      reason: "sigunguCd와 bjdongCd는 필수입니다.",
      안내: "scan_arch_permits 또는 search_arch_permits 결과의 시군구코드·법정동코드·번·지를 그대로 넘기세요.",
      사용가능한_섹션: DETAIL_SECTIONS,
    };
  }
  const want = (sections && sections.length ? sections : ["동별개요", "층별개요", "주차장", "주택유형"]).filter(
    (s) => DETAIL_OPS[s]
  );
  const unknown = (sections || []).filter((s) => !DETAIL_OPS[s]);

  const base = {
    sigunguCd: onlyDigits(sigunguCd),
    bjdongCd: onlyDigits(bjdongCd),
    platGbCd,
    bun: bun ? String(bun).padStart(4, "0") : undefined,
    ji: ji ? String(ji).padStart(4, "0") : undefined,
  };

  const 섹션 = {};
  const 오류 = {};
  for (const name of want) {
    try {
      const got = await callHub(DETAIL_OPS[name], { ...base, pageNo: 1, numOfRows: MAX_ROWS });
      let items = got.items;
      if (mgmPmsrgstPk) {
        const pk = String(mgmPmsrgstPk);
        items = items.filter((x) => String(x.mgmPmsrgstPk ?? "") === pk);
      }
      섹션[name] = { 건수: mgmPmsrgstPk ? items.length : got.totalCount, 목록: items.slice(0, limitPerSection) };
    } catch (e) {
      오류[name] = String(e.message || e);
    }
  }

  return {
    ok: true,
    조회조건: { ...base, 관리번호필터: mgmPmsrgstPk ?? null },
    섹션,
    ...(Object.keys(오류).length ? { 조회실패: 오류 } : {}),
    ...(unknown.length ? { 알수없는_섹션: unknown, 사용가능한_섹션: DETAIL_SECTIONS } : {}),
    안내:
      "원 API는 관리번호(mgmPmsrgstPk)가 아니라 주소(시군구·법정동·번·지)로 조회합니다. " +
      "한 지번에 여러 인허가 건이 있으면 모두 섞여 나오므로, 특정 건만 보려면 mgmPmsrgstPk를 주세요 — " +
      "서버가 받은 뒤 걸러 줍니다. 이 경우 건수는 필터 후 값입니다.",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 4. 철거멸실·대수선·가설건축물 등 — 재건축 선행지표
// ────────────────────────────────────────────────────────────────────────────

const AUX_OPS = {
  철거멸실: "getApDemolExtngMgmRgstInfo",
  대수선: "getApImprprInfo",
  가설건축물: "getApTmpBldInfo",
  공작물: "getApHdcrMgmRgstInfo",
  오수정화시설: "getApWclfInfo",
};
export const AUX_KINDS = Object.keys(AUX_OPS);

export async function searchArchAuxRegisters({
  region,
  sigunguCd,
  bjdongCd,
  bun,
  ji,
  kinds,
  since,
  until,
  maxDongs = 10,
  limitPerKind = 20,
} = {}) {
  if (!SERVICE_KEY) return keyMissing();
  const want = (kinds && kinds.length ? kinds : ["철거멸실"]).filter((k) => AUX_OPS[k]);
  const unknown = (kinds || []).filter((k) => !AUX_OPS[k]);
  if (!want.length) {
    return { ok: false, reason: `kinds는 다음 중에서 고르세요: ${AUX_KINDS.join(", ")}`, 받은값: kinds };
  }

  let targets = [];
  let 해석 = null;
  if (region) {
    const r = await resolveBjdong(region);
    해석 = { 지역명: region, 해석된_법정동수: r.법정동수 };
    if (!r.법정동수) {
      return { ok: true,조회조건: { 지역: region }, 해석, 결과: {}, 안내: "그 이름으로 법정동을 찾지 못했습니다." };
    }
    targets = r.법정동.slice(0, maxDongs).map((d) => ({ sigunguCd: d.시군구코드, bjdongCd: d.법정동부코드, 주소: d.주소 }));
    해석.순회한_법정동수 = targets.length;
    해석.잘림 = r.법정동수 > targets.length;
  } else if (sigunguCd && bjdongCd) {
    targets = [{ sigunguCd: onlyDigits(sigunguCd), bjdongCd: onlyDigits(bjdongCd), 주소: null }];
  } else {
    return {
      ok: false,
      reason: "region(지역명) 또는 sigunguCd + bjdongCd 조합이 필요합니다.",
      안내: "이 API도 법정동 단위 조회라 시군구만으로는 조용히 0건이 나옵니다.",
    };
  }

  const 결과 = {};
  const 오류 = {};
  for (const kind of want) {
    const rows = [];
    for (const t of targets) {
      try {
        const got = await callHub(AUX_OPS[kind], {
          sigunguCd: t.sigunguCd,
          bjdongCd: t.bjdongCd,
          bun: bun ? String(bun).padStart(4, "0") : undefined,
          ji: ji ? String(ji).padStart(4, "0") : undefined,
          startDate: since ? onlyDigits(since) : undefined,
          endDate: until ? onlyDigits(until) : undefined,
          pageNo: 1,
          numOfRows: MAX_ROWS,
        });
        for (const x of got.items) rows.push({ 법정동: t.주소 || `${t.sigunguCd}-${t.bjdongCd}`, ...x });
      } catch (e) {
        (오류[kind] ||= []).push({ 법정동: t.주소 || `${t.sigunguCd}-${t.bjdongCd}`, 오류: String(e.message || e) });
      }
    }
    결과[kind] = { 건수: rows.length, 목록: rows.slice(0, limitPerKind) };
  }

  return {
    ok: true,
    조회조건: {
      지역: region ?? `${sigunguCd}-${bjdongCd}`,
      종류: want,
      생성일_구간: since || until ? `${since || "-"}~${until || "-"}` : null,
    },
    ...(해석 ? { 지역해석: 해석 } : {}),
    호출한_법정동수: targets.length,
    결과,
    ...(Object.keys(오류).length ? { 조회실패: 오류 } : {}),
    ...(unknown.length ? { 알수없는_종류: unknown, 사용가능한_종류: AUX_KINDS } : {}),
    데이터범위:
      "철거멸실은 재건축·재개발의 선행지표로 쓸 수 있습니다(멸실 이후 신축 인허가가 따라옵니다). " +
      `기간(since·until)은 데이터 생성일 기준이며 데이터 지연은 ${ARCHHUB_DATA_LAG}입니다.`,
  };
}
