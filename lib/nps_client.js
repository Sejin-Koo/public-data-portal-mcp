// public-data-portal-mcp / lib/nps_client.js
//
// 국민연금공단 「국민연금 가입 사업장 내역」(B552015/NpsBplcInfoInqireServiceV2) 래퍼.
// 2026-10-08 추가. 근로복지공단 도구(comwel_client.js)가 교차검증용으로 최근 몇 달만
// 부르던 것을, 사업장 선택·12개월 추이·신규취득/상실까지 다루는 독립 도구로 만든 것이다.
//
// ── 확정 사항 (2026-10-08 실호출 검증, 공공데이터포털 명세 3046071 대조) ──────────
//  · 오퍼레이션 3종: getBassInfoSearchV2(사업장 검색) / getDetailInfoSearchV2(상세) /
//    getPdAcctoSttusInfoSearchV2(기간별 현황 = 월별 취업자수·퇴직자수).
//    ★ 세 번째는 **Sttus**다. 매뉴얼(man-public-data 10절)에 적힌 `Sttu`로 부르면
//      NO_OPENAPI_SERVICE_ERROR(returnReasonCode 12)가 난다 — 매뉴얼 쪽이 틀렸다.
//  · ★ seq는 사업장 고유번호가 아니라 **자료생성년월(dataCrtYm)별 레코드 번호**다.
//    "포니링크" 검색 → 202509~202608 12행, seq 12개가 전부 다르다. 월별 추이를 내려면
//    seq마다 상세를 불러야 한다. 상세 응답에는 dataCrtYm이 없으므로 검색 행의 월을 붙인다.
//  · 기간별 현황도 seq 단위다. 그 seq의 달 값 하나(nwAcqzrCnt 신규취득, lssJnngpCnt 상실)를
//    준다. dataCrtYm을 다른 달로 주면 0건이다(실측 202608 seq + dataCrtYm=202607 → 0건).
//    ★ 신규취득−상실이 전월 대비 가입자수 증감과 **맞지 않는다**(실측: 포니링크 202512
//      취득 3·상실 44인데 가입자수는 142→124(−18), 이듬달 124→80(−44)). 같은 달로도,
//      한 달 밀어도 맞지 않는다. 원인은 확인되지 않았으므로 두 값을 나란히 내보내기만 한다.
//  · numOfRows 상한 **100**. 101 이상이면 resultCode 97 CLIENT_ERROR·0행(에러는 난다).
//  · 응답시간: 사업장명(wkplNm) 단독 검색은 **5~13초**(실측 포니링크 7.7~13.2초, 삼성전자
//    5.1초, 클루닉스 8.7~11.0초). 사업자번호 앞6자리(bzowrRgstNo)를 함께 주면 **0.3~0.8초**.
//    그래서 회사명이 들어오면 먼저 사업자등록번호를 해석해 앞6자리를 함께 건다.
//  · bzowrRgstNo 단독 검색도 된다(명세상 wkplNm이 필수로 표기돼 있으나 실제로는 아니다).
//    다만 앞 6자리는 세무서·업태 접두라 남의 회사가 대량으로 걸린다(실측 119813 → 2,228행).
//  · wkplNm은 부분일치다. "삼성전자" 단독 검색은 1,909행이고 첫 페이지 100행이 전부
//    "중원엔지니어링/일용/삼성전자 … 공사" 같은 남의 현장 사업장이다. 이름만으로는
//    회사를 특정할 수 없다 — 앞6자리를 함께 거는 것이 핵심이다.
//  · 상세 12건 + 기간별 12건을 한꺼번에 24병렬로 부르면 일부가 30초 넘게 응답하지 않는다
//    (실측 24건 중 2건). 동시 4건으로 제한하고, 호출당 8초 타임아웃 + 재시도로 흡수한다.
//  · 제공시점 기준 1년치만, 3인 이상 법인사업장 위주, 당월분은 15일 이후(10절).

import { normalizeCorpName, normalizeBizNo, lookupCorpCode, dartBizNo, kisconByName } from "./bizno_resolver.js";
import { callGw, mapLimit, failSummary } from "./gw_call.js";

const NPS = "https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2";

/**
 * 국민연금 wkplNm 검색어 정리.
 * 국민연금은 사업장명을 "주식회사 포니링크"처럼 띄어쓰기를 넣어 보관하는데, 근로복지공단은
 * "주식회사포니링크"로 붙여서 준다. 근로복지공단 결과의 사업장명을 그대로 국민연금에
 * 넣으면 0건이 나온다(실측: "주식회사포니링크" → totalCount 0, "포니링크" → 정상).
 * 그래서 법인격 표기를 떼어낸 핵심어로 조회한다.
 * (2026-10-08 comwel_client.js에서 이리로 옮김 — 국민연금 조회 로직은 이 파일 하나로 통일)
 */
export function npsSearchName(name) {
  if (!name) return "";
  const core = String(name)
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .trim();
  return core || String(name).trim();
}
const PAGE_ROWS = 100; // ★ 실측 상한(101부터 resultCode 97). 올리지 말 것.
const DETAIL_CONCURRENCY = 4;
const DETAIL_TIMEOUT = 8000; // 정상 응답 0.3~1.3초(실측). 걸린 호출은 일찍 끊고 재시도하는 편이 빠르다

const JNNG_ST = { 1: "등록", 2: "탈퇴" };
const STYL = { 1: "법인", 2: "개인" };

function ymLabel(ym) {
  const s = String(ym || "");
  return s.length === 6 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

/**
 * 회사명 → 사업자등록번호를 **로컬 색인과 DART 기업개황만으로** 빠르게 푼다.
 * resolveBizNo의 3단계(SWIT, Nimble 경유 실시간·과금)는 일부러 쓰지 않는다 — 여기서는
 * 해석이 실패해도 국민연금 사업장명 검색으로 폴백할 수 있으므로, 앞6자리는 "속도·정밀도를
 * 높이는 보조 수단"이지 필수가 아니기 때문이다.
 */
async function quickResolve(companyName) {
  const hit = lookupCorpCode(companyName);
  if (hit) {
    const d = await dartBizNo(hit.corpCode);
    if (d.ok) {
      return {
        ok: true,
        bizNo: d.bizNo,
        via: "companyName → DART 인덱스 → 기업개황(bizr_no)",
        matched: d.corpName || hit.corpName,
        indexGeneratedAt: hit.indexGeneratedAt,
      };
    }
    // DART에는 있는데 기업개황이 실패한 경우 — 키스콘으로 넘어가되 사실을 남긴다.
    const k = kisconByName(companyName);
    if (k.length === 1) {
      return { ok: true, bizNo: k[0].bizNo, via: "companyName → 키스콘 건설업체 색인(DART 기업개황 실패 후)", matched: k[0].상호, dartError: d.reason };
    }
    return { ok: false, reason: `DART 기업개황 조회 실패(${d.reason})` };
  }
  const k = kisconByName(companyName);
  if (k.length === 1) return { ok: true, bizNo: k[0].bizNo, via: "companyName → 키스콘 건설업체 색인", matched: k[0].상호 };
  if (k.length > 1) return { ok: false, reason: `같은 상호의 건설업 등록업체가 ${k.length}곳이라 하나로 좁히지 못했습니다` };
  return { ok: false, reason: "DART 인덱스·키스콘 색인에서 회사명을 찾지 못했습니다(미공시 비상장사일 수 있음 — 회사가 없다는 뜻이 아님)" };
}

/** 사업장 검색 — 첫 페이지에서 totalCount를 읽고 예산 안에서 이어 받는다. */
async function searchWorkplaces(params, maxPages, deadline) {
  const first = await callGw({ url: `${NPS}/getBassInfoSearchV2`, params: { ...params, dataType: "json", numOfRows: PAGE_ROWS, pageNo: 1 }, timeoutMs: 25000, deadline });
  let calls = 1;
  if (!first.ok) return { ok: false, fail: first, rows: [], total: 0, calls };
  const rows = [...first.items];
  const total = first.totalCount;
  const pages = Math.min(Math.ceil(total / PAGE_ROWS), maxPages);
  if (pages > 1) {
    const rest = await mapLimit(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      3,
      (p) => callGw({ url: `${NPS}/getBassInfoSearchV2`, params: { ...params, dataType: "json", numOfRows: PAGE_ROWS, pageNo: p }, timeoutMs: 25000, deadline })
    );
    calls += rest.length;
    for (const r of rest) if (r.ok) rows.push(...r.items);
    const failed = rest.filter((r) => !r.ok);
    if (failed.length) return { ok: true, rows, total, calls, pageFailures: failed.map(failSummary) };
  }
  return { ok: true, rows, total, calls, ms: first.ms };
}

/**
 * 검색 행을 사업장 단위로 묶는다.
 * 1차 키는 사업자번호 앞6자리 + 법정동 코드(시도·시군구·읍면동)다. 사업장명은 키에 넣지 않는다 —
 * 1년 사이 상호를 바꾼 사업장이 둘로 쪼개지지 않게 하려는 것이다. 대신 같은 키 안에 **같은 달이
 * 두 번** 나오면(같은 동에 사업장이 둘) 그때만 사업장명으로 다시 나눈다.
 */
function groupRows(rows, nameKey) {
  const first = new Map();
  for (const r of rows) {
    const k = `${String(r.bzowrRgstNo || "").slice(0, 6)}-${r.ldongAddrMgplDgCd ?? ""}${r.ldongAddrMgplSgguCd ?? ""}${r.ldongAddrMgplSgguEmdCd ?? ""}`;
    if (!first.has(k)) first.set(k, []);
    first.get(k).push(r);
  }
  const groups = [];
  for (const [k, list] of first) {
    const months = list.map((r) => String(r.dataCrtYm));
    const dup = new Set(months).size !== months.length;
    if (!dup) {
      groups.push({ key: k, rows: list });
      continue;
    }
    const byName = new Map();
    for (const r of list) {
      const nk = normalizeCorpName(r.wkplNm);
      if (!byName.has(nk)) byName.set(nk, []);
      byName.get(nk).push(r);
    }
    let i = 1;
    for (const sub of byName.values()) groups.push({ key: `${k}-${i++}`, rows: sub, splitByName: true });
  }
  for (const g of groups) {
    g.rows.sort((a, b) => String(b.dataCrtYm).localeCompare(String(a.dataCrtYm)));
    const head = g.rows[0];
    const names = [...new Set(g.rows.map((r) => r.wkplNm))];
    const nk = normalizeCorpName(head.wkplNm);
    g.summary = {
      사업장키: g.key,
      사업장명: head.wkplNm,
      ...(names.length > 1 ? { 사업장명이력: names } : {}),
      사업자등록번호앞6자리: String(head.bzowrRgstNo || "").slice(0, 6),
      주소: head.wkplRoadNmDtlAddr,
      법정동코드: `${head.ldongAddrMgplDgCd ?? ""}${head.ldongAddrMgplSgguCd ?? ""}${head.ldongAddrMgplSgguEmdCd ?? ""}`,
      가입상태: JNNG_ST[String(head.wkplJnngStcd)] || head.wkplJnngStcd || null,
      사업장형태: STYL[String(head.wkplStylDvcd)] || head.wkplStylDvcd || null,
      최신자료월: ymLabel(head.dataCrtYm),
      최초자료월: ymLabel(g.rows[g.rows.length - 1].dataCrtYm),
      자료월수: g.rows.length,
      이름일치: !nameKey ? null : nk === nameKey ? "정확" : nk.includes(nameKey) ? "포함" : "부분",
    };
  }
  // 정렬: 이름 정확일치 → 최신 자료월 → 자료월수
  const rank = { 정확: 0, 포함: 1, 부분: 2, null: 3 };
  groups.sort(
    (a, b) =>
      (rank[a.summary.이름일치] ?? 3) - (rank[b.summary.이름일치] ?? 3) ||
      String(b.rows[0].dataCrtYm).localeCompare(String(a.rows[0].dataCrtYm)) ||
      b.rows.length - a.rows.length
  );
  return groups;
}

/** 선택한 사업장의 월별 상세(가입자수)·기간별 현황(취득·상실)을 seq마다 조회한다. */
async function fetchMonthly(group, months, includeFlows, deadline) {
  const wanted = group.rows.slice(0, months);
  let calls = 0;
  const skipped = (what) => ({ ok: false, endpoint: `${NPS.replace(/^https?:\/\//, "")}/${what}`, httpStatus: 0, resultMsg: "시간상한으로 생략(Vercel 60초 안에서 응답하기 위한 서버 예산)", timeBudget: true });
  const res = await mapLimit(wanted, DETAIL_CONCURRENCY, async (row) => {
    if (Date.now() > deadline) return { row, det: skipped("getDetailInfoSearchV2"), flow: includeFlows ? skipped("getPdAcctoSttusInfoSearchV2") : null };
    const det = await callGw({ url: `${NPS}/getDetailInfoSearchV2`, params: { seq: row.seq, dataType: "json" }, timeoutMs: DETAIL_TIMEOUT, deadline: deadline + 5000 });
    calls++;
    let flow = null;
    if (includeFlows && Date.now() > deadline) flow = skipped("getPdAcctoSttusInfoSearchV2");
    else if (includeFlows) {
      flow = await callGw({ url: `${NPS}/getPdAcctoSttusInfoSearchV2`, params: { seq: row.seq, dataType: "json" }, timeoutMs: DETAIL_TIMEOUT, deadline: deadline + 5000 });
      calls++;
    }
    return { row, det, flow };
  });
  const monthly = [];
  const failures = [];
  let profile = null;
  for (const { row, det, flow } of res) {
    const it = det.ok ? det.items[0] : null;
    const f = flow && flow.ok ? flow.items[0] : null;
    if (!det.ok) failures.push({ 기준연월: ymLabel(row.dataCrtYm), 대상: "상세(가입자수)", ...failSummary(det) });
    if (flow && !flow.ok) failures.push({ 기준연월: ymLabel(row.dataCrtYm), 대상: "기간별 현황(취득·상실)", ...failSummary(flow) });
    if (it && !profile) profile = it;
    monthly.push({
      기준연월: ymLabel(row.dataCrtYm),
      seq: row.seq,
      가입자수: it ? Number(it.jnngpCnt) : null,
      당월고지금액: it && it.crrmmNtcAmt !== undefined ? Number(it.crrmmNtcAmt) : null,
      ...(includeFlows
        ? {
            신규취득: f ? Number(f.nwAcqzrCnt) : flow && flow.ok ? 0 : null,
            상실: f ? Number(f.lssJnngpCnt) : flow && flow.ok ? 0 : null,
          }
        : {}),
      ...(it ? {} : { 조회실패: true }),
    });
  }
  monthly.sort((a, b) => a.기준연월.localeCompare(b.기준연월));
  // 전월 대비 증감 — 앞 달이 실패했으면 비워 둔다(0으로 채우지 않는다).
  for (let i = 0; i < monthly.length; i++) {
    const cur = monthly[i];
    const prev = monthly[i - 1];
    cur.전월대비증감 = prev && prev.가입자수 !== null && cur.가입자수 !== null ? cur.가입자수 - prev.가입자수 : null;
    if (includeFlows && cur.신규취득 !== null && cur.상실 !== null) cur.취득_상실_순증 = cur.신규취득 - cur.상실;
  }
  return { monthly, failures, profile, calls };
}

function summarize(monthly, includeFlows) {
  const ok = monthly.filter((m) => m.가입자수 !== null);
  if (!ok.length) return null;
  const vals = ok.map((m) => m.가입자수);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const latest = ok[ok.length - 1];
  const firstM = ok[0];
  const out = {
    기간: `${firstM.기준연월} ~ ${latest.기준연월}`,
    조회월수: monthly.length,
    결측월수: monthly.length - ok.length,
    최신: { 기준연월: latest.기준연월, 가입자수: latest.가입자수 },
    최소: { 기준연월: ok.find((m) => m.가입자수 === min).기준연월, 가입자수: min },
    최대: { 기준연월: ok.find((m) => m.가입자수 === max).기준연월, 가입자수: max },
    등락폭: max - min,
    등락률_퍼센트: max ? Math.round(((max - min) / max) * 1000) / 10 : null,
    기간증감: latest.가입자수 - firstM.가입자수,
  };
  if (includeFlows) {
    const fl = monthly.filter((m) => m.신규취득 !== null && m.상실 !== null);
    out.신규취득합계 = fl.reduce((s, m) => s + m.신규취득, 0);
    out.상실합계 = fl.reduce((s, m) => s + m.상실, 0);
    out.취득상실집계월수 = fl.length;
  }
  return out;
}

const CAVEATS = [
  "국민연금 가입자수는 재직 인원의 대리지표입니다 — 만 60세 이상·일부 단시간 근로자는 빠지고 등기임원은 포함됩니다. 보고서에도 '국민연금 가입자수 기준'으로 표기하세요.",
  "오픈API 활용가이드상 이 데이터는 대외 공표용 통계로 쓸 수 없습니다(내부 검토·실사 근거로는 무방).",
  "제공시점 기준 약 1년치만 제공되며, 당월분은 매월 15일 이후 반영됩니다. 그 이전 추이는 파일데이터(데이터셋 15083277)로 확인해야 합니다.",
  "한 달 값만 인용하지 말고 월별 추이·등락폭을 함께 밝히세요(실측 클루닉스 12개월 53~57명, 한 달 차이 최대 4명).",
];

const FLOW_CAVEAT =
  "★ 신규취득−상실 순증은 전월 대비 가입자수 증감과 일치하지 않습니다(실측 2026-10-08: 포니링크 2025-12 취득 3·상실 44인데 " +
  "가입자수는 그달 −18, 이듬달 −44). 같은 달로도 한 달 밀어도 맞지 않으며 원인은 확인되지 않았습니다. 두 값을 서로의 검산에 쓰지 말고, " +
  "인원 규모는 가입자수로, 입·퇴사 흐름은 취득·상실로 각각 따로 인용하세요.";

/**
 * 국민연금 가입 사업장 조회 — 사업장 후보 목록 + (선택된 사업장의) 월별 가입자수·취득·상실.
 */
export async function getNationalPensionWorkplace({
  companyName,
  bizNo,
  workplaceName,
  workplace,
  months = 12,
  includeFlows = true,
  maxPages = 3,
  // 내부용(도구 스키마에 노출하지 않음): 후보가 여럿이고 정확일치가 1곳으로 좁혀지지 않을 때
  // 1순위 후보(이름 일치 → 최신 자료월 → 자료월수 순)를 고른다. 근로복지공단 도구의 교차검증처럼
  // 사용자에게 되물을 수 없는 호출에서만 쓴다.
  pickTopIfAmbiguous = false,
} = {}) {
  months = Math.max(1, Math.min(12, Number(months) || 12));
  maxPages = Math.max(1, Math.min(10, Number(maxPages) || 3));
  // 사업장명 단독 검색이 13초, 월별 상세가 최대 24호출이라 전체에 서버 예산을 둔다(Vercel maxDuration 60초).
  const deadline = Date.now() + 50000;
  if (!companyName && !bizNo && !workplaceName) {
    return { ok: false, 안내: "companyName·bizNo·workplaceName 중 하나는 주세요. 회사명만 줘도 서버가 사업자등록번호 앞6자리를 해석해 함께 겁니다." };
  }

  const resolution = { 입력: { companyName: companyName || null, bizNo: bizNo || null, workplaceName: workplaceName || null } };
  let prefix = null;
  if (bizNo) {
    const d = String(bizNo).replace(/\D/g, "");
    if (d.length === 10 || d.length === 9) prefix = (normalizeBizNo(d) || d).slice(0, 6);
    else if (d.length === 6) prefix = d;
    else return { ok: false, 안내: `bizNo는 사업자등록번호 10자리 또는 앞 6자리여야 합니다(받은 값 ${d.length}자리).`, resolution };
    resolution.경로 = "bizNo 직접 지정";
  } else if (companyName) {
    const r = await quickResolve(companyName);
    if (r.ok) {
      prefix = r.bizNo.slice(0, 6);
      resolution.경로 = r.via;
      resolution.해석상호 = r.matched;
      resolution.사업자등록번호 = r.bizNo;
      if (r.indexGeneratedAt) resolution.색인기준 = r.indexGeneratedAt;
      if (r.dartError) resolution.DART오류 = r.dartError;
    } else {
      resolution.경로 = "사업자등록번호 해석 실패 → 사업장명 단독 검색(느림·동명 사업장 섞임)";
      resolution.해석실패사유 = r.reason;
    }
  }
  if (prefix) resolution.사업자등록번호앞6자리 = prefix;

  const searchName = workplaceName || (companyName ? npsSearchName(companyName) : null);
  const params = {};
  if (searchName) params.wkplNm = searchName;
  if (prefix) params.bzowrRgstNo = prefix;
  resolution.검색조건 = { wkplNm: params.wkplNm || null, bzowrRgstNo: params.bzowrRgstNo || null };

  const s = await searchWorkplaces(params, maxPages, deadline);
  let calls = s.calls;
  if (!s.ok) {
    return { ok: false, resolution, 사업장검색: failSummary(s.fail), upstream호출수: calls };
  }
  const out = { ok: true, resolution, 검색결과행수: s.rows.length, 검색전체건수: s.total };
  if (s.pageFailures) out.페이지실패 = s.pageFailures;
  if (s.total > s.rows.length) {
    out.잘림 = true;
    out.유의사항 =
      `★ 검색에 ${s.total}행이 걸렸는데 ${s.rows.length}행만 받았습니다(페이지당 100행 상한 × ${maxPages}페이지). ` +
      (prefix && !searchName
        ? "사업자번호 앞6자리는 세무서·업태 접두라 남의 회사가 대량으로 걸립니다 — companyName을 함께 주세요."
        : "찾는 사업장이 받지 못한 범위에 있을 수 있습니다. bizNo(또는 정확한 companyName)를 주면 앞6자리로 좁혀 다시 조회합니다.");
  }
  if (!s.rows.length) {
    out.사업장후보 = [];
    out.안내 =
      "조건에 맞는 국민연금 가입 사업장이 없습니다. 국민연금은 3인 이상 법인사업장 위주로 개방되고(개인사업장 제외), " +
      "사업장명은 '주식회사 포니링크'처럼 띄어 보관되므로 핵심어만 넣으세요. " +
      (prefix ? "앞6자리를 건 조회이므로, 사업자번호가 맞는지도 확인하세요. " : "") +
      "0건은 '직원이 없다'는 뜻이 아닙니다.";
    out.upstream호출수 = calls;
    return out;
  }

  const nameKey = normalizeCorpName(companyName || workplaceName || "");
  const groups = groupRows(s.rows, nameKey || null);
  out.사업장수 = groups.length;
  out.사업장후보 = groups.slice(0, 30).map((g, i) => ({ 번호: i + 1, ...g.summary }));
  if (groups.length > 30) out.사업장후보잘림 = `사업장 ${groups.length}곳 중 30곳만 담았습니다.`;

  // ── 사업장 선택 ──
  let picked = null;
  if (workplace !== undefined && workplace !== null && workplace !== "") {
    const w = String(workplace).trim();
    picked = groups.find((g) => g.key === w) || (/^\d{1,2}$/.test(w) ? groups[Number(w) - 1] : null);
    if (!picked) {
      out.안내 = `workplace="${w}"에 해당하는 사업장이 없습니다. 사업장후보의 사업장키 또는 번호를 넣으세요.`;
      out.upstream호출수 = calls;
      return out;
    }
    out.선택 = { 방식: "workplace 지정", 사업장키: picked.key };
  } else if (groups.length === 1) {
    picked = groups[0];
    out.선택 = { 방식: "후보가 1곳뿐이라 자동 선택", 사업장키: picked.key };
  } else {
    const exact = groups.filter((g) => g.summary.이름일치 === "정확");
    if (exact.length === 1) {
      picked = exact[0];
      out.선택 = {
        방식: "자동 선택 — 사업장명이 회사명과 정확히 일치하는 곳이 1곳뿐",
        사업장키: picked.key,
        주의: `후보 ${groups.length}곳 중 나머지는 일용·현장 사업장이거나 이름이 부분일치하는 다른 사업장입니다. 의도한 곳이 아니면 workplace로 다시 지정하세요.`,
      };
    }
  }

  if (!picked && pickTopIfAmbiguous) {
    picked = groups[0];
    out.선택 = {
      방식: "자동 선택 — 후보가 여럿이라 1순위(이름 일치 → 최신 자료월 → 자료월수)를 고름",
      사업장키: picked.key,
      주의: `후보 ${groups.length}곳 중 하나를 순위로 고른 것입니다. 의도한 사업장인지 주소·사업자번호 앞6자리로 확인하세요.`,
    };
  }

  if (!picked) {
    out.안내 =
      `사업장 후보가 ${groups.length}곳이라 하나를 고르지 않았습니다. 같은 이름이라도 주소·사업자번호 앞6자리가 다르면 다른 사업장입니다. ` +
      "사업장후보에서 고른 뒤 workplace에 사업장키(또는 번호)를 넣어 다시 부르면 월별 가입자수 추이를 조회합니다.";
    out.caveats = CAVEATS;
    out.upstream호출수 = calls;
    return out;
  }

  const m = await fetchMonthly(picked, months, includeFlows, deadline);
  calls += m.calls;
  out.사업장 = {
    ...picked.summary,
    ...(m.profile
      ? {
          업종: m.profile.vldtVlKrnNm ?? null,
          업종코드: m.profile.wkplIntpCd ?? null,
          사업장등록일: m.profile.adptDt ?? null,
          사업장탈퇴일: m.profile.scsnDt && m.profile.scsnDt !== "00010101" ? m.profile.scsnDt : null,
        }
      : {}),
  };
  out.요약 = summarize(m.monthly, includeFlows);
  out.월별 = m.monthly;
  if (m.failures.length) {
    out.조회실패 = m.failures;
    out.결측안내 = `★ ${m.failures.length}건의 월별 조회가 실패했습니다. 해당 월은 null로 비워 두었습니다(0이 아닙니다). 잠시 뒤 다시 부르면 채워질 수 있습니다.`;
  }
  out.caveats = [
    ...CAVEATS,
    ...(includeFlows ? [FLOW_CAVEAT] : []),
    "업종(vldtVlKrnNm)은 국민연금 사업장 등록 업종이라 DART 업종코드와 다를 수 있습니다. 업종 판정 근거로 쓰지 마세요.",
  ];
  out.upstream호출수 = calls;
  return out;
}
