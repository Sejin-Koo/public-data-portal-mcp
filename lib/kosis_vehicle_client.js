// public-data-portal-mcp / lib/kosis_vehicle_client.js
//
// KOSIS(국가통계포털) 국토교통부 「자동차등록대수현황 시도별」(orgId=116, tblId=DT_MLTM_5498)을
// 감싼다. **누적 등록대수(스톡)** 를 월별·시도별·시군구별로 조회한다.
//
// ★ 이 모듈과 vehicle_regist_client.js의 차이 — 스톡과 플로우다.
//   - 이 모듈        : 그 시점에 등록되어 있는 자동차의 총 대수(누적). 월말 기준.
//   - 신규등록 클라이언트: 그 달에 새로 등록된 대수(플로우).
//   신규등록을 아무리 더해도 말소(폐차·수출)가 빠지지 않아 누적이 되지 않는다.
//
// ★★ 연료 축은 이 통계표에 없다(2026-09-14 확인). 분류는 시도명 × 시군구 × 차종뿐이고
//   항목은 계/자가용/영업용/관용이다. **연료별(전기·수소·하이브리드) 누적은 KOSIS·국토교통
//   통계누리의 어느 통계표에도 없고**, 국토교통부 보도자료(1·7월 발표, 반기)와 e-나라지표
//   1257(연 1회)에만 실린다. "전기차 누적 몇 대"는 이 도구로 답할 수 없다.

import { qs, rawFetch } from "./pdp_client.js";

const BASE = "https://kosis.kr/openapi/Param/statisticsParameterData.do";
const META = "https://kosis.kr/openapi/statisticsData.do";

export const KOSIS_KEY = process.env.KOSIS_API_KEY || "";
export const KOSIS_KEY_SOURCE = KOSIS_KEY ? "KOSIS_API_KEY" : "미설정";

const ORG_ID = "116";
const TBL_ID = "DT_MLTM_5498";

// ---------------------------------------------------------------------------
// 코드표 (2026-09-14 실측)
//
// 재도출 방법: GET https://kosis.kr/openapi/statisticsData.do
//   ?method=getMeta&apiKey=<키>&orgId=116&tblId=DT_MLTM_5498&type=ITM&format=json&jsonVD=Y
// 이 한 번의 호출이 항목(T*)과 분류(A/B/C) 코드를 모두 돌려준다.
// ★ 같은 엔드포인트라도 /openapi/Param/statisticsParameterData.do 쪽은 getMeta에서
//   "필수요청변수값이 누락되었습니다"만 돌려준다 — 메타는 반드시 statisticsData.do로 부를 것.
// ---------------------------------------------------------------------------

const ITEMS = {
  계: "13103873443T4",
  자가용: "13103873443T2",
  영업용: "13103873443T3",
  관용: "13103873443T1",
};

const VEHICLE_TYPES = {
  승용: "13102873443C.0001",
  승합: "13102873443C.0002",
  화물: "13102873443C.0003",
  특수: "13102873443C.0004",
  총계: "13102873443C.0005",
};

// ★ 시도 코드는 18개가 정의돼 있으나 한 시점에 모두 나오지는 않는다.
//   광주(A.0006)와 전남(A.0015)이 **전남광주(A.0002)로 통합**되었고, 실측으로 확인한
//   전환 시점은 2026년 7월이다 — 2026-06까지는 광주·전남이 따로 17개 시도로 나오고,
//   2026-07부터는 전남광주로 합쳐져 16개가 된다(전국 합계는 양쪽 모두 정상).
//   그래서 통합 이후 월을 "광주"나 "전남"으로 조회하면 0건이 정상이고, 통합 이전 월을
//   "전남광주"로 조회해도 0건이 정상이다. 둘 다 자료 누락이 아니다.
//   ★ 시계열을 이 축으로 그릴 때는 광주+전남을 더해 전남광주와 이어 붙여야 선이 끊기지 않는다.
const SIDO = {
  서울: "13102873443A.0001",
  전남광주: "13102873443A.0002",
  부산: "13102873443A.0003",
  대구: "13102873443A.0004",
  인천: "13102873443A.0005",
  광주: "13102873443A.0006",
  대전: "13102873443A.0007",
  울산: "13102873443A.0008",
  세종: "13102873443A.0009",
  경기: "13102873443A.0010",
  강원: "13102873443A.0011",
  충북: "13102873443A.0012",
  충남: "13102873443A.0013",
  전북: "13102873443A.0014",
  전남: "13102873443A.0015",
  경북: "13102873443A.0016",
  경남: "13102873443A.0017",
  제주: "13102873443A.0018",
};

// 시군구 분류의 "계"(= 그 시도 전체 합계) 코드. 시도 단위 조회는 이 값을 고정해서 부른다.
const SIGUNGU_TOTAL = "13102873443B.0001";

export const KOSIS_VEHICLE_CODES = {
  항목: Object.keys(ITEMS),
  차종: Object.keys(VEHICLE_TYPES),
  시도: Object.keys(SIDO),
};

// ★ KOSIS는 요청 1건당 **40,000셀** 상한이 있고, 셀 수는 실제 반환 행이 아니라
//   분류의 **선언된 교차곱**으로 계산된다(희소한 조합도 전부 센다). 실측값:
//     시도 단위(시군구=계 고정)  : 18 × 1 × 5 × 4 = 360셀/월  → 약 111개월까지 한 번에
//     시군구 단위(시도 1개 고정) : 1 × 250 × 5 × 4 = 5,000셀/월 → 약 8개월까지 한 번에
//   초과하면 err 31("40,000셀을 초과한 결과값은 요청하실 수 없습니다")이 온다.
const CELL_LIMIT = 40000;
const CELLS_PER_MONTH_SIDO = 18 * 1 * 5 * 4;
const CELLS_PER_MONTH_SIGUNGU = 1 * 250 * 5 * 4;

const TIMEOUT_MS = 25000;
const RETRY = 2;

// ---------------------------------------------------------------------------

function normalizeYm(v, name) {
  const s = String(v ?? "").replace(/[^0-9]/g, "");
  if (s.length !== 6) throw new Error(`${name}은(는) YYYYMM 6자리여야 합니다(받은 값: ${v}).`);
  const mm = Number(s.slice(4));
  if (mm < 1 || mm > 12) throw new Error(`${name}의 월이 범위를 벗어났습니다(${s}).`);
  return s;
}

function ymRange(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(4));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function kosisGet(params) {
  const url = `${BASE}?${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      const { status, text } = await rawFetch(url, {}, TIMEOUT_MS);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (!text || !text.trim()) throw new Error("빈 응답 본문");
      const data = JSON.parse(text);
      if (!Array.isArray(data)) {
        // KOSIS 오류는 배열이 아니라 {err, errMsg} 객체로 온다.
        const code = data && data.err;
        const msg = (data && data.errMsg ? String(data.errMsg) : "").trim();
        if (code === "30") return []; // 데이터 없음 — 오류가 아니다
        throw new Error(`KOSIS err ${code}: ${msg}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------

/**
 * 자동차 누적 등록대수를 조회한다.
 *
 * @param {object} a
 * @param {string} a.from            조회 시작 YYYYMM
 * @param {string} [a.to]            조회 종료 YYYYMM (생략 시 from 한 달)
 * @param {string} [a.level]         "sido"(기본) | "sigungu"
 * @param {string} [a.region]        시도명. sigungu 단계에서는 필수
 * @param {string} [a.vehicleType]   승용|승합|화물|특수|총계
 * @param {string} [a.usage]         계|자가용|영업용|관용
 */
export async function getVehicleRegistrationStock({
  from,
  to,
  level = "sido",
  region,
  vehicleType,
  usage,
} = {}) {
  if (!KOSIS_KEY) {
    return {
      오류: "KOSIS 인증키가 설정되지 않았습니다(환경변수 KOSIS_API_KEY).",
      인증키출처: KOSIS_KEY_SOURCE,
    };
  }
  if (!["sido", "sigungu"].includes(level)) {
    throw new Error('level은 "sido" 또는 "sigungu"여야 합니다.');
  }

  const fromYm = normalizeYm(from, "from");
  const toYm = to ? normalizeYm(to, "to") : fromYm;
  if (toYm < fromYm) throw new Error(`to(${toYm})가 from(${fromYm})보다 앞섭니다.`);

  if (vehicleType && !(vehicleType in VEHICLE_TYPES)) {
    throw new Error(`vehicleType은 ${Object.keys(VEHICLE_TYPES).join(", ")} 중 하나여야 합니다.`);
  }
  if (usage && !(usage in ITEMS)) {
    throw new Error(`usage는 ${Object.keys(ITEMS).join(", ")} 중 하나여야 합니다.`);
  }
  if (region && !(region in SIDO)) {
    throw new Error(
      `region '${region}'을(를) 찾을 수 없습니다. 사용 가능: ${Object.keys(SIDO).join(", ")}`
    );
  }
  if (level === "sigungu" && !region) {
    throw new Error(
      "시군구 단위 조회는 region(시도명)을 반드시 지정해야 합니다 — 전국 시군구를 한 번에 받으면 KOSIS 셀 상한을 넘습니다."
    );
  }

  const months = ymRange(fromYm, toYm);
  const cellsPerMonth = level === "sido" ? CELLS_PER_MONTH_SIDO : CELLS_PER_MONTH_SIGUNGU;
  const monthsPerCall = Math.max(1, Math.floor(CELL_LIMIT / cellsPerMonth));
  const batches = chunk(months, monthsPerCall);

  const objL1 = level === "sigungu" ? SIDO[region] : "ALL";
  const objL2 = level === "sigungu" ? "ALL" : SIGUNGU_TOTAL;
  const objL3 = vehicleType ? VEHICLE_TYPES[vehicleType] : "ALL";
  const itmId = usage ? ITEMS[usage] : "ALL";

  const rows = [];
  const errors = [];
  for (const b of batches) {
    try {
      const part = await kosisGet({
        method: "getList",
        apiKey: KOSIS_KEY,
        orgId: ORG_ID,
        tblId: TBL_ID,
        format: "json",
        jsonVD: "Y",
        prdSe: "M",
        startPrdDe: b[0],
        endPrdDe: b[b.length - 1],
        objL1,
        objL2,
        objL3,
        itmId,
      });
      rows.push(...part);
    } catch (e) {
      errors.push({ 구간: `${b[0]}~${b[b.length - 1]}`, 오류: e.message });
    }
  }

  // 시도 단위에서 region이 지정되면 그 시도만 남긴다(호출은 ALL로 하고 여기서 거른다 —
  // 시도 하나만 요청해도 셀 수 이득이 없고, 전국 합계를 함께 내려면 전체가 필요하다).
  const keep = level === "sido" && region ? (r) => r.C1_NM === region : () => true;

  const byMonth = new Map();
  for (const r of rows) {
    if (!keep(r)) continue;
    const ym = r.PRD_DE;
    if (!byMonth.has(ym)) byMonth.set(ym, []);
    byMonth.get(ym).push({
      지역: level === "sigungu" ? `${r.C1_NM} ${r.C2_NM}` : r.C1_NM,
      차종: r.C3_NM,
      용도: r.ITM_NM,
      등록대수: r.DT === null || r.DT === undefined || r.DT === "" ? null : Number(r.DT),
    });
  }

  const 월별 = [];
  for (const ym of months) {
    const list = byMonth.get(ym) || [];
    const entry = { 기준월: ym, 건수: list.length, 값: list };
    // 전국 합계는 이 통계표에 별도 행이 없으므로 시도별 '총계 × 계'를 합산해 만든다.
    if (level === "sido" && !region) {
      const 전국 = list
        .filter((x) => x.차종 === "총계" && x.용도 === "계" && x.등록대수 !== null)
        .reduce((s, x) => s + x.등록대수, 0);
      if (전국 > 0) entry.전국합계_총계_계 = 전국;
    }
    월별.push(entry);
  }

  const out = {
    자료: "KOSIS 국토교통부 자동차등록대수현황 시도별 (orgId=116, tblId=DT_MLTM_5498)",
    의미: "해당 월말 기준으로 등록되어 있는 자동차의 **누적 대수**입니다(스톡). 그 달의 신규등록이 아닙니다.",
    조회기간: `${fromYm} ~ ${toYm}`,
    집계단위: level === "sigungu" ? `시군구(${region})` : region ? `시도(${region})` : "시도 전체",
    차종: vehicleType || "전체(승용·승합·화물·특수·총계)",
    용도: usage || "전체(계·자가용·영업용·관용)",
    upstream호출수: batches.length,
    월별,
    유의사항: [
      "이 통계표에는 **연료 축이 없습니다.** 전기차 누적 대수는 이 도구로 조회할 수 없고, 국토교통부 보도자료(1·7월 발표)나 e-나라지표 1257을 참조해야 합니다.",
      "광주·전남은 2026년 7월부터 **전남광주**로 통합되었습니다(2026-06까지 17개 시도, 2026-07부터 16개). 통합 이후 월을 '광주'·'전남'으로, 또는 통합 이전 월을 '전남광주'로 조회하면 0건이 나오는데 둘 다 자료 누락이 아닙니다. 이 축으로 시계열을 그릴 때는 광주+전남을 더해 전남광주와 이어 붙이세요.",
      "전국 합계 행은 원자료에 없어 시도별 '총계 × 계'를 합산해 만든 값입니다.",
    ],
  };
  if (errors.length) {
    out.실패한구간 = errors;
    out.유의사항.push(
      "일부 구간 조회가 실패했습니다. 그 구간이 비어 있는 것은 '자료 없음'이 아니라 '조회 실패'입니다."
    );
  }
  return out;
}

/** 코드표만 돌려준다(조회 없음). */
export function getKosisVehicleCodeTables() {
  return {
    통계표: `${ORG_ID} / ${TBL_ID} — 자동차등록대수현황 시도별`,
    분류: KOSIS_VEHICLE_CODES,
    메타재도출: `${META}?method=getMeta&apiKey=<키>&orgId=${ORG_ID}&tblId=${TBL_ID}&type=ITM&format=json&jsonVD=Y`,
    비고: "연료 축은 이 통계표에 없습니다. 광주·전남은 전남광주로 통합되었습니다.",
  };
}
