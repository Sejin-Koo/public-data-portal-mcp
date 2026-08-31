// public-data-portal-mcp / lib/scsbid_client.js
//
// 조달청 「나라장터 낙찰정보서비스」(1230000/as/ScsbidInfoService, 서비스버전 1.5) 래퍼.
// 2026-08-31 추가. 오퍼레이션명·파라미터명은 조달청 OpenAPI 참고자료(v1.1, 2025-01-06
// 배포분)를 대조한 뒤 전부 실호출로 재확정한 값이다.
//
// ── 확정 사항 (2026-08-31 실호출 검증) ─────────────────────────────────────
//  · 조회기간 상한은 **약 1개월**이다. 31일은 통과하고 61일은 resultCode 07
//    "입력범위값 초과 에러"가 떨어진다. 입찰공고정보(scan_narajangteo_procurement)의
//    27일 상한과는 다른 값이므로 혼동하지 말 것. 이 모듈은 요청 구간을 31일 창으로
//    잘라 순차 호출하고, 호출 예산을 넘기면 truncated로 표시한다.
//  · inqryDiv(조회구분)의 의미가 **오퍼레이션 계열마다 다르다.** 이게 이 API에서 가장
//    조용히 틀리기 쉬운 지점이다.
//      - 기본형(getScsbidListSttus*, getOpengResultListInfo*) : 1=등록(입력)일시,
//        2=공고일시, 3=개찰일시, 4=입찰공고번호
//      - 검색형(…PPSSrch)                                     : 1=공고게시일시,
//        2=개찰일시, 3=입찰공고번호   ← 4가 없고 번호가 한 칸씩 당겨져 있다
//    그래서 이 모듈은 호출자에게 숫자가 아니라 dateType("개찰일시"/"공고일시"/"등록일시")
//    을 받고, 실제로 쓰는 오퍼레이션에 맞춰 숫자를 만든다.
//  · 검색조건(공고명·기관명·업종·지역·추정가격·사업자번호)을 쓰려면 반드시 …PPSSrch
//    계열을 써야 한다. 기본형에 이 파라미터들을 넣으면 **에러 없이 조용히 무시**된다.
//    검색형에는 "등록일시" 조회가 없으므로, 등록일시 + 검색조건 조합은 불가능하다.
//  · …PPSSrch에는 **bizno(사업자등록번호) 파라미터가 있다.** 특정 업체의 공공 수주이력을
//    바로 뽑을 수 있는 경로이며, 이 서비스에서 가장 활용도가 높다.
//  · 과거 데이터가 남아 있다(2023년 조회 정상). 다만 차세대 나라장터 개통 전후로
//    공고번호 체계가 다르다 — 구: 년(4)+월(2)+순번(5), 신: R+년(2)+단계(2)+순번(8) 13자리.
//  · 개찰순위별 투찰내역(전 참가업체의 투찰금액·투찰률)은 낙찰목록이 아니라
//    getOpengResultListInfoOpengCompt에만 있다. 이 오퍼레이션은 기간 조회가 없고
//    **입찰공고번호가 필수**다.
//  · 목록조회의 opengCorpInfo는 "업체명^사업자번호^대표자^투찰금액^투찰률"을 캐럿으로
//    이어붙인 한 칸짜리 문자열이다. 협상에 의한 계약처럼 낙찰예정자가 여럿이면 업체명
//    자리에 "낙찰예정자 다수"가 들어가고 1순위 금액만 보인다.
//  · resultCode 03(NODATA)은 오류가 아니라 "그 조건에 자료 없음"이다.
//  · ★ **기간 필터는 공고상 개찰(예정)일시로 걸리고, 응답의 rlOpengDt(실개찰일시)는 그보다
//    뒤로 밀릴 수 있다.** 개찰이 연기되면 **같은 건이 인접한 두 구간 조회에 모두 잡힌다.**
//    실측(2026-08-31, 용역·공고명 "정보시스템"): 7월 조회 70건 중 11건의 실개찰일시가 8월이고,
//    그 11건은 8월 조회 22건에도 그대로 들어 있었다. 31일 창으로 나눠 호출하는 이 모듈은
//    **창 경계에서 같은 건을 두 번 담게 되므로 중복제거가 필수다**(공고번호+차수+분류번호+
//    재입찰번호 키). 중복제거 없이 3개월을 조회하면 건수와 합계금액이 조용히 부풀어 오른다.
//  · ★ **최종낙찰률(sucsfbidRate)은 결측이 많다.** 협상에 의한 계약(종합평가)은 예정가격
//    대비 투찰률이 아예 산출되지 않는다. 실측 같은 표본에서 70건 중 48건(69%)이 공란이었다.
//    결측을 빼고 평균을 내면 적격심사 건에만 쏠린 편향값이 되므로, 이 모듈은 결측 건수와
//    비율을 응답에 실어 보낸다.

import {
  SERVICE_KEY,
  qs,
  rawFetch,
  parseResponse,
  getResultCode,
  getItems,
  getTotalCount,
  nowKstStr,
} from "./pdp_client.js";
import { resolveBizNo } from "./bizno_resolver.js";

const BASE = "https://apis.data.go.kr/1230000/as/ScsbidInfoService";

// 조회기간 상한(일). 31일 통과 / 61일 초과 에러를 실측해 31로 둔다.
export const RANGE_LIMIT_DAYS = 31;

// 한 번의 도구 호출에서 허용할 최대 upstream 호출 수. Vercel maxDuration(60초) 안에
// 끝내기 위한 상한이며, 초과분은 truncated로 알린다.
const CALL_BUDGET = 24;

// 한 번의 도구 호출에서 모을 최대 행수. limit(반환 건수)과 무관하게 수집 자체의 상한이며,
// 여기에 걸리면 잘림=true로 알린다. limit에 연동시키면 limit을 작게 준 것만으로 뒤쪽
// 기간을 통째로 건너뛰면서도 결과는 정상처럼 보이는 사고가 난다(2026-08-31 스모크테스트에서
// 실제로 재현 — limit=3을 주자 두 번째 31일 창을 조회하지 않고 종료했다).
const MAX_ROWS = 1000;

const NODATA_CODES = new Set(["03", "3"]);

export const BIZ_TYPES = {
  물품: "Thng",
  공사: "Cnstwk",
  용역: "Servc",
  외자: "Frgcpt",
};

export const BIZ_TYPE_NAMES = Object.keys(BIZ_TYPES);

// dateType → inqryDiv. 계열마다 다르므로 표를 나눠 둔다(파일 상단 주석 참조).
const INQRY_DIV = {
  base: { 등록일시: "1", 공고일시: "2", 개찰일시: "3", 공고번호: "4" },
  search: { 공고일시: "1", 개찰일시: "2", 공고번호: "3" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function resultMsg(parsed) {
  return (
    parsed?.response?.header?.resultMsg ??
    parsed?.["nkoneps.com.response.ResponseError"]?.header?.resultMsg ??
    parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg
  );
}

function readCode(parsed) {
  const err = parsed?.["nkoneps.com.response.ResponseError"]?.header?.resultCode;
  if (err !== undefined) return String(err).padStart(2, "0");
  const c = getResultCode(parsed);
  return c === undefined ? undefined : String(c).padStart(2, "0");
}

/** 단일 오퍼레이션 호출. { ok, items, totalCount, code, msg } 반환. */
async function callOp(op, params, { retries = 1 } = {}) {
  const url = `${BASE}/${op}?${qs({
    ServiceKey: SERVICE_KEY,
    type: "json",
    ...params,
  })}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, text } = await rawFetch(url, {}, 15000);
      if (status !== 200) {
        lastErr = `HTTP ${status}`;
        await sleep(400);
        continue;
      }
      const { data } = parseResponse(text);
      const code = readCode(data);
      const msg = resultMsg(data);
      if (code !== undefined && code !== "00") {
        return {
          ok: false,
          nodata: NODATA_CODES.has(code),
          items: [],
          totalCount: 0,
          code,
          msg,
        };
      }
      return {
        ok: true,
        items: getItems(data),
        totalCount: getTotalCount(data) ?? 0,
        code: code ?? "00",
        msg,
      };
    } catch (e) {
      lastErr = e.message;
      await sleep(400);
    }
  }
  return { ok: false, items: [], totalCount: 0, code: "ERR", msg: lastErr };
}

// ---------------------------------------------------------------------------
// 기간 유틸 — YYYYMMDDHHMM 문자열
// ---------------------------------------------------------------------------

function parseDt(s) {
  const t = String(s).replace(/[^0-9]/g, "");
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6) || "1") - 1;
  const d = Number(t.slice(6, 8) || "1");
  const h = Number(t.slice(8, 10) || "0");
  const mi = Number(t.slice(10, 12) || "0");
  return new Date(Date.UTC(y, mo, d, h, mi));
}

function fmtDt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(
    d.getUTCHours()
  )}${p(d.getUTCMinutes())}`;
}

/** 요청 구간을 상한(31일) 이하 창으로 쪼갠다. 최신 구간부터 반환한다. */
export function splitWindows(from, to) {
  const start = parseDt(from);
  const end = parseDt(to);
  const span = RANGE_LIMIT_DAYS * 24 * 60 * 60 * 1000 - 60 * 1000;
  const out = [];
  let cur = end;
  while (cur > start) {
    const prev = new Date(Math.max(start.getTime(), cur.getTime() - span));
    out.push({ from: fmtDt(prev), to: fmtDt(cur) });
    cur = new Date(prev.getTime() - 60 * 1000);
  }
  if (out.length === 0) out.push({ from: fmtDt(start), to: fmtDt(end) });
  return out;
}

// ---------------------------------------------------------------------------
// 1) 최종낙찰자 조회 — getScsbidListSttus* / …PPSSrch
// ---------------------------------------------------------------------------

const SEARCH_ONLY_KEYS = [
  "bidNtceNm",
  "ntceInsttNm",
  "ntceInsttCd",
  "dminsttNm",
  "dminsttCd",
  "indstrytyNm",
  "indstrytyCd",
  "prtcptLmtRgnCd",
  "prtcptLmtRgnNm",
  "presmptPrceBgn",
  "presmptPrceEnd",
  "bizno",
  "refNo",
  "intrntnlDivCd",
];

/**
 * 낙찰건 식별 키. 같은 공고라도 차수·분류번호·재입찰번호가 다르면 별개 건이므로 넷을 모두 쓴다.
 * 업무구분은 키에 넣지 않는다 — 한 건이 두 업무구분에 동시에 잡히는 일은 없고, 넣으면
 * 오히려 중복이 살아남는다.
 */
function winnerKey(row) {
  return [row.bidNtceNo, row.bidNtceOrd, row.bidClsfcNo, row.rbidNo]
    .map((v) => String(v ?? ""))
    .join("|");
}

function normalizeWinnerRow(row, bizTypeName) {
  return {
    업무구분: bizTypeName,
    공고번호: row.bidNtceNo ?? "",
    공고차수: row.bidNtceOrd ?? "",
    분류번호: row.bidClsfcNo ?? "",
    재입찰번호: row.rbidNo ?? "",
    공고명: row.bidNtceNm ?? "",
    참가업체수: row.prtcptCnum ?? "",
    최종낙찰업체: row.bidwinnrNm ?? "",
    사업자번호: row.bidwinnrBizno ?? "",
    대표자: row.bidwinnrCeoNm ?? "",
    주소: row.bidwinnrAdrs ?? "",
    전화번호: row.bidwinnrTelNo ?? "",
    최종낙찰금액: row.sucsfbidAmt ?? "",
    최종낙찰률: row.sucsfbidRate ?? "",
    실개찰일시: row.rlOpengDt ?? "",
    수요기관코드: row.dminsttCd ?? "",
    수요기관: row.dminsttNm ?? "",
    등록일시: row.rgstDt ?? "",
    // 외자 오퍼레이션만 응답 필드가 대문자 F로 시작한다(문서·실응답 모두 확인).
    최종낙찰일자: row.fnlSucsfDate ?? row.FnlSucsfDate ?? "",
    낙찰업체담당자: row.fnlSucsfCorpOfcl ?? "",
  };
}

/**
 * 기간·조건으로 최종낙찰자 목록을 조회한다.
 * 업무구분(물품/공사/용역/외자)을 여러 개 지정하면 각각 호출해 합친다.
 */
export async function searchScsbidWinners({
  bizTypes,
  dateType = "개찰일시",
  from,
  to,
  bidNtceNo,
  bidNtceNm,
  ntceInsttNm,
  dminsttNm,
  indstrytyNm,
  prtcptLmtRgnCd,
  presmptPrceBgn,
  presmptPrceEnd,
  bizno,
  companyName,
  limit = 50,
  rowsPerPage = 100,
} = {}) {
  if (!SERVICE_KEY) {
    return { error: "DATA_PORTAL_KEY 환경변수가 설정되어 있지 않습니다." };
  }

  const types = (Array.isArray(bizTypes) && bizTypes.length ? bizTypes : BIZ_TYPE_NAMES).filter(
    (t) => BIZ_TYPES[t]
  );
  if (types.length === 0) {
    return { error: `업무구분은 ${BIZ_TYPE_NAMES.join("/")} 중에서 고르세요.` };
  }

  // 회사명 → 사업자등록번호 해석. bizno를 직접 주면 해석은 건너뛴다.
  // ★ 다른 도구들은 해석 실패 시 "업체명 부분검색"으로 폴백하지만, 이 API에는 업체명
  //   파라미터가 아예 없어 그 폴백이 구조적으로 불가능하다. 그래서 실패하면 조회를 멈추고
  //   다음 수단(웹에서 사업자등록번호 확인)을 안내한다. DART 인덱스에 없는 비상장사는
  //   실제로 웹에서 번호를 확인해 조회에 성공한 사례가 있다(2026-08-31).
  let resolution = null;
  let effectiveBizno = bizno;
  if (!effectiveBizno && companyName) {
    const r = await resolveBizNo(companyName);
    resolution = {
      입력회사명: companyName,
      해석성공: r.ok,
      사업자번호: r.bizNo ?? null,
      매칭법인명: r.matchedCorpName ?? null,
      resolvedVia: r.resolvedVia ?? null,
      사유: r.reason ?? null,
    };
    if (!r.ok) {
      return {
        error: `회사명 "${companyName}"의 사업자등록번호를 찾지 못했습니다.`,
        해석: resolution,
        다음수단: [
          "이 API에는 업체명 검색 파라미터가 없어 이름만으로는 조회할 수 없습니다(부분검색 폴백 불가).",
          "웹에서 그 회사의 사업자등록번호 10자리를 확인한 뒤 bizno로 다시 조회하세요 — DART 미등록 비상장사도 이 경로로 조회에 성공합니다.",
          "또는 그 회사가 낙찰받은 공고를 하나 알고 있다면 bidNtceNo나 bidNtceNm으로 먼저 조회해 결과 행의 사업자번호를 확보하세요.",
        ],
      };
    }
    effectiveBizno = r.bizNo;
  }

  const searchFilters = {
    bidNtceNm,
    ntceInsttNm,
    dminsttNm,
    indstrytyNm,
    prtcptLmtRgnCd,
    presmptPrceBgn,
    presmptPrceEnd,
    bizno: effectiveBizno,
  };
  const usesSearch = SEARCH_ONLY_KEYS.some((k) => {
    const v = searchFilters[k];
    return v !== undefined && v !== null && v !== "";
  });

  const notes = [];
  const caveats = [
    "최종낙찰금액은 원화(원)이고, 최종낙찰률은 예정가격 대비 낙찰금액 비율(%)입니다.",
    "개찰이 끝난 건만 담깁니다 — 협상·적격심사가 진행 중이면 낙찰자가 아직 비어 있을 수 있습니다.",
  ];

  // 공고번호 단건 조회
  if (bidNtceNo) {
    const rows = [];
    const seenOne = new Set();
    for (const t of types) {
      const op = usesSearch
        ? `getScsbidListSttus${BIZ_TYPES[t]}PPSSrch`
        : `getScsbidListSttus${BIZ_TYPES[t]}`;
      const div = usesSearch ? INQRY_DIV.search.공고번호 : INQRY_DIV.base.공고번호;
      const r = await callOp(op, {
        inqryDiv: div,
        bidNtceNo,
        pageNo: 1,
        numOfRows: rowsPerPage,
      });
      if (r.ok) {
        for (const item of asArray(r.items)) {
          const key = winnerKey(item);
          if (seenOne.has(key)) continue;
          seenOne.add(key);
          rows.push(normalizeWinnerRow(item, t));
        }
      } else if (!r.nodata && r.code !== "ERR") {
        notes.push(`${t}: ${r.code} ${r.msg ?? ""}`.trim());
      }
    }
    return {
      조회기준: "입찰공고번호",
      공고번호: bidNtceNo,
      ...(resolution ? { 해석: resolution } : {}),
      건수: rows.length,
      결과: rows.slice(0, limit),
      비고: notes,
      유의사항: caveats,
    };
  }

  const divTable = usesSearch ? INQRY_DIV.search : INQRY_DIV.base;
  if (!divTable[dateType]) {
    return {
      error: usesSearch
        ? `검색조건(공고명·기관명·업종·지역·추정가격·사업자번호)을 함께 쓰면 dateType은 "개찰일시" 또는 "공고일시"만 됩니다. 검색형 오퍼레이션에는 등록일시 조회가 없습니다.`
        : `dateType은 ${Object.keys(divTable).join("/")} 중 하나여야 합니다.`,
    };
  }

  const until = to || nowKstStr();
  const since = from || fmtDt(new Date(parseDt(until).getTime() - 30 * 24 * 60 * 60 * 1000));
  const windows = splitWindows(since, until);

  let calls = 0;
  let truncated = false;
  const rows = [];
  const seen = new Set();
  let dupSkipped = 0;
  const perType = {};

  for (const t of types) {
    const op = usesSearch
      ? `getScsbidListSttus${BIZ_TYPES[t]}PPSSrch`
      : `getScsbidListSttus${BIZ_TYPES[t]}`;
    perType[t] = { 수집: 0, 원API_전체건수: 0 };
    for (const w of windows) {
      if (calls >= CALL_BUDGET) {
        truncated = true;
        break;
      }
      let page = 1;
      while (true) {
        if (calls >= CALL_BUDGET) {
          truncated = true;
          break;
        }
        calls++;
        const r = await callOp(op, {
          inqryDiv: divTable[dateType],
          inqryBgnDt: w.from,
          inqryEndDt: w.to,
          pageNo: page,
          numOfRows: rowsPerPage,
          ...(usesSearch ? searchFilters : {}),
        });
        if (!r.ok) {
          if (!r.nodata && r.code !== "ERR") {
            notes.push(`${t} ${w.from}~${w.to}: ${r.code} ${r.msg ?? ""}`.trim());
          }
          break;
        }
        if (page === 1) perType[t].원API_전체건수 += r.totalCount || 0;
        const raw = asArray(r.items);
        // ★ 창 경계 중복제거. 개찰 연기 건은 인접한 두 창에 모두 잡히므로, 여기서 걸러내지
        //   않으면 건수·합계금액이 부풀어 오른다(파일 상단 주석 참조).
        for (const item of raw) {
          const key = winnerKey(item);
          if (seen.has(key)) {
            dupSkipped++;
            continue;
          }
          seen.add(key);
          rows.push(normalizeWinnerRow(item, t));
          perType[t].수집++;
        }
        if (raw.length < rowsPerPage) break;
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        page++;
      }
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
    }
  }

  // 최신 개찰순 정렬
  rows.sort((a, b) => String(b.실개찰일시).localeCompare(String(a.실개찰일시)));

  // 기간 기준이 개찰일시일 때, 실개찰일시가 요청 구간 밖인 건을 센다.
  // (기간 필터는 공고상 개찰예정일시로 걸리고 실개찰은 연기될 수 있다 — 상단 주석 참조)
  const sinceDay = String(since).slice(0, 8);
  const untilDay = String(until).slice(0, 8);
  const outOfRange = rows.filter((r) => {
    const d = String(r.실개찰일시).replace(/[^0-9]/g, "").slice(0, 8);
    return d && (d < sinceDay || d > untilDay);
  });

  // 낙찰률 결측 — 협상에 의한 계약은 예정가격 대비 투찰률이 산출되지 않는다.
  const rateMissing = rows.filter((r) => !String(r.최종낙찰률).trim()).length;
  const rateRatio = rows.length ? Math.round((rateMissing / rows.length) * 1000) / 10 : 0;

  if (truncated) {
    caveats.push(
      "호출 예산 상한에 걸려 일부 구간만 수집했습니다 — 기간을 좁히거나 업무구분을 줄여 다시 조회하세요. 이 결과로 낙찰가율 평균 같은 통계를 내지 마세요."
    );
  }
  if (windows.length > 1) {
    notes.push(
      `조회구간을 ${RANGE_LIMIT_DAYS}일 창 ${windows.length}개로 나눠 호출했고, 창 경계에서 중복된 ${dupSkipped}건을 제거했습니다.`
    );
  } else if (dupSkipped) {
    notes.push(`중복 ${dupSkipped}건을 제거했습니다.`);
  }
  if (dateType === "개찰일시" && outOfRange.length) {
    caveats.push(
      `기간 필터는 공고상 개찰(예정)일시로 걸립니다. 실개찰일시가 요청 구간(${sinceDay}~${untilDay}) 밖인 건이 ${outOfRange.length}건 섞여 있습니다 — 개찰이 연기된 건입니다. "그 달에 개찰된 건"으로 엄격히 집계하려면 각 행의 실개찰일시로 다시 거르세요.`
    );
  }
  if (rateMissing) {
    caveats.push(
      `최종낙찰률이 비어 있는 건이 ${rateMissing}건(${rateRatio}%)입니다. 누락이 아니라 계약방식 차이로, 협상에 의한 계약(종합평가)은 예정가격 대비 투찰률이 산출되지 않습니다. 결측을 빼고 평균·중앙값을 내면 적격심사 건에만 쏠린 편향값이 되므로, 결측률을 함께 밝히거나 산출하지 마세요.`
    );
  }
  if (!usesSearch) {
    notes.push(
      "검색조건 없이 기본형 오퍼레이션으로 조회했습니다(해당 기간 전체 낙찰건). 공고명·기관·업종·사업자번호로 좁히려면 그 값을 함께 넘기세요."
    );
  }

  return {
    조회기준: dateType,
    조회기간: { 시작: since, 종료: until },
    사용오퍼레이션: usesSearch ? "검색형(PPSSrch)" : "기본형",
    업무구분: types,
    검색조건: usesSearch
      ? Object.fromEntries(Object.entries(searchFilters).filter(([, v]) => v))
      : {},
    ...(resolution ? { 해석: resolution } : {}),
    수집건수: rows.length,
    반환건수: Math.min(rows.length, limit),
    중복제거: dupSkipped,
    구간밖_실개찰: outOfRange.length,
    낙찰률결측: { 건수: rateMissing, 비율: rateRatio },
    업무구분별: perType,
    잘림: truncated,
    결과: rows.slice(0, limit),
    비고: notes,
    유의사항: caveats,
  };
}

// ---------------------------------------------------------------------------
// 2) 개찰결과 조회 — 공고 1건의 전 참가업체 개찰순위·투찰금액
// ---------------------------------------------------------------------------

function normalizeBidderRow(row) {
  return {
    개찰구분: row.opengRsltDivNm ?? "",
    개찰순위: row.opengRank ?? "",
    업체명: row.prcbdrNm ?? "",
    사업자번호: row.prcbdrBizno ?? "",
    대표자: row.prcbdrCeoNm ?? "",
    투찰금액: row.bidprcAmt ?? "",
    투찰률: row.bidprcrt ?? "",
    비고: row.rmrk ?? "",
    투찰일시: row.bidprcDt ?? "",
    추첨번호: [row.drwtNo1, row.drwtNo2]
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .join(","),
    입찰가격평가점수: row.bidPrceEvlVal ?? "",
    기술평가점수: row.techEvlVal ?? "",
    종합평가금액: row.totalEvlAmtVal ?? "",
    공종별입찰금액URL: row.cnsttyAccotBidAmtUrl ?? "",
  };
}

function parseOpengCorpInfo(s) {
  if (!s) return null;
  const p = String(s).split("^");
  if (p.length < 2) return { 원문: String(s) };
  return {
    업체명: p[0] ?? "",
    사업자번호: p[1] ?? "",
    대표자: p[2] ?? "",
    투찰금액: p[3] ?? "",
    투찰률: p[4] ?? "",
  };
}

/**
 * 입찰공고번호 하나의 개찰결과를 모아서 돌려준다.
 *  - 개찰개요(진행구분·참가업체수·수요기관): getOpengResultListInfo{업무구분}
 *  - 순위별 투찰내역: getOpengResultListInfoOpengCompt
 *  - 유찰사유 / 재입찰사유: getOpengResultListInfoFailing / …Rebid
 */
export async function getOpengResult({
  bidNtceNo,
  bizType,
  bidNtceOrd,
  bidClsfcNo,
  rbidNo,
  limit = 100,
} = {}) {
  if (!SERVICE_KEY) {
    return { error: "DATA_PORTAL_KEY 환경변수가 설정되어 있지 않습니다." };
  }
  if (!bidNtceNo) {
    return { error: "bidNtceNo(입찰공고번호)는 필수입니다. 예: R26BK01686208" };
  }

  const notes = [];

  // (1) 개찰개요 — 업무구분을 모르면 4종을 차례로 두드린다.
  const probeTypes =
    bizType && BIZ_TYPES[bizType] ? [bizType] : ["용역", "물품", "공사", "외자"];
  let overview = null;
  let matchedType = null;
  for (const t of probeTypes) {
    const r = await callOp(`getOpengResultListInfo${BIZ_TYPES[t]}`, {
      inqryDiv: INQRY_DIV.base.공고번호,
      bidNtceNo,
      pageNo: 1,
      numOfRows: 10,
    });
    if (r.ok && asArray(r.items).length) {
      const row = asArray(r.items)[0];
      matchedType = t;
      overview = {
        업무구분: t,
        공고번호: row.bidNtceNo ?? bidNtceNo,
        공고차수: row.bidNtceOrd ?? "",
        공고명: row.bidNtceNm ?? "",
        개찰일시: row.opengDt ?? "",
        참가업체수: row.prtcptCnum ?? "",
        진행구분: row.progrsDivCdNm ?? "",
        개찰업체정보: parseOpengCorpInfo(row.opengCorpInfo),
        예비가격파일: row.rsrvtnPrceFileExistnceYn ?? "",
        공고기관: row.ntceInsttNm ?? "",
        수요기관: row.dminsttNm ?? "",
        개찰결과공지: row.opengRsltNtcCntnts ?? "",
      };
      break;
    }
  }
  if (!overview) {
    notes.push(
      "개찰결과 목록에서 이 공고번호를 찾지 못했습니다(업무구분 4종 모두 0건). 번호를 확인하거나, 아직 개찰 전인지 확인하세요."
    );
  }

  // (2) 순위별 투찰내역
  const bidders = [];
  let page = 1;
  while (page <= 5) {
    const r = await callOp("getOpengResultListInfoOpengCompt", {
      bidNtceNo,
      ...(bidNtceOrd ? { bidNtceOrd } : {}),
      ...(bidClsfcNo ? { bidClsfcNo } : {}),
      ...(rbidNo ? { rbidNo } : {}),
      pageNo: page,
      numOfRows: 100,
    });
    if (!r.ok) {
      if (!r.nodata && r.code !== "ERR") notes.push(`개찰완료: ${r.code} ${r.msg ?? ""}`.trim());
      break;
    }
    const batch = asArray(r.items).map(normalizeBidderRow);
    bidders.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  bidders.sort((a, b) => Number(a.개찰순위 || 9999) - Number(b.개찰순위 || 9999));

  // (3) 유찰·재입찰 사유 — 개찰완료 건이 아니면 여기서 사유가 나온다.
  const failing = await callOp("getOpengResultListInfoFailing", {
    bidNtceNo,
    pageNo: 1,
    numOfRows: 20,
  });
  const rebid = await callOp("getOpengResultListInfoRebid", {
    bidNtceNo,
    pageNo: 1,
    numOfRows: 20,
  });

  const 유찰 = failing.ok
    ? asArray(failing.items).map((r) => ({
        공고차수: r.bidNtceOrd ?? "",
        재입찰번호: r.rbidNo ?? "",
        유찰사유: r.nobidRsn ?? "",
      }))
    : [];
  const 재입찰 = rebid.ok
    ? asArray(rebid.items).map((r) => ({
        공고차수: r.bidNtceOrd ?? "",
        재입찰번호: r.rbidNo ?? "",
        입찰마감일시: r.bidClseDt ?? "",
        개찰일시: r.opengDt ?? "",
        재입찰사유: r.rbidRsn ?? "",
      }))
    : [];

  return {
    공고번호: bidNtceNo,
    업무구분: matchedType,
    개찰개요: overview,
    참가업체수: bidders.length,
    순위별투찰내역: bidders.slice(0, limit),
    유찰,
    재입찰,
    비고: notes,
    유의사항: [
      "투찰금액은 원화(원), 투찰률은 예정가격 대비 비율(%)입니다.",
      "순위별 투찰내역은 개찰이 완료된 건에만 있습니다 — 유찰·재입찰 건은 사유만 나옵니다.",
      "협상에 의한 계약처럼 낙찰예정자가 여럿이면 개찰업체정보에 '낙찰예정자 다수'로 표시되고 1순위 금액만 보입니다.",
    ],
  };
}
