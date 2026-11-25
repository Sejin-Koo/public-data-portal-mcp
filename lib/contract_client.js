// lib/contract_client.js
// ────────────────────────────────────────────────────────────────────────────
// 조달청 나라장터 **계약정보서비스**(공공데이터포털 15129427, CntrctInfoService)의 나라장터 검색조건
// 오퍼레이션(…PPSSrch)으로 계약 건을 조회하고, 업체목록(corpList)을 **실제 계약 업체·공동도급 방식·
// 지분율**로 풀어 돌려준다.
//
// ★ 왜 필요한가: 낙찰정보·개찰결과에는 대표사만 나오고, 입찰공고의 공동수급 칸은 공고가 **허용한**
//   방식일 뿐이다. 실제로 컨소시엄을 꾸렸는지·구성원·지분은 계약정보에만 있다(2026-11-25 —
//   "낙찰금액은 컨소시엄 전체 금액"이라는 근거 없는 단정이 두 번 관측된 뒤 추가).
//
// ★ 원 API 조회기간은 2026-11-10부터 1개월 → 7일로 줄었다(조달청 활용가이드 v1.0 개정 이력).
//   기간 조회는 날짜 차 6일 이하 창으로 나눠 부른다(pdp_client.splitByDateSpan과 같은 규칙).
//
// 업체목록 형식(활용가이드): [순번^업체구분^공동도급방식구분^업체명^대표자명^국적명^지분율^채권자명^
//   담당자성명^사업자등록번호],[…]
// 수요기관목록 형식: [순번^수요기관코드^수요기관명^소관구분^담당부서명^담당자성명^담당자전화번호]

import {
  SERVICE_KEY,
  qs,
  rawFetch,
  parseResponse,
  getResultCode,
  getItems,
  getTotalCount,
  splitByDateSpan,
} from "./pdp_client.js";
import { queryCntrctCache } from "./cntrct_cache.js";

const BASE = "https://apis.data.go.kr/1230000/ao/CntrctInfoService";
const OPS = {
  용역: "getCntrctInfoListServcPPSSrch",
  공사: "getCntrctInfoListCnstwkPPSSrch",
  물품: "getCntrctInfoListThngPPSSrch",
  외자: "getCntrctInfoListFrgcptPPSSrch",
};
// 원 API 페이지 상한 실측 999(2000을 주면 에러 없이 10행으로 되돌아감, 2026-11-25). 999행 한 쪽은 약 1.8MB.
const PAGE_ROWS = 999;
const MAX_PAGES = 10;

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return null;
};
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(String(v).replace(/,/g, "")));

/** "[a^b^c],[d^e^f]" → [[a,b,c],[d,e,f]] */
function splitBracketList(s) {
  if (!s) return [];
  const str = String(s).trim();
  if (!str) return [];
  return str
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(/\]\s*,\s*\[/)
    .map((x) => x.split("^").map((f) => f.trim()));
}

export function parseCorpList(s) {
  return splitBracketList(s).map((f) => {
    const last = f[f.length - 1] || "";
    const bizno = /^\d{10}$/.test(last.replace(/-/g, "")) ? last.replace(/-/g, "") : null;
    return {
      순번: f[0] || null,
      업체구분: f[1] || null, // 주계약업체·공동수급업체 등
      공동도급방식: f[2] || null, // 단독·공동이행·분담이행 등
      업체명: f[3] || null,
      대표자: f[4] || null,
      국적: f[5] || null,
      지분율: num(f[6]),
      사업자번호: bizno,
    };
  });
}

export function parseDminsttList(s) {
  return splitBracketList(s).map((f) => ({ 수요기관코드: f[1] || null, 수요기관명: f[2] || null, 소관구분: f[3] || null }));
}

export function mapContract(it, bizType) {
  const corps = parseCorpList(pick(it, "corpList"));
  const shareSum = corps.reduce((s, c) => s + (c.지분율 || 0), 0);
  const methods = [...new Set(corps.map((c) => c.공동도급방식).filter(Boolean))];
  return {
    업무구분: pick(it, "bsnsDivNm") || bizType,
    통합계약번호: pick(it, "untyCntrctNo"),
    확정계약번호: pick(it, "dcsnCntrctNo"),
    계약참조번호: pick(it, "cntrctRefNo"),
    계약명: pick(it, "cntrctNm"),
    공고번호: pick(it, "ntceNo"),
    공동계약여부: pick(it, "cmmnCntrctYn"),
    장기계속구분: pick(it, "lngtrmCtnuDivNm"),
    계약체결일자: pick(it, "cntrctCnclsDate"),
    계약기간: pick(it, "cntrctPrd"),
    총계약금액: num(pick(it, "totCntrctAmt")),
    금차계약금액: num(pick(it, "thtmCntrctAmt")),
    계약방법: pick(it, "cntrctCnclsMthdNm", "cntrctMthdNm"),
    계약기관: pick(it, "cntrctInsttNm"),
    수요기관: parseDminsttList(pick(it, "dminsttList")),
    업체: corps,
    업체수: corps.length,
    공동도급방식: methods.length ? methods.join(", ") : null,
    지분율합계: corps.length ? Math.round(shareSum * 1000) / 1000 : null,
    계약상세URL: pick(it, "cntrctDtlInfoUrl", "cntrctInfoUrl"),
  };
}

async function callPage(op, params, pageNo) {
  const url = `${BASE}/${op}?${qs({ ServiceKey: SERVICE_KEY, type: "json", numOfRows: PAGE_ROWS, pageNo, ...params })}`;
  const { status, text } = await rawFetch(url, {}, 15000);
  if (status === 429) return { ok: false, code: "RATELIMIT", msg: "HTTP 429 — 이 오퍼레이션의 일일 요청한도가 소진되었습니다." };
  if (status !== 200) return { ok: false, code: `HTTP${status}`, msg: `HTTP ${status}` };
  const { data, format, error } = parseResponse(text);
  if (format === "error") return { ok: false, code: "PARSE", msg: `응답 해석 실패: ${error} — ${String(text).slice(0, 200)}` };
  const code = getResultCode(data);
  const c = code === undefined ? undefined : String(code).padStart(2, "0");
  if (c === "03") return { ok: true, items: [], totalCount: 0 };
  if (c !== undefined && c !== "00") {
    const msg = data?.response?.header?.resultMsg ?? data?.["nkoneps.com.response.ResponseError"]?.header?.resultMsg ?? "";
    return { ok: false, code: c, msg: `resultCode=${c} ${msg}`.trim() };
  }
  return { ok: true, items: getItems(data), totalCount: getTotalCount(data) ?? 0 };
}

/** 한 오퍼레이션·한 조건을 페이지를 이어 받는다. */
async function fetchAll(op, params, errors, truncations, label) {
  const out = [];
  const first = await callPage(op, params, 1);
  if (!first.ok) {
    errors.push({ 조회: label, 코드: first.code, 오류: first.msg });
    return out;
  }
  out.push(...first.items);
  const total = first.totalCount || out.length;
  const pages = Math.min(Math.ceil(total / PAGE_ROWS), MAX_PAGES);
  for (let p = 2; p <= pages; p++) {
    const r = await callPage(op, params, p);
    if (!r.ok) {
      errors.push({ 조회: `${label} ${p}쪽`, 코드: r.code, 오류: r.msg });
      break;
    }
    out.push(...r.items);
    if (!r.items.length) break;
  }
  if (out.length < total) truncations.push({ 조회: label, 받은건수: out.length, 전체건수: total });
  return out;
}

/** ["20261101","20261102","20261105"] → ["20261101~20261102","20261105"] */
function dayRanges(days) {
  const out = [];
  const next = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + 1)).toISOString().slice(0, 10).replace(/-/g, "");
  let a = null, b = null;
  for (const d of days) {
    if (a && next(b) === d) { b = d; continue; }
    if (a) out.push(a === b ? a : `${a}~${b}`);
    a = b = d;
  }
  if (a) out.push(a === b ? a : `${a}~${b}`);
  return out;
}

const normName = (s) => String(s || "").replace(/\s+/g, "").replace(/\(주\)|㈜|주식회사/g, "").toLowerCase();

export async function getNarajangteoContracts({
  bidNtceNo,
  dcsnCntrctNo,
  bizType,
  from,
  to,
  cntrctNm,
  insttNm,
  bizno,
  companyName,
  limit = 50,
} = {}) {
  if (!SERVICE_KEY) return { ok: false, 오류: "DATA_PORTAL_KEY 환경변수가 설정되어 있지 않습니다." };
  if (!bidNtceNo && !dcsnCntrctNo && !from)
    return { ok: false, 오류: "bidNtceNo(입찰공고번호)·dcsnCntrctNo(확정계약번호)·from(계약체결일 시작) 중 하나는 주세요." };

  const errors = [];
  const truncations = [];
  const notes = [];
  const types = bizType && OPS[bizType] ? [bizType] : ["용역", "공사", "물품", "외자"];
  let rows = [];
  let mode;
  let cacheUsed = null;

  if (bidNtceNo || dcsnCntrctNo) {
    mode = bidNtceNo ? "공고번호" : "확정계약번호";
    const params = bidNtceNo ? { inqryDiv: 4, ntceNo: bidNtceNo } : { inqryDiv: 2, dcsnCntrctNo };
    // 업무구분을 모르면 차례로 두드리고 처음 나온 업무구분에서 멈춘다.
    for (const t of types) {
      const got = await fetchAll(OPS[t], params, errors, truncations, `${t} ${mode} ${bidNtceNo || dcsnCntrctNo}`);
      if (got.length) {
        rows = got.map((it) => mapContract(it, t));
        break;
      }
    }
  } else {
    mode = "계약체결일자";
    const f = String(from).replace(/[^0-9]/g, "").slice(0, 8);
    const tt = String(to || "").replace(/[^0-9]/g, "").slice(0, 8) || f;
    if (f.length !== 8 || tt.length !== 8) return { ok: false, 오류: "from·to는 YYYYMMDD 형식으로 주세요." };
    if (tt < f) return { ok: false, 오류: "to가 from보다 앞입니다." };
    // 업체 조건이 있으면 공동계약 수집본에서 먼저 찾는다(원 API에는 업체 조건이 없어 하루 7천 건을 받아 걸러야 함).
    let wins = null;
    if (bizno || companyName) {
      const q = queryCntrctCache({ from: f, to: tt, types });
      if (q && q.covered.length) {
        cacheUsed = { 수집본_기준시각: q.builtAt, 수집본_보관시작: q.firstDay, 수집본_받은날수: q.covered.length, 조회기간_날수: q.covered.length + q.missing.length };
        rows.push(...q.rows.map((it) => mapContract(it, it._t)));
        // 수집본에 아직 없는 날: 2일 이하면 실시간으로 보충(하루 전 업무구분 약 10회 호출 — 함수 시간 한도 60초 안), 그보다 많으면 범위를 알린다.
        if (q.missing.length && q.missing.length <= 2) {
          wins = q.missing.map((d) => ({ since: `${d}0000`, until: `${d}2359` }));
          cacheUsed.실시간보충일 = q.missing;
        } else {
          wins = [];
          if (q.missing.length) cacheUsed.미확인구간 = dayRanges(q.missing);
        }
      }
    }
    if (!wins) {
      wins = splitByDateSpan(`${f}0000`, `${tt}2359`, 6);
      if (wins.length > 6)
        return { ok: false, 오류: `기간이 너무 깁니다(6일 창 ${wins.length}개). 원 API 상한이 7일이라 한 번에 최대 약 6주까지만 조회합니다. 업체(bizno·companyName)를 주면 공동계약 수집본에서 긴 기간을 찾고, 아니면 공고번호로 조회하거나 기간을 나누세요.` };
    }
    const liveDeadline = Date.now() + 30000; // 수집본 보충은 함수 시간 한도(60초) 안에서만
    for (const t of types) {
      for (const w of wins) {
        if (cacheUsed && Date.now() > liveDeadline) {
          (cacheUsed.시간부족_미확인 ||= []).push(`${t} ${w.since.slice(0, 8)}`);
          continue;
        }
        const params = { inqryDiv: 1, inqryBgnDate: w.since.slice(0, 8), inqryEndDate: w.until.slice(0, 8) };
        if (cntrctNm) params.cntrctNm = cntrctNm;
        if (insttNm) params.insttNm = insttNm;
        const got = await fetchAll(OPS[t], params, errors, truncations, `${t} ${params.inqryBgnDate}~${params.inqryEndDate}`);
        const mapped = got.map((it) => mapContract(it, t));
        rows.push(...(cacheUsed ? mapped.filter((r) => r.공동계약여부 === "Y" || r.업체수 > 1) : mapped));
      }
    }
    if (cacheUsed) mode = "계약체결일자 — 공동계약 수집본";
    // 같은 계약이 창 경계에 걸려 두 번 오면 하나만 남긴다(통합계약번호+확정계약번호).
    const seen = new Set();
    rows = rows.filter((r) => {
      const k = `${r.통합계약번호}|${r.확정계약번호}|${r.금차계약금액}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 업체 필터(계약 업체 목록 안에서 — 대표사가 아니라 구성원으로 들어간 계약도 잡힌다)
  const bz = bizno ? String(bizno).replace(/[^0-9]/g, "") : "";
  const cn = companyName ? normName(companyName) : "";
  if (bz || cn) {
    const before = rows.length;
    rows = rows.filter((r) => r.업체.some((c) => (bz && c.사업자번호 === bz) || (cn && normName(c.업체명).includes(cn))));
    notes.push(`업체 조건으로 ${before}건 중 ${rows.length}건을 남겼습니다(대표사·구성원 어느 자리든 포함).`);
  }

  // ── 같은 계약의 중복 행 정리 ──
  // 실측(2026-11-25): 공고번호 하나에 ①확정계약번호·체결일이 빈 행(확정 전 등록분)과 ②같은 내용의 확정 행이
  // 함께 오고, 확정 행이 통합계약번호만 다르게 두 번 오기도 한다. 계약이 바뀌면 확정계약번호 끝 두 자리
  // (차수)가 올라간 행이 추가된다(국민건강보험공단 건: …3400 → …3401, 지분 50/20/30 → 48.1/23.1/28.8).
  const sig = (r) => `${r.금차계약금액}|${r.총계약금액}|${r.업체.map((c) => `${c.사업자번호 || c.업체명}:${c.지분율}`).join(",")}`;
  const finalSigs = new Set(rows.filter((r) => r.확정계약번호).map(sig));
  let mergedDrafts = 0;
  let mergedDup = 0;
  const seenFinal = new Set();
  rows = rows.filter((r) => {
    if (!r.확정계약번호) {
      if (finalSigs.has(sig(r))) { mergedDrafts++; return false; }
      return true;
    }
    const k = `${r.확정계약번호}|${sig(r)}`;
    if (seenFinal.has(k)) { mergedDup++; return false; }
    seenFinal.add(k);
    return true;
  });
  for (const r of rows) r.상태 = r.확정계약번호 ? "확정" : "확정 전(확정계약번호·계약체결일 미등록 — 내용이 바뀔 수 있음)";
  rows.sort((a, b) => String(b.확정계약번호 || "~").localeCompare(String(a.확정계약번호 || "~")) || String(b.계약체결일자 || "").localeCompare(String(a.계약체결일자 || "")));
  if (mergedDrafts || mergedDup)
    notes.push(`같은 계약의 중복 행을 정리했습니다(확정 전 등록분 ${mergedDrafts}건, 같은 확정 행 ${mergedDup}건).`);
  if (bidNtceNo || dcsnCntrctNo) {
    const refs = new Set(rows.map((r) => (r.확정계약번호 || r.계약참조번호 || "").slice(0, -2)).filter(Boolean));
    if (rows.filter((r) => r.확정계약번호).length > 1 && refs.size === 1)
      notes.push("같은 계약의 변경 차수가 여러 행입니다(확정계약번호 끝 두 자리가 차수). 맨 위 행이 최신 차수이며, 금액·지분이 바뀌었으면 최신 차수를 기준으로 쓰세요.");
  }

  const total = rows.length;
  const shown = rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 300)));

  const caution = [
    "업체 칸은 실제 계약 업체입니다: 업체구분(주계약업체·공동수급업체 등)·공동도급방식(단독·공동이행·분담이행 등)·지분율이 그대로 담깁니다. 낙찰정보의 낙찰업체 칸(대표사만)이나 입찰공고의 공동수급 칸(공고가 허용한 방식)과 다릅니다.",
    "지분율은 원자료 값 그대로입니다. 같은 조달청 자료 설명에 따르면 공사·기술용역은 업종별로 100%를 기준으로 하므로, 업종이 둘 이상인 계약은 지분율 합계가 100%를 넘을 수 있습니다(지분율합계 참고).",
    "장기계속계약은 금차계약금액이 이번 차수분이고 총계약금액이 전체 사업 금액입니다. 계약이 바뀌면 같은 통합계약번호로 차수가 늘어난 행이 함께 나올 수 있습니다.",
  ];
  if (cacheUsed) {
    caution.unshift(
      "공동계약 수집본에서 찾은 결과입니다: 업체 2곳 이상이 함께 맺은 계약(대표사·구성원 모두)만 들어 있고, 이 회사가 단독으로 맺은 계약은 없습니다. 단독 수주는 낙찰 수집본(scan_narajangteo_awards)이나 공고번호 조회로 보세요."
    );
    if (cacheUsed.시간부족_미확인)
      caution.unshift(`실시간 보충이 시간 한도에 걸려 일부를 확인하지 못했습니다(${cacheUsed.시간부족_미확인.join(", ")}). 업무구분(bizType)을 지정해 다시 부르면 보충됩니다.`);
    if (cacheUsed.미확인구간)
      caution.unshift(`수집본이 아직 받지 못한 날이 있습니다(${cacheUsed.미확인구간.join(", ")}). 이 구간의 계약은 결과에 없으니 '참여 없음'으로 읽지 마세요.`);
  }
  if (!total && (bidNtceNo || dcsnCntrctNo))
    caution.unshift(
      "이 번호로 등록된 계약이 없습니다. 낙찰 뒤 계약이 아직 체결·등록되지 않았거나(협상 계약은 낙찰 등록 뒤에도 수주일 걸림), 기관이 나라장터 밖에서 계약했을 수 있습니다. '컨소시엄 없음'이나 '계약 없음'으로 단정하지 마세요."
    );

  return {
    ok: true,
    출처: "조달청 나라장터 계약정보서비스(공공데이터포털 15129427)",
    조회: { 방식: mode, 공고번호: bidNtceNo || undefined, 확정계약번호: dcsnCntrctNo || undefined, 업무구분: types.join("·"), 기간: from ? `${from}~${to || from}` : undefined, 계약명: cntrctNm || undefined, 기관명: insttNm || undefined, 업체: bizno || companyName || undefined },
    ...(cacheUsed ? { 수집본: cacheUsed } : {}),
    건수: total,
    반환건수: shown.length,
    계약: shown,
    ...(errors.length ? { 부분실패: true, errors } : {}),
    ...(truncations.length ? { 잘림: true, 잘린조회: truncations } : { 잘림: false }),
    비고: notes.length ? notes : undefined,
    주의: caution,
  };
}
