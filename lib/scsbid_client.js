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
//  · ★ **업종 필터(indstrytyNm·indstrytyCd)는 신뢰할 수 없다.** 실측(2026-08-31): 용역에
//    indstrytyNm="토목공사업"을 넣으니 2,728건이 1,979건으로 줄긴 했으나, 반환된 건이
//    청소년활동 연구·미디어아트 연출 용역이었다. 오류 없이 엉뚱하게 걸리므로 업종별 집계에
//    쓸 수 없다. 파라미터는 남겨 두되(원 API에 존재하므로) 쓰이면 응답에 경고를 싣는다.
//  · ★ **창을 잘게 쪼갠다고 더 많이 수집되지 않는다 — 늘어나는 것은 중복이다.** 실측
//    (2026-08-31, 용역·공고명 "유지관리"·2026-06): 30일 1창은 totalCount 188·고유 188건,
//    같은 구간을 7일 4창으로 나누면 totalCount 합 326인데 **고유키 합집합은 똑같이 188건**
//    이고, 한쪽에만 있는 건은 양방향 모두 0이었다. 즉 30일 조회는 아무것도 누락하지 않는다.
//    "30일이면 조용히 누락되니 15일로 쪼개야 한다"는 진단이 한 차례 보고된 적이 있으나
//    재현되지 않았다(그때의 0건은 일시적 연결 오류로 보인다). **분할 폭을 줄이지 말 것** —
//    호출 수만 배로 늘고 중복만 늘어난다.
//  · ★ **최근 구간은 구조적으로 과소집계다.** 낙찰정보는 개찰 후 낙찰자가 확정·등록되어야
//    조회된다. 실측(2026-06 개찰 188건)한 개찰→등록 지연은 중앙값 7.0일·75분위 14.1일·
//    90분위 22.9일·최대 46일이고, 7일 이내 등록은 50.5%였다. 이미 등록된 건만 관측되는
//    우측절단 표본이므로 실제 지연은 이보다 길다. 이 모듈은 조회 종료일이 30일 이내면
//    경고를 싣는다.
//  · ★ **조달청 시스템 테스트 공고가 실제 낙찰건과 섞여 있다.** 실측(2026-08-31):
//    2026-07-14 개찰 「[SHR]공사 PQ 테스트 공고(실적+배점제)」가 낙찰금액 989억원으로
//    잡혀 있고 낙찰업체는 "업체29", 수요기관은 "테스트&기관2"(ZY00480)였다. 2026년 공사
//    추정가격 300억 이상 낙찰 7건 중 1건이 이것이라 금액 합계를 크게 왜곡한다. 다만 공고명의
//    "테스트"만으로 거르면 안 된다 — 같은 기간 "테스트"가 든 공사 15건 중 14건이 스마트양식·
//    반도체 테스트베드 같은 정상 발주였다. looksLikeTestNotice()의 네 신호로 판정하고
//    **제거하지 않고 표시만** 한다.
//  · ★ **limit 절단은 잘림 플래그로 잡히지 않는다.** truncated(잘림)는 수집 자체가 예산·상한에
//    걸렸을 때만 true다. 수집은 다 됐는데 limit 때문에 반환만 잘린 경우는 false로 남으므로,
//    호출자가 수집건수와 반환건수를 대조하지 않으면 조용히 일부만 집계하게 된다. 정렬이
//    실개찰일시 내림차순이라 어느 건이 빠지는지 예측할 수도 없다. 실제 사고(2026-08-31):
//    공사 8개월치를 limit=300으로 불러 수집 317·반환 300이 됐고, 잘린 17건에 낙찰금액
//    300억 이상이 4건 들어 있어 56건이어야 할 집계가 52건으로 나왔다. 그래서 이 모듈은
//    rows.length > limit이면 유의사항에 경고를 싣는다.
//  · ★ **장기계속공사는 총계약금액이 아니라 차수분 금액이 기록된다.** 실측(2026-08-31):
//    「울산도시철도 1호선 건설공사」(한신공영, 2026-04-09 개찰)의 최종낙찰금액이 11.3억원으로
//    잡혀 있다 — 실제 사업은 수천억 규모다. 합계를 과소평가하는 데 그치지 않고, **금액 하한
//    필터를 걸면 대형 장기계속공사가 통째로 빠진다**(300억 이상으로 거르면 이 건은 11.3억이라
//    아예 안 잡힌다). 응답에 차수 여부를 알려주는 필드가 없어 서버가 판정할 수 없으므로,
//    금액 기준 집계·순위를 낼 때 호출자가 이 성질을 답변에 밝혀야 한다.

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

// 조회기간 상한. 실측상 원 API가 보는 것은 일수가 아니라 **캘린더 1개월**이다
// (31일 통과 / 61일 07 에러였으나, 6/30~7/31·2/27~3/30처럼 30일 이하인 달이 시작점이면
//  30일 남짓이어도 07이 난다). 창 분할은 splitWindows가 달력 월 경계로 처리하며,
// 이 상수는 도구 설명에 쓰는 근사값이다.
export const RANGE_LIMIT_DAYS = 31;

// 한 번의 도구 호출에서 허용할 최대 upstream 호출 수. Vercel maxDuration(60초) 안에
// 끝내기 위한 상한이며, 초과분은 truncated로 알린다.
const CALL_BUDGET = 24;

// 한 번의 도구 호출에서 모을 최대 행수. limit(반환 건수)과 무관하게 수집 자체의 상한이며,
// 여기에 걸리면 잘림=true로 알린다. limit에 연동시키면 limit을 작게 준 것만으로 뒤쪽
// 기간을 통째로 건너뛰면서도 결과는 정상처럼 보이는 사고가 난다(2026-08-31 스모크테스트에서
// 실제로 재현 — limit=3을 주자 두 번째 31일 창을 조회하지 않고 종료했다).
const MAX_ROWS = 1000;

// summaryOnly(집계 전용)일 때의 수집 상한. 개별 행을 반환하지 않아 응답 크기가 상수에
// 가깝기 때문에 더 많이 모을 수 있다. 실질 제약은 여전히 TIME_BUDGET_MS다.
const MAX_ROWS_SUMMARY = 6000;

// 수집에 쓸 수 있는 시간 상한(ms).
//
// ★ 이게 없으면 **최악의 실패 모드**가 난다. 용역은 공사보다 건수가 훨씬 많아(개찰예정일
//   하루치가 수천 건) 3개월 구간을 한 번에 부르면 Vercel 함수의 maxDuration을 넘겨 응답이
//   아예 없다 — 오류도, 빈 결과도, 경고도 없이 keepalive만 오다 끊긴다. 실제로 그 무응답을
//   "검색조건 필터가 고장났다"로 오진해, 전수로 뽑을 수 있었던 구간을 "부분 관측치"로
//   후퇴시킨 산출물이 나왔다(2026-08-31). 같은 조건도 1개월로 좁히면 18초에 정상 반환된다.
//   그래서 시간이 다하면 **거기까지 모은 결과에 잘림 표시를 붙여 반환**한다. 불완전한 답을
//   불완전하다고 말하며 주는 편이, 아무것도 주지 않아 원인을 오해하게 만드는 것보다 낫다.
//
//   값은 maxDuration 60초에서 역산했다 — 개별 호출 타임아웃이 15초이므로 예산을 소진한
//   직후 진행 중이던 호출이 끝나기를 기다리면 최대 35+15=50초다. 42초로 뒀다가 실측에서
//   46초가 나와(예산 소진 시점의 잔여 호출 때문) 35초로 낮췄다. 응답 직렬화 시간까지
//   감안한 값이므로 함부로 올리지 말 것.
const TIME_BUDGET_MS = 35000;

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

/**
 * 캘린더 개월 덧셈. 말일을 넘기면 대상 달의 말일로 클램프한다
 * (1/31 + 1개월 = 2/28, 자바스크립트 기본 정규화의 3/3이 아니다).
 */
function addMonths(d, n) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + n + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(y, m + n, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes())
  );
}

/**
 * 요청 구간을 원 API 상한 이하의 창으로 쪼갠다. 최신 구간부터 반환한다.
 *
 * ★ 상한은 "31일"이 아니라 **캘린더 1개월**이다. 31일 고정폭으로 자르면 30일
 *   이하인 달(2·4·6·9·11월)이 창의 시작점이 될 때 원 API가 07(입력범위값 초과)을
 *   낸다 — 실측(2026-09-01): 6/30~7/31, 2/27~3/30 두 창이 모두 07로 실패했고,
 *   그 구간이 통째로 빠진 채 잘림 표시 없이 반환됐다.
 *   달력 월 경계로 자르면 어느 달이든 "1일 ~ 말일"이 되어 항상 통과한다.
 *   (역방향 클램프는 대칭이 아니므로 addMonths로 되돌리는 방식은 쓰지 않는다:
 *    3/30 - 1개월 = 2/28 이지만 2/28 + 1개월 = 3/28 < 3/30 이라 여전히 초과다.)
 */
export function splitWindows(from, to) {
  const start = parseDt(from);
  const end = parseDt(to);
  if (end <= start) return [{ from: fmtDt(start), to: fmtDt(end) }];
  // 구간 전체가 1개월 이내면 굳이 쪼개지 않는다.
  if (addMonths(start, 1) >= end) return [{ from: fmtDt(start), to: fmtDt(end) }];

  const out = [];
  let cur = end;
  while (cur > start) {
    const monthStart = new Date(
      Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1, 0, 0)
    );
    const prev = monthStart > start ? monthStart : start;
    out.push({ from: fmtDt(prev), to: fmtDt(cur) });
    if (prev.getTime() <= start.getTime()) break;
    cur = new Date(prev.getTime() - 60 * 1000); // 전달 말일 23:59
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

/**
 * 조달청 시스템 테스트 공고를 판정한다.
 *
 * ★ 나라장터 낙찰정보에는 **조달청이 시스템 점검용으로 올린 공고가 실제 낙찰건과 섞여
 *   들어 있다.** 실측(2026-08-31): 2026-07-14 개찰 「[SHR]공사 PQ 테스트 공고(실적+배점제)」의
 *   낙찰금액이 989억원으로 잡혀 있고, 낙찰업체는 "업체29", 수요기관은 "테스트&기관2"
 *   (기관코드 ZY00480)였다. 2026년 1~8월 공사 중 추정가격 300억 이상 낙찰건 7건 가운데
 *   1건이 이것이어서, 걸러내지 않으면 **금액 합계가 989억원 부풀어 오른다.**
 *
 * ★ 공고명의 "테스트"만으로 거르면 안 된다 — 같은 기간 공고명에 "테스트"가 든 공사 15건 중
 *   14건이 스마트양식·반도체 테스트베드 같은 **정상 발주**였다. 그래서 판정은 공고명 단독이
 *   아니라 아래 세 신호로 한다. 서버는 **제거하지 않고 표시만** 한다 — 무엇을 모집단에 넣을지는
 *   질문에 달렸기 때문이다.
 */
function looksLikeTestNotice(row) {
  const winner = String(row.bidwinnrNm ?? "").replace(/\s/g, "");
  const inst = `${row.dminsttNm ?? ""} ${row.ntceInsttNm ?? ""}`;
  const name = String(row.bidNtceNm ?? "");
  const signals = [];
  if (/^업체\d+$/.test(winner)) signals.push("낙찰업체명이 '업체N' 형식");
  if (/테스트\s*[&＆]\s*기관/.test(inst)) signals.push("기관명이 테스트용 더미");
  if (/^\s*\[SHR\]/.test(name)) signals.push("공고명이 [SHR]로 시작");
  // 실측 건의 공고번호가 T25BK01255958이었다. 정상 공고는 R로 시작하므로(R+년2+단계2+순번8)
  // T 접두는 테스트 계열로 본다. 구 체계 번호(년4+월2+순번5)는 숫자로 시작해 영향받지 않는다.
  if (/^T\d{2}[A-Z]{2}\d+/.test(String(row.bidNtceNo ?? ""))) {
    signals.push("공고번호가 T로 시작(정상은 R)");
  }
  return signals;
}

function normalizeWinnerRow(row, bizTypeName) {
  const testSignals = looksLikeTestNotice(row);
  return {
    업무구분: bizTypeName,
    ...(testSignals.length ? { 테스트공고의심: testSignals } : {}),
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
 * 집계 전용 모드에서 쓰는 요약 계산.
 *
 * ★ 이 모드를 만든 이유 — 개별 행을 돌려주는 한 limit 절단을 경고로는 못 막는다.
 *   실측(2026-09-01): 같은 조건(용역·추정가격 10억↑)인데 10일 창 하나가 7월은
 *   194~263건, 3월은 478~519건이었다. 호출자가 창을 몇 개로 쪼개야 하는지 부르기
 *   전에는 알 수 없고, limit을 올리는 방향도 답이 아니다(행 자체가 무거워 158건을
 *   limit=300으로 부른 MCP 호출이 60초 타임아웃 났다). 행을 아예 반환하지 않으면
 *   limit도 응답 크기도 문제에서 빠진다.
 */
function summarize(rows, topN) {
  const amount = (r) => Number(r.최종낙찰금액) || 0;
  const total = rows.reduce((s, r) => s + amount(r), 0);

  const group = (keyFn, nameFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!k) continue;
      const cur = m.get(k) || { 이름: nameFn(r), 건수: 0, 낙찰금액: 0 };
      cur.건수++;
      cur.낙찰금액 += amount(r);
      m.set(k, cur);
    }
    return m;
  };

  const topOf = (m, keyLabel) =>
    [...m.entries()]
      .sort((a, b) => b[1].낙찰금액 - a[1].낙찰금액)
      .slice(0, topN)
      .map(([k, v], i) => ({
        순위: i + 1,
        [keyLabel]: k,
        업체명: v.이름,
        건수: v.건수,
        낙찰금액: v.낙찰금액,
        비중: total ? Math.round((v.낙찰금액 / total) * 1000) / 10 : 0,
      }));

  const byBizno = group((r) => String(r.사업자번호 ?? "").trim(), (r) => r.최종낙찰업체);
  const byInst = group((r) => String(r.수요기관 ?? "").trim(), (r) => r.수요기관);

  const byMonth = {};
  for (const r of rows) {
    const d = String(r.실개찰일시).replace(/[^0-9]/g, "");
    const k = d.length >= 6 ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : "(실개찰일시 없음)";
    byMonth[k] = byMonth[k] || { 건수: 0, 낙찰금액: 0 };
    byMonth[k].건수++;
    byMonth[k].낙찰금액 += amount(r);
  }

  const bands = [
    ["10억 미만", 0, 1e9],
    ["10~30억", 1e9, 3e9],
    ["30~100억", 3e9, 1e10],
    ["100~300억", 1e10, 3e10],
    ["300억 이상", 3e10, Infinity],
  ];
  const byBand = bands.map(([nm, lo, hi]) => {
    const sel = rows.filter((r) => amount(r) >= lo && amount(r) < hi);
    const sum = sel.reduce((s, r) => s + amount(r), 0);
    return { 구간: nm, 건수: sel.length, 낙찰금액: sum };
  });

  const testRows = rows.filter((r) => r.테스트공고의심);
  const rateVals = rows
    .map((r) => Number(r.최종낙찰률))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const q = (p) =>
    rateVals.length ? Math.round(rateVals[Math.floor((rateVals.length - 1) * p)] * 1000) / 1000 : null;

  return {
    건수: rows.length,
    낙찰금액합계: total,
    낙찰금액합계_억원: Math.round((total / 1e8) * 10) / 10,
    낙찰업체수: new Set(rows.map((r) => String(r.사업자번호 ?? "").trim()).filter(Boolean)).size,
    테스트공고_제외시: {
      건수: rows.length - testRows.length,
      낙찰금액합계: total - testRows.reduce((s, r) => s + amount(r), 0),
    },
    낙찰률: {
      결측: rows.length - rateVals.length,
      결측비율: rows.length
        ? Math.round(((rows.length - rateVals.length) / rows.length) * 1000) / 10
        : 0,
      중앙값: q(0.5),
      "1사분위": q(0.25),
      "3사분위": q(0.75),
    },
    업체상위: topOf(byBizno, "사업자번호"),
    수요기관상위: topOf(byInst, "수요기관").map(({ 업체명, ...rest }) => rest),
    실개찰월별: Object.fromEntries(Object.entries(byMonth).sort()),
    금액구간별: byBand,
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
  indstrytyCd,
  prtcptLmtRgnCd,
  presmptPrceBgn,
  presmptPrceEnd,
  bizno,
  companyName,
  limit = 50,
  rowsPerPage = 100,
  summaryOnly = false,
  topN = 10,
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
    indstrytyCd,
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

  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;
  let calls = 0;
  let truncated = false;
  let timeBudgetHit = false;
  // ★ 창 하나가 통째로 실패해도 예전에는 비고에 한 줄 남을 뿐 잘림=false였다.
  //   집계가 조용히 과소집계가 되므로 실패를 잘림으로 승격한다.
  const windowFailures = [];
  // 집계 전용이면 개별 행을 반환하지 않으므로 더 많이 모을 수 있다.
  const rowCap = summaryOnly ? MAX_ROWS_SUMMARY : MAX_ROWS;
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
      if (calls >= CALL_BUDGET || outOfTime()) {
        truncated = true;
        if (outOfTime()) timeBudgetHit = true;
        break;
      }
      let page = 1;
      while (true) {
        if (calls >= CALL_BUDGET || outOfTime()) {
          truncated = true;
          if (outOfTime()) timeBudgetHit = true;
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
          // nodata(해당 구간 0건)는 정상이다. 그 밖의 실패는 원 API 오류(07 등)든
          // 네트워크 오류(ERR)든 그 구간이 통째로 빠졌다는 뜻이므로 잘림으로 올린다.
          if (!r.nodata) {
            const label = `${t} ${w.from}~${w.to} (${page}페이지): ${r.code} ${
              r.msg ?? ""
            }`.trim();
            windowFailures.push(label);
            notes.push(label);
            truncated = true;
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
        if (rows.length >= rowCap) {
          truncated = true;
          break;
        }
        page++;
      }
      if (rows.length >= rowCap) {
        truncated = true;
        break;
      }
    }
    if (timeBudgetHit || rows.length >= rowCap) break;
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

  // 등록 시차 — 개찰이 끝나도 낙찰자가 등록되기까지 시간이 걸리므로, 조회 종료일이
  // 최근이면 그 구간은 구조적으로 과소집계다(파일 상단 주석 참조).
  const nowDay = nowKstStr().slice(0, 8);
  const daysSinceUntil = Math.floor(
    (parseDt(nowDay) - parseDt(untilDay)) / (24 * 60 * 60 * 1000)
  );

  // 조달청 시스템 테스트 공고 — 제거하지 않고 세어서 알린다(상단 주석 참조).
  const testRows = rows.filter((r) => r.테스트공고의심);
  const testAmount = testRows.reduce((s, r) => s + (Number(r.최종낙찰금액) || 0), 0);

  // 낙찰률 결측 — 협상에 의한 계약은 예정가격 대비 투찰률이 산출되지 않는다.
  const rateMissing = rows.filter((r) => !String(r.최종낙찰률).trim()).length;
  const rateRatio = rows.length ? Math.round((rateMissing / rows.length) * 1000) / 10 : 0;

  if (windowFailures.length) {
    caveats.push(
      `★ 조회 구간을 나눈 창 중 ${windowFailures.length}개가 **호출에 실패해 그 구간이 통째로 빠졌습니다** — 이 결과는 요청 기간 전체가 아닙니다. 실패 구간: ${windowFailures.join(
        " / "
      )}. 건수·합계·순위를 내지 말고, 실패한 구간만 따로(1개월 이내로) 다시 호출해 합치세요. resultCode 07은 조회기간 상한 초과, ERR은 네트워크·타임아웃입니다.`
    );
  }
  if (timeBudgetHit) {
    caveats.push(
      `★ 시간 상한(${Math.round(TIME_BUDGET_MS / 1000)}초)에 걸려 **일부 구간만 수집한 중간 결과**입니다. 업무구분 '용역'은 공사보다 건수가 훨씬 많아 3개월 이상을 한 번에 부르면 여기에 걸립니다 — **필터가 고장난 것이 아니라 기간이 길었던 것이므로, 월 단위로 나눠 여러 번 호출해 합치세요**(같은 조건도 1개월이면 정상 반환됩니다). 이 결과로 건수·합계·비율을 내지 마세요.`
    );
  } else if (truncated && !windowFailures.length) {
    // 창실패는 위에서 이미 원인을 밝혔다. 여기서 "호출 예산"이라고 다시 말하면
    // 원인을 잘못 짚게 만든다.
    caveats.push(
      "호출 예산 또는 수집 상한에 걸려 일부 구간만 수집했습니다 — 기간을 좁히거나 업무구분을 줄여 다시 조회하세요. 이 결과로 낙찰가율 평균 같은 통계를 내지 마세요."
    );
  }
  if (windows.length > 1) {
    notes.push(
      `조회구간을 달력 월 경계로 창 ${windows.length}개로 나눠 호출했고, 창 경계에서 중복된 ${dupSkipped}건을 제거했습니다.`
    );
  } else if (dupSkipped) {
    notes.push(`중복 ${dupSkipped}건을 제거했습니다.`);
  }
  if (dateType === "개찰일시" && outOfRange.length) {
    caveats.push(
      `기간 필터는 공고상 개찰(예정)일시로 걸립니다. 실개찰일시가 요청 구간(${sinceDay}~${untilDay}) 밖인 건이 ${outOfRange.length}건 섞여 있습니다 — 개찰이 연기된 건입니다. "그 달에 개찰된 건"으로 엄격히 집계하려면 각 행의 실개찰일시로 다시 거르세요.`
    );
  }
  if (!summaryOnly && rows.length > limit) {
    caveats.push(
      `★ 수집은 ${rows.length}건 됐으나 limit에 걸려 **${limit}건만 반환**했습니다(${rows.length - limit}건 잘림). 정렬은 금액순이 아니라 **실개찰일시 내림차순**이므로, 잘린 쪽에 금액 상위 건이 들어 있을 수 있습니다. 건수·합계·상위 목록을 낼 목적이라면 이 결과로 집계하지 말고, limit을 올리거나(상한 300) **기간을 나눠 여러 번 호출해 합치세요.** 잘림 필드는 수집 자체가 끊겼을 때만 true가 되므로 이 상황에서는 false입니다 — 반드시 수집건수와 반환건수를 대조하세요.`
    );
  }
  if (testRows.length) {
    caveats.push(
      `★ 조달청 **시스템 테스트 공고로 보이는 건이 ${testRows.length}건**(낙찰금액 합계 ${testAmount.toLocaleString()}원) 섞여 있습니다. 각 행의 테스트공고의심 필드에 판정 근거가 있습니다. 실제 발주가 아니므로 **건수·금액 합계를 낼 때는 제외**하고, 제외했다는 사실을 밝히세요. 서버가 자동으로 빼지 않는 이유는 무엇을 모집단에 넣을지가 질문에 달렸기 때문입니다.`
    );
  }
  if (rateMissing) {
    caveats.push(
      `최종낙찰률이 비어 있는 건이 ${rateMissing}건(${rateRatio}%)입니다. 누락이 아니라 계약방식 차이로, 협상에 의한 계약(종합평가)은 예정가격 대비 투찰률이 산출되지 않습니다. 결측을 빼고 평균·중앙값을 내면 적격심사 건에만 쏠린 편향값이 되므로, 결측률을 함께 밝히거나 산출하지 마세요.`
    );
  }
  if (!usesSearch) {
    notes.push(
      "검색조건 없이 기본형 오퍼레이션으로 조회했습니다(해당 기간 전체 낙찰건). 공고명·기관·사업자번호로 좁히려면 그 값을 함께 넘기세요."
    );
  }
  if (indstrytyNm || indstrytyCd) {
    caveats.push(
      "★ 업종 필터(indstrytyNm·indstrytyCd)는 신뢰할 수 없습니다. 실측(2026-08-31): 용역에 indstrytyNm='토목공사업'을 넣으니 2,728건이 1,979건으로 줄긴 했으나 청소년활동 연구·미디어아트 연출 같은 무관한 건이 그대로 반환됐습니다. 오류 없이 엉뚱하게 걸리므로 이 결과를 업종별 집계로 쓰지 마세요 — 공고명(bidNtceNm)으로 좁히는 편이 낫습니다."
    );
  }
  if (daysSinceUntil >= 0 && daysSinceUntil < 30) {
    caveats.push(
      `★ 조회 종료일(${untilDay})이 오늘로부터 ${daysSinceUntil}일 전이라 이 구간은 과소집계입니다. 낙찰정보는 개찰 후 낙찰자가 확정·등록되어야 조회되며, 실측(2026-06 개찰 188건)한 개찰→등록 지연은 중앙값 7.0일·75분위 14.1일·90분위 22.9일·최대 46일이었습니다(이미 등록된 건만 관측되는 우측절단 표본이라 실제 지연은 이보다 깁니다). 최근 한 달 건수를 확정치로 인용하지 말고 "현재까지 등록된 건 기준"임을 밝히세요.`
    );
  }

  // 집계 전용 모드 — 개별 행 대신 요약만 돌려준다.
  let summary = null;
  if (summaryOnly) {
    const n = Math.max(1, Math.min(50, Number(topN) || 10));
    const inRangeRows = rows.filter((r) => {
      const d = String(r.실개찰일시).replace(/[^0-9]/g, "").slice(0, 8);
      return d && d >= sinceDay && d <= untilDay;
    });
    summary = {
      설명:
        "전체는 요청 구간을 '공고상 개찰(예정)일시' 기준으로 수집한 전 행이고, " +
        "실개찰_구간내는 그중 실개찰일시가 요청 구간 안인 행만 다시 집계한 값입니다. " +
        "'그 기간에 개찰된 건'으로 답할 때는 실개찰_구간내를 쓰세요.",
      전체: summarize(rows, n),
      실개찰_구간내: summarize(inRangeRows, n),
    };
    caveats.push(
      "집계 전용 모드입니다 — 개별 행을 반환하지 않으므로 limit 절단이 발생하지 않습니다. " +
        "다만 수집 자체가 끊기는 경우(시간 상한·창 실패·수집 상한)는 그대로이므로 " +
        "**잘림이 true면 이 집계도 부분값입니다.** 개별 행 목록이 필요하면 summaryOnly 없이 " +
        "기간을 좁혀 다시 부르세요."
    );
    caveats.push(
      "★ **여러 번 나눠 부른 집계는 합치지 마세요.** 건수·금액 합계는 더할 수 있지만 " +
        "업체상위·수요기관상위는 각 호출의 상위 " +
        `${Math.max(1, Math.min(50, Number(topN) || 10))}개만 담겨 있어, 두 구간에 걸쳐 ` +
        "고르게 수주한 업체가 어느 쪽 상위에도 안 들면 통째로 빠집니다. 순위가 필요하면 " +
        "**잘림 없이 한 번에 담기는 기간**으로 좁혀 부르거나, summaryOnly 없이 개별 행을 " +
        "받아 직접 합산하세요."
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
    ...(summaryOnly ? { 집계전용: true } : {}),
    수집건수: rows.length,
    반환건수: summaryOnly ? 0 : Math.min(rows.length, limit),
    중복제거: dupSkipped,
    구간밖_실개찰: outOfRange.length,
    테스트공고의심: {
      건수: testRows.length,
      낙찰금액합계: testAmount,
      공고번호: testRows.map((r) => r.공고번호),
    },
    낙찰률결측: { 건수: rateMissing, 비율: rateRatio },
    업무구분별: perType,
    잘림: truncated,
    ...(timeBudgetHit
      ? { 잘림사유: "시간상한", 소요초: Math.round((Date.now() - startedAt) / 1000) }
      : windowFailures.length
      ? { 잘림사유: "창실패", 실패구간: windowFailures }
      : {}),
    ...(summaryOnly ? { 집계: summary } : {}),
    결과: summaryOnly ? [] : rows.slice(0, limit),
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
