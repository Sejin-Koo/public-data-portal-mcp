// public-data-portal-mcp / lib/onbid_notice_client.js
//
// 한국자산관리공사 차세대 온비드 **공고 단위** API 래퍼. 2026-10-08 추가.
// 기존 온비드 3종(onbid_mfds_client.js)은 "물건" 단위이고 현재 입찰중·입찰예정 물건만 준다.
// 이 파일은 "공고" 단위이며, **과거 공고와 입찰결과(낙찰가)까지** 조회된다.
//
// ── 확정 오퍼레이션 (2026-10-08 실호출 — 이 인증키로 6종 모두 승인 상태 확인) ──────────
//  공고목록          B010003/OnbidPbancListSrvc2/getPbancList2            (데이터셋 15157216)
//  공고상세          B010003/OnbidPbancDtlnfSrvc2/getPbancDtlInf2         (15157218)  ← "Dtlnf"(소문자 L) 철자 그대로
//  공고 물건정보     B010003/OnbidPbancCltrDtlSrvc2/getPbancCltrInf2      (15157220)
//  공고 입찰정보     B010003/OnbidPbancBidDtlSrvc2/getPbancBidInf2        (15157256)
//  입찰결과목록      B010003/OnbidPbancBidRsltListSrvc2/getPbancBidRsltList2 (15157222)
//  입찰결과상세      B010003/OnbidPbancBidRsltDtlSrvc2/getPbancBidRsltDtl2   (15157258)  ← 낙찰가는 여기에만
//
// ── 실측 사항 ───────────────────────────────────────────────────────────────
//  · 목록 2종의 한 행은 "공고"가 아니라 **공고 × 회차(pbctNo)** 다. 100행에 공고 94~96건.
//  · 목록 2종 모두 정렬은 **개찰일시(cltrOpbdDt) 오름차순**이다(최신순이 아니다).
//  · numOfRows는 2,000까지 그대로 받는다(999 → 999행·약 470KB). 500으로 쓴다.
//  · 날짜는 **yyyyMMdd만** 받는다. "2026-09-01"을 넣으면 공고목록은 NODATA(03)로, 입찰결과목록은
//    UNKNOWN_ERROR(99)로 **조용히** 실패한다(1-14 형식 함정). 서버가 숫자만 남겨 넘긴다.
//  · 공고목록은 명세상 opbdDtStart/End가 필수지만 실제로는 없어도 된다 — 대신 2002년부터 전체
//    74,872행이 오름차순으로 온다. 그래서 날짜 조건이 하나도 없으면 서버가 개찰일 기본 구간을 건다.
//    입찰결과목록은 정말 필수다(빠지면 resultCode 11).
//  · 필터 실측(1900년 구간 → 0건, 정상 구간 → 수천 건): opbdDt·pbancYmd·bidPrdYmd·onbidPbancNm
//    (부분일치, "송파" 29건)·orgNm·bidDivCd·dspsMthodCd·exctStatCd·cltrTypeCd 전부 동작한다.
//  · 과거 자료가 있다: 공고목록 2018-01 개찰 183행, 입찰결과 2018-01 1,764행·2024-03 4,707행.
//  · 공고상세는 회차(pbctNo)마다 한 행씩 오는데 pbctNo 말고는 전부 같다(본문·첨부 반복) → 접는다.
//  · 공고 입찰정보는 매우 크다(압류재산 공고 1건 8행에 985KB) — 요청할 때만 받고 접는다.
//  · 공고 물건정보 한 행은 물건 × 회차다(압류재산 공고 1건 587행). 물건관리번호로 묶는다.
//  · 입찰결과상세는 **그 공고의 모든 회차**를 준다(목록에서 9월 회차를 골랐어도 10월 회차가 섞임).
//    목록 행의 pbctNo와 상세 행의 pbctNo가 정확히 대응하므로, 목록에서 고른 회차만 남긴다.
//  · 낙찰가(scfbAmt)·낙찰가율(lowstBidCtrsScfbPrcRto, **최저입찰가 대비**)·유효입찰자수는
//    입찰결과상세에만 있다. 감정가 대비 낙찰가율은 서버가 계산해 따로 붙인다.

import { PRPT_DIV_CODES, ALL_PRPT_DIV } from "./onbid_mfds_client.js";
import { callGw, mapLimit, failSummary } from "./gw_call.js";

const B = "https://apis.data.go.kr/B010003";
const URL_LIST = `${B}/OnbidPbancListSrvc2/getPbancList2`;
const URL_DTL = `${B}/OnbidPbancDtlnfSrvc2/getPbancDtlInf2`;
const URL_CLTR = `${B}/OnbidPbancCltrDtlSrvc2/getPbancCltrInf2`;
const URL_BID = `${B}/OnbidPbancBidDtlSrvc2/getPbancBidInf2`;
const URL_RSLT = `${B}/OnbidPbancBidRsltListSrvc2/getPbancBidRsltList2`;
const URL_RSLT_DTL = `${B}/OnbidPbancBidRsltDtlSrvc2/getPbancBidRsltDtl2`;

const PAGE_ROWS = 500;

export const CLTR_TYPES = { 부동산: "0001", 자동차: "0002", 동산: "0003" };
export const EXCT_STAT = { 개찰준비중: "0001", 개찰중: "0002", 개찰완료: "0003" };

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 날짜를 yyyyMMdd로. 하이픈을 넣으면 원 API가 조용히 0건이 되므로 반드시 거친다. */
function ymd(s) {
  if (s === undefined || s === null || s === "") return undefined;
  const d = String(s).replace(/\D/g, "");
  return d.length >= 8 ? d.slice(0, 8) : null;
}

function kstYmd(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function cltrTypeCode(v) {
  if (!v) return "0001";
  const s = String(v).trim();
  return CLTR_TYPES[s] || (/^000[123]$/.test(s) ? s : null);
}

function fmtDt(s) {
  // 202610010830 → 2026-10-01 08:30 / 20261001 → 2026-10-01
  const d = String(s ?? "");
  if (d.length >= 12) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d || null;
}

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 목록형 — 첫 페이지에서 totalCount를 읽고 예산 안에서 이어 받는다.
 * enough(rows)가 true를 돌려주면 더 받지 않는다. 목록이 개찰일 오름차순이라, 반환할 공고 수(limit)를
 * 채웠으면 뒤 페이지는 반환되지 않을 공고뿐이기 때문이다. 실측(2026-10-08, 프록시 경유 환경): 500행
 * 4페이지를 다 받는 데 60초가 걸린 적이 있어(Vercel maxDuration 60초) 불필요한 페이지를 줄인다.
 */
async function fetchList(url, params, maxPages, enough = null) {
  const rows = [];
  let total = null;
  let calls = 0;
  const deadline = Date.now() + 40000;
  for (let p = 1; p <= maxPages; p++) {
    if (p > 1 && enough && enough(rows)) break;
    if (p > 1 && Date.now() > deadline) return { ok: true, rows, total: total ?? 0, calls, timedOut: true };
    const r = await callGw({ url, params: { ...params, resultType: "json", pageNo: p, numOfRows: PAGE_ROWS }, timeoutMs: 25000, deadline: deadline + 8000 });
    calls++;
    if (!r.ok) return { ok: false, fail: r, rows, total, calls };
    if (total === null) total = r.totalCount;
    rows.push(...r.items);
    if (r.items.length < PAGE_ROWS) break;
  }
  return { ok: true, rows, total: total ?? 0, calls };
}

function validateDates(map) {
  const bad = Object.entries(map).filter(([, v]) => v === null).map(([k]) => k);
  return bad.length ? `날짜 형식 오류: ${bad.join(", ")} — yyyyMMdd(예: 20261001)로 주세요.` : null;
}

function commonParams(o) {
  const ct = cltrTypeCode(o.cltrType);
  return {
    ct,
    params: {
      cltrTypeCd: ct,
      prptDivCd: o.prptDivCd && String(o.prptDivCd).trim() ? String(o.prptDivCd).trim() : ALL_PRPT_DIV,
      bidDivCd: o.bidDivCd,
      dspsMthodCd: o.dspsMthodCd,
      onbidPbancNm: o.noticeName,
      orgNm: o.orgName,
    },
  };
}

/** 목록 행(공고×회차)을 공고 단위로 접는다. */
function groupByNotice(rows, mapRound) {
  const m = new Map();
  for (const r of rows) {
    const k = r.pbancMngNo;
    if (!m.has(k)) m.set(k, { head: r, rounds: [] });
    m.get(k).rounds.push(mapRound(r));
  }
  return [...m.values()];
}

// ---------------------------------------------------------------------------
// 1) 공고목록
// ---------------------------------------------------------------------------

export async function searchOnbidNotices(opts = {}) {
  const { limit = 50, maxPages = 4 } = opts;
  const { ct, params } = commonParams(opts);
  if (!ct) return { ok: false, 안내: "cltrType은 부동산·자동차·동산(또는 0001·0002·0003) 중 하나입니다." };
  const d = {
    opbdFrom: ymd(opts.opbdFrom),
    opbdTo: ymd(opts.opbdTo),
    pbancFrom: ymd(opts.pbancFrom),
    pbancTo: ymd(opts.pbancTo),
    bidFrom: ymd(opts.bidFrom),
    bidTo: ymd(opts.bidTo),
  };
  const err = validateDates(d);
  if (err) return { ok: false, 안내: err };
  let 기본구간 = null;
  if (!Object.values(d).some(Boolean)) {
    // 날짜 조건이 없으면 원 API는 2002년부터 전량을 오름차순으로 준다 — 쓸모가 없어 기본 구간을 건다.
    d.opbdFrom = kstYmd(0);
    d.opbdTo = kstYmd(14);
    기본구간 = `날짜 조건이 없어 개찰일 ${fmtDt(d.opbdFrom)} ~ ${fmtDt(d.opbdTo)}(오늘부터 14일)로 조회했습니다.`;
  }
  Object.assign(params, {
    opbdDtStart: d.opbdFrom,
    opbdDtEnd: d.opbdTo,
    pbancYmdStart: d.pbancFrom,
    pbancYmdEnd: d.pbancTo,
    bidPrdYmdStart: d.bidFrom,
    bidPrdYmdEnd: d.bidTo,
  });
  const pages = Math.max(1, Math.min(10, Number(maxPages) || 4));
  const lim = Math.max(1, Math.min(300, Number(limit) || 50));
  const r = await fetchList(URL_LIST, params, pages, (rows) => new Set(rows.map((x) => x.pbancMngNo)).size > lim);
  if (!r.ok) return { ok: false, 조회: failSummary(r.fail), upstream호출수: r.calls };

  const notices = groupByNotice(r.rows, (x) => ({
    회차: x.pbctNsq,
    입찰번호_pbctNo: x.pbctNo,
    입찰시작: fmtDt(x.cltrBidBgngDt),
    입찰마감: fmtDt(x.cltrBidEndDt),
    개찰일시: fmtDt(x.cltrOpbdDt),
  })).map(({ head: h, rounds }) => ({
    공고관리번호: h.pbancMngNo,
    온비드공고번호: h.onbidPbancNo,
    공고명: h.onbidPbancNm,
    공고종류: h.pbancKindNm,
    재산유형: h.prptDivNm,
    처분방식: h.dspsMthodNm,
    입찰구분: h.bidDivNm,
    기관명: h.orgNm,
    담당부서: h.rspbSbrNm || null,
    공고일: fmtDt(h.pbancYmd),
    회차수_조회구간내: rounds.length,
    회차: rounds,
  }));
  const out = {
    ok: true,
    조건: { 물건유형: Object.keys(CLTR_TYPES).find((k) => CLTR_TYPES[k] === ct), ...params, prptDivCd: params.prptDivCd === ALL_PRPT_DIV ? "전체" : params.prptDivCd },
    ...(기본구간 ? { 기본구간 } : {}),
    전체행수: r.total,
    수집행수: r.rows.length,
    공고수_수집분: notices.length,
    반환공고수: Math.min(lim, notices.length),
    회차범위: "각 공고의 회차는 이번에 받은 행 기준입니다(행이 잘렸으면 늦은 회차가 빠졌을 수 있음 — 전 회차는 get_onbid_notice_detail).",
    정렬: "개찰일시 오름차순(원 API 고정) — 가까운 개찰부터",
    공고: notices.slice(0, lim),
    다음단계: "공고관리번호를 get_onbid_notice_detail에 넣으면 공고문·첨부·물건 목록(cltrMngNo·pbctCdtnNo)을 볼 수 있습니다.",
    upstream호출수: r.calls,
  };
  if (r.total > r.rows.length) {
    out.잘림 = true;
    out.유의사항 =
      `★ ${r.total}행(공고×회차) 중 ${r.rows.length}행만 받았습니다${r.timedOut ? "(시간상한)" : ""}. 오름차순이라 뒤쪽(늦은 개찰) 공고가 빠졌습니다. ` +
      "기간을 좁히거나 noticeName·orgName·prptDivCd로 좁혀 다시 조회하세요. 이 결과로 건수를 내지 마세요.";
  }
  if (!r.rows.length) {
    out.안내 = "조건에 맞는 공고가 없습니다(NODATA). 날짜는 yyyyMMdd이고, 공고명은 부분일치입니다. 0건은 조건 기준이며 오류가 아닙니다.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2) 공고상세 (+ 물건정보, 입찰정보)
// ---------------------------------------------------------------------------

/** 회차마다 반복되는 행에서 서로 다른 필드만 골라 낸다. */
function diffKeys(items) {
  const keys = new Set();
  for (const it of items) for (const k of Object.keys(it)) if (JSON.stringify(it[k]) !== JSON.stringify(items[0][k])) keys.add(k);
  return [...keys];
}

export async function getOnbidNoticeDetail({ pbancMngNo, sections, cltrLimit = 100 } = {}) {
  if (!pbancMngNo) return { ok: false, 안내: "pbancMngNo(공고관리번호, 예: 202609-30261-00)가 필요합니다. search_onbid_notices로 먼저 확보하세요." };
  const want = new Set(asArray(sections).length ? asArray(sections) : ["공고", "물건"]);
  const no = String(pbancMngNo).trim();
  const out = { ok: true, 공고관리번호: no };
  let calls = 0;

  const tasks = [];
  if (want.has("공고")) tasks.push(["공고", callGw({ url: URL_DTL, params: { resultType: "json", pageNo: 1, numOfRows: 100, pbancMngNo: no }, timeoutMs: 25000 })]);
  if (want.has("입찰")) tasks.push(["입찰", callGw({ url: URL_BID, params: { resultType: "json", pageNo: 1, numOfRows: 100, pbancMngNo: no }, timeoutMs: 30000 })]);
  if (want.has("물건")) tasks.push(["물건", fetchList(URL_CLTR, { pbancMngNo: no }, 3)]);
  const done = await Promise.all(tasks.map(([, p]) => p));
  const res = Object.fromEntries(tasks.map(([k], i) => [k, done[i]]));

  if (res.공고) {
    calls++;
    const r = res.공고;
    if (!r.ok) out.공고 = failSummary(r);
    else if (!r.items.length) out.공고 = { 조회됨: true, 건수: 0, 안내: "해당 공고관리번호의 공고상세가 없습니다. 번호 형식(YYYYMM-NNNNN-NN)을 확인하세요." };
    else {
      const h = r.items[0];
      out.공고 = {
        공고명: h.onbidPbancNm,
        온비드공고번호: h.onbidPbancNo,
        공고종류: h.pbancKindNm,
        공고회차명: h.pbancNsqNm || null,
        공고일: fmtDt(h.pbancYmd),
        공고기관: h.pbancOrgNm,
        재산유형: h.prptDivNm,
        처분방식: h.dspsMthodNm,
        입찰방식: h.bidMthodNm,
        경쟁방식: h.cptnMthodNm,
        입찰구분: h.bidDivNm,
        총액단가구분: h.totalamtUnpcDivNm,
        입찰금액공개여부: h.bidAmtRlsYn,
        참가수수료: h.ptctCmsn ?? null,
        참가자격: h.pbancPtctQlfcCont || null,
        공고취소사유: h.pbancRtrcnRsnCont || null,
        관련공고: h.rltnPbancMngNo ? { 공고관리번호: h.rltnPbancMngNo, 공고명: h.rltnPbancNm } : null,
        공고문요지: h.anncmAlCont || null,
        첨부: asArray(h.atchFileList).map((f) => ({ 파일명: f.btbdAtchFileNm, URL: f.urlAdr })),
        회차_pbctNo: r.items.map((x) => x.pbctNo),
      };
      const dk = diffKeys(r.items).filter((k) => k !== "pbctNo");
      if (dk.length) out.공고.회차별로다른필드 = dk; // 실측상 pbctNo만 달랐다 — 다르면 알린다
    }
  }

  if (res.물건) {
    const r = res.물건;
    calls += r.calls;
    if (!r.ok) out.물건 = failSummary(r.fail);
    else {
      const m = new Map();
      for (const x of r.rows) {
        if (!m.has(x.cltrMngNo)) m.set(x.cltrMngNo, { head: x, rounds: [] });
        m.get(x.cltrMngNo).rounds.push({
          회차: x.pbctNsq,
          공매조건번호_pbctCdtnNo: x.pbctCdtnNo,
          입찰시작: fmtDt(x.cltrBidBgngDt),
          입찰마감: fmtDt(x.cltrBidEndDt),
          최저입찰가: num(x.lowstBidPrcIndctCont),
          유찰횟수: x.usbdNft ?? null,
          상태: x.pbctStatNm,
        });
      }
      const lim = Math.max(1, Math.min(500, Number(cltrLimit) || 100));
      const list = [...m.values()].map(({ head: h, rounds }) => {
        rounds.sort((a, b) => String(a.회차).localeCompare(String(b.회차), undefined, { numeric: true }));
        const last = rounds[rounds.length - 1];
        return {
          물건관리번호_cltrMngNo: h.cltrMngNo,
          온비드물건번호: h.onbidCltrno,
          물건명: h.onbidCltrNm,
          소재지: h.cltrAdr || null,
          용도: [h.cltrUsgLclsCtgrNm, h.cltrUsgMclsCtgrNm, h.cltrUsgSclsCtgrNm].filter(Boolean).join(" > "),
          일괄입찰: h.batcBidYn ?? null,
          감정가: num(h.apslEvlAmt),
          최근회차_pbctCdtnNo: last?.공매조건번호_pbctCdtnNo ?? null,
          최근회차상태: last?.상태 ?? null,
          회차: rounds,
        };
      });
      out.물건 = {
        조회됨: true,
        행수_물건x회차: r.total,
        수집행수: r.rows.length,
        물건수: list.length,
        반환물건수: Math.min(lim, list.length),
        물건: list.slice(0, lim),
        연결: "물건관리번호_cltrMngNo + 최근회차_pbctCdtnNo를 get_onbid_realestate_detail / get_onbid_bid_info에 넣으면 물건 상세·입찰조건을 볼 수 있습니다(현재 입찰중·예정 물건만 — 종료된 물건은 그쪽에서 안 나옵니다).",
      };
      if (r.total > r.rows.length || list.length > lim) {
        out.물건.잘림 = true;
        out.물건.유의사항 = `★ 물건×회차 ${r.total}행 중 ${r.rows.length}행 수집, 물건 ${list.length}건 중 ${Math.min(lim, list.length)}건 반환. 물건 수 집계에 쓰지 마세요.`;
      }
    }
  }

  if (res.입찰) {
    calls++;
    const r = res.입찰;
    if (!r.ok) out.입찰정보 = failSummary(r);
    else if (r.items.length) {
      const h = r.items[0];
      const sched = new Map();
      for (const it of r.items) for (const c of asArray(it.cseqBidInfClgList)) sched.set(`${c.pbctNsq}|${c.bidMngNo}`, c);
      out.입찰정보 = {
        공동입찰가능: h.collbBidPsblYn,
        대리입찰가능: h.subtBidPsblYn,
        "2회이상입찰가능": h.twtmGthrBidPsblYn,
        차순위매수신청가능: h.nrnkAplyPsblYn,
        유효입찰기준: h.bidVldCrtrCont,
        입찰보증금: h.pbctTdpsCont,
        대금납부방법: h.pcmtPayMtdCont,
        대금납부기한: h.pcmtPayTermCont,
        동일IP중복입찰차단: h.smnsIpDpcnBidBlcktYn,
        회차일정: [...sched.values()]
          .sort((a, b) => String(a.pbctNsq).localeCompare(String(b.pbctNsq), undefined, { numeric: true }))
          .map((c) => ({ 회차: c.pbctNsq, 입찰구분: c.bidDivNm, 입찰시작: fmtDt(c.cltrBidBgngDt), 입찰마감: fmtDt(c.cltrBidEndDt), 개찰일시: fmtDt(c.cltrOpbdDt), 개찰장소: c.pbctOpbdPlcCont })),
      };
      const dk = diffKeys(r.items.map(({ cseqBidInfClgList, ...rest }) => rest)).filter((k) => k !== "pbctNo");
      if (dk.length) out.입찰정보.회차별로다른필드 = dk;
    } else out.입찰정보 = { 조회됨: true, 건수: 0 };
  }
  out.upstream호출수 = calls;
  return out;
}

// ---------------------------------------------------------------------------
// 3) 입찰결과 (목록 + 결과상세의 낙찰가)
// ---------------------------------------------------------------------------

function shapeResultCltr(c) {
  const apsl = num(c.apslEvlAmt);
  const low = num(c.lowstBidPrcIndctCont);
  const win = num(c.scfbAmt);
  return {
    물건관리번호_cltrMngNo: c.cltrMngNo,
    물건명: c.onbidCltrNm,
    용도: [c.cltrUsgLclsCtgrNm, c.cltrUsgMclsCtgrNm, c.cltrUsgSclsCtgrNm].filter(Boolean).join(" > "),
    토지면적: c.landSqms ?? null,
    건물면적: c.bldSqms ?? null,
    회차: c.pbctNsq,
    개찰일시: fmtDt(c.cltrOpbdDt),
    감정가: apsl,
    최저입찰가: low,
    상태: c.pbctStatNm,
    낙찰가: win,
    낙찰가율_최저입찰가대비: win ? c.lowstBidCtrsScfbPrcRto ?? null : null,
    낙찰가율_감정가대비: win && apsl ? Math.round((win / apsl) * 10000) / 100 : null,
    유효입찰자수: c.vldBddrNope ?? null,
    무효입찰자수: c.nfctBddrNope ?? null,
  };
}

async function resultDetail(no) {
  const r = await callGw({ url: URL_RSLT_DTL, params: { resultType: "json", pageNo: 1, numOfRows: 100, pbancMngNo: no }, timeoutMs: 25000 });
  return r;
}

function tally(cltrs) {
  const byStat = {};
  for (const c of cltrs) byStat[c.상태 || "미상"] = (byStat[c.상태 || "미상"] || 0) + 1;
  const wins = cltrs.filter((c) => c.낙찰가);
  const ratios = wins.map((c) => c.낙찰가율_감정가대비).filter((v) => v !== null).sort((a, b) => a - b);
  return {
    물건행수: cltrs.length,
    상태별: byStat,
    낙찰건수: wins.length,
    낙찰가합계: wins.reduce((s, c) => s + c.낙찰가, 0),
    감정가대비낙찰가율_중앙값: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,
  };
}

export async function searchOnbidBidResults(opts = {}) {
  const { pbancMngNo, includeAmounts = true, detailLimit = 10, limit = 50, maxPages = 4 } = opts;

  // ── 공고 하나의 결과만 ──
  if (pbancMngNo) {
    const no = String(pbancMngNo).trim();
    const r = await resultDetail(no);
    if (!r.ok) return { ok: false, 공고관리번호: no, 조회: failSummary(r), upstream호출수: 1 };
    const from = ymd(opts.opbdFrom);
    const to = ymd(opts.opbdTo);
    const rounds = r.items.map((it) => {
      const cl = asArray(it.cltrBidRsltClgList).map(shapeResultCltr);
      return { 회차: it.pbctNsq, 입찰번호_pbctNo: it.pbctNo, 물건결과: cl };
    });
    let kept = rounds;
    if (from || to) {
      kept = rounds
        .map((x) => ({ ...x, 물건결과: x.물건결과.filter((c) => { const dd = (c.개찰일시 || "").replace(/\D/g, "").slice(0, 8); return (!from || dd >= from) && (!to || dd <= to); }) }))
        .filter((x) => x.물건결과.length);
    }
    kept.sort((a, b) => String(a.회차).localeCompare(String(b.회차), undefined, { numeric: true }));
    const h = r.items[0] || {};
    return {
      ok: true,
      공고관리번호: no,
      공고명: h.onbidPbancNm ?? null,
      기관명: h.orgNm ?? null,
      공고일: fmtDt(h.pbancYmd),
      입찰방식: h.bidMthodNm ?? null,
      입찰금액공개여부: h.bidAmtRlsYn ?? null,
      회차수: kept.length,
      집계: tally(kept.flatMap((x) => x.물건결과)),
      회차별결과: kept,
      ...(r.totalCount > r.items.length ? { 잘림: true, 유의사항: `★ 회차 ${r.totalCount}건 중 ${r.items.length}건만 받았습니다.` } : {}),
      ...(!r.items.length ? { 안내: "이 공고관리번호의 입찰결과가 없습니다(개찰 전이거나 번호 오류)." } : {}),
      upstream호출수: 1,
    };
  }

  // ── 목록 ──
  const { ct, params } = commonParams(opts);
  if (!ct) return { ok: false, 안내: "cltrType은 부동산·자동차·동산(또는 0001·0002·0003) 중 하나입니다." };
  const d = { opbdFrom: ymd(opts.opbdFrom), opbdTo: ymd(opts.opbdTo), pbancFrom: ymd(opts.pbancFrom), pbancTo: ymd(opts.pbancTo) };
  const err = validateDates(d);
  if (err) return { ok: false, 안내: err };
  let 기본구간 = null;
  // 입찰결과목록은 개찰일 구간이 진짜 필수다(빠지면 resultCode 11).
  if (!d.opbdFrom || !d.opbdTo) {
    d.opbdTo = d.opbdTo || kstYmd(0);
    d.opbdFrom = d.opbdFrom || (() => {
      const t = Date.UTC(+d.opbdTo.slice(0, 4), +d.opbdTo.slice(4, 6) - 1, +d.opbdTo.slice(6, 8)) - 30 * 86400000;
      return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
    })();
    기본구간 = `개찰일 구간을 ${fmtDt(d.opbdFrom)} ~ ${fmtDt(d.opbdTo)}로 채웠습니다(원 API 필수 조건).`;
  }
  let exct = opts.exctStatCd;
  if (exct && EXCT_STAT[exct]) exct = EXCT_STAT[exct];
  Object.assign(params, {
    opbdDtStart: d.opbdFrom,
    opbdDtEnd: d.opbdTo,
    pbancYmdStart: d.pbancFrom,
    pbancYmdEnd: d.pbancTo,
    exctStatCd: exct,
  });
  const pages = Math.max(1, Math.min(10, Number(maxPages) || 4));
  const lim = Math.max(1, Math.min(300, Number(limit) || 50));
  const r = await fetchList(URL_RSLT, params, pages, (rows) => new Set(rows.map((x) => x.pbancMngNo)).size > lim);
  if (!r.ok) return { ok: false, 조회: failSummary(r.fail), upstream호출수: r.calls };
  let calls = r.calls;

  const notices = groupByNotice(r.rows, (x) => ({ 회차: x.pbctNsq, 입찰번호_pbctNo: x.pbctNo, 개찰일시: fmtDt(x.cltrOpbdDt), 집행상태: x.exctStatNm })).map(
    ({ head: h, rounds }) => ({
      공고관리번호: h.pbancMngNo,
      공고명: h.onbidPbancNm,
      공고종류: h.pbancKindNm,
      재산유형: h.prptDivNm,
      처분방식: h.dspsMthodNm,
      기관명: h.orgNm,
      담당부서: h.rspbSbrNm || null,
      공고일: fmtDt(h.pbancYmd),
      회차: rounds,
    })
  );
  const returned = notices.slice(0, lim);

  const out = {
    ok: true,
    조건: { 물건유형: Object.keys(CLTR_TYPES).find((k) => CLTR_TYPES[k] === ct), ...params, prptDivCd: params.prptDivCd === ALL_PRPT_DIV ? "전체" : params.prptDivCd },
    ...(기본구간 ? { 기본구간 } : {}),
    전체행수: r.total,
    수집행수: r.rows.length,
    공고수_수집분: notices.length,
    반환공고수: returned.length,
    정렬: "개찰일시 오름차순(원 API 고정)",
  };

  // 낙찰가는 결과상세에만 있다 — 반환 공고 중 앞쪽 detailLimit건에 붙인다.
  if (includeAmounts && returned.length) {
    const n = Math.max(0, Math.min(30, Number(detailLimit) || 10));
    const targets = returned.slice(0, n);
    const det = await mapLimit(targets, 3, (x) => resultDetail(x.공고관리번호));
    calls += targets.length;
    const allCltr = [];
    targets.forEach((x, i) => {
      const dr = det[i];
      if (!dr.ok) {
        x.결과상세 = failSummary(dr);
        return;
      }
      const wantNo = new Set(x.회차.map((rd) => String(rd.입찰번호_pbctNo)));
      const mine = dr.items.filter((it) => wantNo.has(String(it.pbctNo)));
      const cl = mine.flatMap((it) => asArray(it.cltrBidRsltClgList).map(shapeResultCltr));
      x.물건결과 = cl;
      x.집계 = tally(cl);
      if (dr.items.length > mine.length) x.제외회차수 = dr.items.length - mine.length; // 구간 밖 회차
      allCltr.push(...cl);
    });
    out.낙찰가조회 = {
      대상공고수: targets.length,
      안내:
        `낙찰가는 입찰결과상세에만 있어 반환 공고 중 앞쪽 ${targets.length}건만 공고별로 추가 조회했습니다(detailLimit). ` +
        "결과상세는 그 공고의 모든 회차를 주므로 조회구간의 회차(pbctNo)만 남겼습니다(제외회차수 참고).",
      집계_대상공고분: tally(allCltr),
    };
    if (notices.length > targets.length) {
      out.낙찰가조회.유의사항 = `★ 집계_대상공고분은 ${notices.length}건 중 ${targets.length}건만의 값입니다 — 구간 전체 낙찰 통계로 쓰지 마세요.`;
    }
  }
  out.공고 = returned;
  out.다음단계 = "특정 공고의 전 회차 결과는 pbancMngNo만 넣어 다시 부르세요. 공고문·첨부는 get_onbid_notice_detail.";
  if (r.total > r.rows.length) {
    out.잘림 = true;
    out.유의사항 =
      `★ ${r.total}행(공고×회차) 중 ${r.rows.length}행만 받았습니다${r.timedOut ? "(시간상한)" : ""}(오름차순이라 구간 뒤쪽이 빠짐). ` +
      "기간·재산유형·기관명으로 좁혀 다시 조회하세요. 이 결과로 건수를 내지 마세요.";
  }
  if (!r.rows.length) out.안내 = "조건에 맞는 입찰결과가 없습니다(NODATA). 0건은 조건 기준이며 오류가 아닙니다.";
  out.upstream호출수 = calls;
  return out;
}

export { PRPT_DIV_CODES };
