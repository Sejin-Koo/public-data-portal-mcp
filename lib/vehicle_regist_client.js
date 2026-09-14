// public-data-portal-mcp / lib/vehicle_regist_client.js
//
// 한국교통안전공단 「자동차종합정보 신규등록정보 서비스」(data.go.kr 15059401)를 감싼다.
// 신차(신규등록) 통계를 등록월·차종·지역·연료·용도·성별·연령대·배기량·국산수입 축으로 조회한다.
//
// ★★ 이 API의 성격 — 분포표를 주지 않고 "건수 하나"를 준다 ★★
// 응답 본문은 <dtaCo>(자료건수) 단일 필드다. 조건을 걸면 그 조건에 해당하는 신규등록
// 건수 1개만 돌아온다. 따라서 "연료별 분포"를 만들려면 연료코드 값 수만큼 호출해야 하고,
// 그 루프를 이 모듈이 대신 돈다. 호출 폭증을 막기 위해 호출 예산(MAX_UPSTREAM_CALLS)을
// 두고, 초과하면 조회를 시작하지 않고 어떻게 줄이라는 안내와 함께 거절한다.
//
// ★★ 서비스 경로 철자 함정 — "Info"가 아니라 소문자 L로 시작하는 "lnfo"다 ★★
// 배포된 경로는 newRegist**l**nfoService_02 / getnewRegist**l**nfoService02 이고,
// 기술문서(v1.1)에 적힌 newRegistInfoService(대문자 I)로 부르면
// NO_OPENAPI_SERVICE_ERROR(코드 12)가 난다. 포털 화면에서는 대문자 I와 소문자 l이 같은
// 모양으로 보여 눈으로 구분되지 않는다. 제공기관 등록 시의 오타가 그대로 운영 중인 것으로
// 보이며, 2026-09-14 두 철자를 같은 파라미터로 나란히 호출해 확인했다.
// **아래 상수를 "고쳐 쓰지 말 것."** 기관이 나중에 바로잡으면 그때 함께 고친다.
//
// 실측 근거(2026-09-14, 2025년 1월분):
//   전체 124,494 / 차종 4개 합 124,494 / 연료 11개 합 124,494 / 용도 3개 합 124,494 /
//   성별 3개 합 124,494 / 국산수입 2개 합 124,494 / 지역 17개 합 124,494 /
//   배기량 11개 합 124,494 / 연령대는 문서상 0~8만으로는 124,444(50건 부족) → 9(90대)까지
//   있어야 124,494가 된다.

import { qs, rawFetch, SERVICE_KEY, SERVICE_KEY_SOURCE } from "./pdp_client.js";

// ★ 철자 주의: lnfo(소문자 L). 위 주석 참조.
const BASE =
  "https://apis.data.go.kr/B553881/newRegistlnfoService_02/getnewRegistlnfoService02";

// 수록 시작 시점. 2014-12를 부르면 1건이 나오지만 이는 잔여 레코드이고, 실질 시계열은
// 2015-01부터다(2015-01 = 178,766건). 그 이전 조회는 호출만 낭비되므로 막는다.
export const DATA_START_YM = "201501";

// 당월분은 익월 2일부터 조회 가능(제공기관 공지). 그 전에 부르면 0건이 오는데, 이는
// "신규등록이 없었다"가 아니라 "아직 반영 전"이다 — 응답에 그 구분을 실어 보낸다.
const PUBLISH_LAG_NOTE = "당월 1일~말일 자료는 익월 2일부터 조회 가능합니다.";

// 일일 트래픽은 상세기능(오퍼레이션) 단위 3,000회다(개발계정 기준, 포털 활용신청 화면).
// 한도는 계정 단위 공유 자원이라 이 서버가 전체를 통제할 수는 없고, 자기 몫만 절제하고
// 응답에 호출 수를 실어 알린다. 한 번 호출에서 쓸 수 있는 상한을 보수적으로 둔다.
const MAX_UPSTREAM_CALLS = 240;
const CONCURRENCY = 6;
const TIMEOUT_MS = 20000;
const RETRY = 2;

// ---------------------------------------------------------------------------
// 코드표 (기술문서 v1.1 + 2026-09-14 실측 보정)
// ---------------------------------------------------------------------------

const VEHICLE_TYPE = { 1: "승용", 2: "승합", 3: "화물", 4: "특수" };

const REGION = {
  1: "서울", 2: "부산", 3: "대구", 4: "인천", 5: "광주", 6: "대전",
  7: "울산", 8: "세종", 9: "경기", 10: "강원", 11: "충북", 12: "충남",
  13: "전북", 14: "전남", 15: "경북", 16: "경남", 17: "제주",
};

// ★ 휘발유가 세 코드로 나뉘어 있다(8 휘발유 / 9 휘발유(무연) / 10 휘발유(유연)).
//   실측에서 9가 가장 크고 10은 0이었다. "휘발유 합계"가 필요하면 8·9·10을 더해야 한다.
//   하이브리드도 6(CNG+전기)과 7(휘발유+전기)로 나뉜다.
const FUEL = {
  1: "CNG", 2: "경유", 3: "수소", 4: "엘피지", 5: "전기",
  6: "하이브리드(CNG+전기)", 7: "하이브리드(휘발유+전기)",
  8: "휘발유", 9: "휘발유(무연)", 10: "휘발유(유연)", 11: "기타연료",
};

const USAGE = { 1: "자가용", 2: "영업용", 3: "관용" };

const GENDER = { 남자: "남자", 여자: "여자", 법인: "법인" };

// ★ 기술문서는 0~8(법인·10대~80대)까지만 적고 있으나, 실측에서 9(90대)가 존재한다.
//   9를 빼면 합계가 전체와 맞지 않는다(2025-01에 50건 누락). 문서만 믿지 말 것.
const AGE_GROUP = {
  0: "법인", 1: "10대", 2: "20대", 3: "30대", 4: "40대", 5: "50대",
  6: "60대", 7: "70대", 8: "80대", 9: "90대",
};

const DISPLACEMENT = {
  1: "800cc미만", 2: "1000cc미만", 3: "1500cc미만", 4: "2000cc미만",
  5: "2500cc미만", 6: "3000cc미만", 7: "3500cc미만", 8: "4000cc미만",
  9: "4500cc미만", 10: "5000cc미만", 11: "5000cc이상",
};

const ORIGIN = { 국산: "국산", 외산: "외산" };

/** breakdown 축 이름 → { param, codes } */
const DIMENSIONS = {
  vehicleType: { param: "vhctyAsortCode", codes: VEHICLE_TYPE, label: "차종" },
  region: { param: "registGrcCode", codes: REGION, label: "등록지역" },
  fuel: { param: "useFuelCode", codes: FUEL, label: "사용연료" },
  usage: { param: "prposSeNm", codes: USAGE, label: "용도" },
  gender: { param: "sexdstn", codes: GENDER, label: "성별" },
  ageGroup: { param: "agrde", codes: AGE_GROUP, label: "연령대" },
  displacement: { param: "dsplvlCode", codes: DISPLACEMENT, label: "배기량" },
  origin: { param: "hmmdImpSeNm", codes: ORIGIN, label: "국산수입" },
};

export const BREAKDOWN_KEYS = ["none", ...Object.keys(DIMENSIONS)];

export const VEHICLE_CODE_TABLES = {
  차종: VEHICLE_TYPE,
  등록지역: REGION,
  사용연료: FUEL,
  용도: USAGE,
  성별: GENDER,
  연령대: AGE_GROUP,
  배기량: DISPLACEMENT,
  국산수입: ORIGIN,
};

// ---------------------------------------------------------------------------
// 단건 호출
// ---------------------------------------------------------------------------

/**
 * 조건 하나에 대한 신규등록 건수를 돌려준다.
 * NODATA_ERROR(resultCode 03)는 오류가 아니라 0건이므로 0으로 정규화한다.
 * (data.go.kr 계열 공통 함정 — 실패로 처리하면 "자료 없음"이 에러로 둔갑한다.)
 */
async function fetchCount(params) {
  const url = `${BASE}?${qs({ serviceKey: SERVICE_KEY, ...params })}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      const { status, text } = await rawFetch(url, {}, TIMEOUT_MS);
      if (status !== 200) throw new Error(`HTTP ${status}`);
      if (!text || !text.trim()) throw new Error("빈 응답 본문");

      if (/NO_OPENAPI_SERVICE_ERROR/.test(text)) {
        throw new Error(
          "NO_OPENAPI_SERVICE_ERROR — 서비스 경로가 틀렸습니다. " +
            "이 API의 경로는 'Info'가 아니라 소문자 L로 시작하는 'lnfo'입니다(기술문서 표기와 다름)."
        );
      }
      if (/SERVICE_KEY_IS_NOT_REGISTERED_ERROR/.test(text)) {
        throw new Error(
          "SERVICE_KEY_IS_NOT_REGISTERED_ERROR — 이 오퍼레이션에 대한 활용신청이 필요합니다."
        );
      }
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text)) {
        // 한도 초과는 재시도해도 소용없고 한도만 더 쓴다.
        return { count: null, error: "일일 요청한도 초과(LIMITED_NUMBER_OF_SERVICE_REQUESTS)" , fatal: true };
      }
      if (/NODATA_ERROR/.test(text)) return { count: 0 };

      const m = text.match(/<dtaCo>\s*(\d+)\s*<\/dtaCo>/);
      if (m) return { count: Number(m[1]) };
      if (/<dtaCo\s*\/>/.test(text)) return { count: 0 };

      throw new Error(`dtaCo를 찾지 못했습니다: ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  return { count: null, error: lastErr ? lastErr.message : "알 수 없는 오류" };
}

/** 동시 실행 수를 제한한 map */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// 기간 유틸
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
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(4));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 본 함수
// ---------------------------------------------------------------------------

/**
 * 신규등록(신차) 통계를 조회한다.
 *
 * @param {object} a
 * @param {string} a.from        조회 시작 YYYYMM
 * @param {string} [a.to]        조회 종료 YYYYMM (생략 시 from과 동일한 1개월)
 * @param {string} [a.breakdown] 분포 축. none이면 월별 합계만.
 * @param {object} [a.filters]   고정 조건(모든 호출에 함께 적용)
 */
export async function getNewVehicleRegistrations({
  from,
  to,
  breakdown = "none",
  filters = {},
} = {}) {
  if (!SERVICE_KEY) {
    return {
      오류: "공공데이터포털 인증키가 설정되지 않았습니다(DATA_PORTAL_KEY).",
      인증키출처: SERVICE_KEY_SOURCE,
    };
  }

  const fromYm = normalizeYm(from, "from");
  const toYm = to ? normalizeYm(to, "to") : fromYm;
  if (toYm < fromYm) throw new Error(`to(${toYm})가 from(${fromYm})보다 앞섭니다.`);
  if (fromYm < DATA_START_YM) {
    throw new Error(
      `이 서비스의 수록 시작은 ${DATA_START_YM}입니다(그 이전은 자료가 없습니다). from을 ${DATA_START_YM} 이후로 지정하세요.`
    );
  }
  if (!BREAKDOWN_KEYS.includes(breakdown)) {
    throw new Error(`breakdown은 ${BREAKDOWN_KEYS.join(", ")} 중 하나여야 합니다.`);
  }

  const months = ymRange(fromYm, toYm);
  const dim = breakdown === "none" ? null : DIMENSIONS[breakdown];
  const dimValues = dim ? Object.keys(dim.codes) : [];

  // 호출 예산 — 월수 × (분포값 수 + 합계 1)
  const planned = months.length * (dimValues.length + 1);
  if (planned > MAX_UPSTREAM_CALLS) {
    return {
      오류: `이 조회는 upstream 호출 ${planned}회가 필요해 한 번에 처리할 수 있는 상한(${MAX_UPSTREAM_CALLS}회)을 넘습니다.`,
      사유:
        "이 API는 조건 하나당 건수 하나만 돌려주므로, 분포 축의 값 수 × 개월 수만큼 호출이 필요합니다.",
      줄이는법: [
        `기간을 나눠 조회하세요(현재 ${months.length}개월).`,
        dim
          ? `분포 축 '${breakdown}'은 값이 ${dimValues.length}개입니다. 값이 적은 축(origin 2개, usage·gender 3개, vehicleType 4개)으로 바꾸거나 breakdown="none"으로 합계만 받으세요.`
          : "breakdown을 none으로 두면 월당 1회만 호출합니다.",
      ],
      일일한도: "이 오퍼레이션의 일일 트래픽은 3,000회이며 계정 단위로 공유됩니다.",
    };
  }

  // 고정 필터를 upstream 파라미터로 변환
  const fixed = {};
  const filterEcho = {};
  for (const [k, v] of Object.entries(filters || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "carNameCode") { fixed.cnmCode = String(v); filterEcho["차명코드"] = String(v); continue; }
    if (k === "modelYear") { fixed.prye = String(v); filterEcho["모델년도"] = String(v); continue; }
    const d = DIMENSIONS[k];
    if (!d) throw new Error(`알 수 없는 필터: ${k}`);
    if (k === breakdown) {
      throw new Error(`breakdown으로 지정한 축(${k})은 filters에 동시에 넣을 수 없습니다.`);
    }
    const key = String(v);
    if (!(key in d.codes)) {
      throw new Error(
        `필터 ${k}의 값 '${v}'이(가) 코드표에 없습니다. 사용 가능: ${Object.entries(d.codes).map(([c, n]) => `${c}=${n}`).join(", ")}`
      );
    }
    fixed[d.param] = key;
    filterEcho[d.label] = `${key}(${d.codes[key]})`;
  }

  // 호출 작업 목록 구성
  const jobs = [];
  for (const ym of months) {
    const base = { registYy: ym.slice(0, 4), registMt: ym.slice(4), ...fixed };
    jobs.push({ ym, kind: "total", params: base });
    for (const code of dimValues) {
      jobs.push({ ym, kind: "dim", code, params: { ...base, [dim.param]: code } });
    }
  }

  const results = await mapLimited(jobs, CONCURRENCY, async (j) => ({
    ...j,
    ...(await fetchCount(j.params)),
  }));

  const limitHit = results.some((r) => r.fatal);
  const errors = [];
  const byMonth = [];

  for (const ym of months) {
    const rows = results.filter((r) => r.ym === ym);
    const totalRow = rows.find((r) => r.kind === "total");
    const total = totalRow && totalRow.count !== null ? totalRow.count : null;
    if (totalRow && totalRow.error) errors.push({ 월: ym, 항목: "합계", 오류: totalRow.error });

    const entry = { 등록월: ym, 신규등록: total };

    if (dim) {
      const dist = {};
      let sum = 0;
      let anyNull = false;
      for (const code of dimValues) {
        const r = rows.find((x) => x.kind === "dim" && x.code === code);
        if (!r || r.count === null) {
          anyNull = true;
          if (r && r.error) errors.push({ 월: ym, 항목: `${dim.label} ${code}`, 오류: r.error });
          continue;
        }
        if (r.count > 0) {
          dist[`${code}:${dim.codes[code]}`] = r.count;
          sum += r.count;
        }
      }
      entry[`${dim.label}별`] = dist;
      entry.분포합 = sum;
      if (total !== null && !anyNull) {
        entry.합계검증 = sum === total ? "일치" : `불일치(합계 ${total} − 분포합 ${sum} = ${total - sum})`;
      } else {
        entry.합계검증 = "검증불가(일부 호출 실패)";
      }
    }

    byMonth.push(entry);
  }

  const out = {
    자료: "한국교통안전공단 자동차종합정보 신규등록정보 서비스(공공데이터포털 15059401)",
    의미: "해당 월에 신규등록된 자동차 대수입니다. 누적 등록대수(스톡)가 아니라 그 달의 신규 발생분(플로우)입니다.",
    조회기간: `${fromYm} ~ ${toYm}`,
    분포축: breakdown === "none" ? "없음(월별 합계만)" : `${DIMENSIONS[breakdown].label}(${breakdown})`,
    고정조건: Object.keys(filterEcho).length ? filterEcho : "없음",
    월별: byMonth,
    upstream호출수: jobs.length,
    유의사항: [PUBLISH_LAG_NOTE],
  };

  if (breakdown === "fuel") {
    out.유의사항.push(
      "휘발유는 8·9·10 세 코드로 나뉩니다(무연·유연 구분). '휘발유 합계'가 필요하면 셋을 더하세요. 하이브리드도 6(CNG+전기)·7(휘발유+전기)로 나뉩니다."
    );
  }
  if (breakdown === "ageGroup") {
    out.유의사항.push(
      "연령대 0은 법인입니다. 기술문서는 8(80대)까지만 적고 있으나 실제로는 9(90대)가 존재하며, 9를 빼면 합계가 맞지 않습니다."
    );
  }
  if (errors.length) {
    out.실패한호출 = errors.slice(0, 20);
    out.유의사항.push(
      "일부 호출이 실패했습니다. 실패한 항목의 0은 '자료 없음'이 아니라 '조회 실패'이므로 그대로 쓰지 마세요."
    );
  }
  if (limitHit) {
    out.유의사항.push(
      "일일 요청한도(3,000회/일, 계정 공유)를 초과했습니다. 재시도하지 말고 다음 날 다시 조회하세요."
    );
  }

  return out;
}
