// public-data-portal-mcp / lib/gov_announce_client.js
//
// 과학기술정보통신부·중소벤처기업부 **사업공고**(R&D·지원사업 공모) 스캔. 2026-10-08 추가.
// man-public-data 5절 "MCP 미포함 소스"에 있던 두 API를 scan_* 도구 계열로 편입한 것이다.
//
// ── 과기정통부 1721000/msitannouncementinfo/businessAnnouncMentList (데이터셋 15074634) ──
//  · 명세상 요청변수는 pageNo·numOfRows·returnType 셋뿐이다. **날짜·키워드 필터가 없다.**
//  · ★ numOfRows가 **무시된다** — 1·5·50·99·100·999 어느 값을 줘도 항상 10행이다(실측
//    2026-10-08, NumOfRows·numofrows·perPage·rows 등 철자 변형과 XML 응답도 모두 10행).
//    pageNo는 동작한다(43페이지 = 2026-02 공고). 즉 **한 호출에 10건 고정**이다.
//  · 정렬은 게시일(pressDt) **내림차순**(1페이지 100% 단조 감소 확인). 그래서 최신부터 페이지를
//    넘기다 since보다 오래된 공고가 나오면 멈춘다. 실측 밀도는 월 약 50건(≈ 5페이지/월).
//  · subject·searchKeyword·startDate/endDate·pressDt를 넣어도 totalCount 4,259 그대로
//    — 조용히 무시된다. 그래서 날짜·키워드는 **서버(이 도구)가 걸러 준다.**
//  · 응답이 { response: [ {header}, {body} ] } 배열 구조이고, items는 [{item:{…}}], 첨부는
//    files:[{file:{fileName,fileUrl}}]다. 접수기간 필드는 없다.
//
// ── 중기부 1421000/mssBizService_v2/getbizList_v2 (데이터셋 15113297) ──────────────────
//  · ★ XML만 준다. returnType·dataType·type·_type·resultType=json 모두 무시하고 XML.
//  · startDate·endDate(공고등록일 기준)가 **실제로 동작한다**. YYYY-MM-DD·YYYYMMDD 둘 다 된다
//    (2026-09: 18건, 2026-10-01~08: 5건, 1900·2099년: 0건).
//  · numOfRows는 2,000까지 그대로 받는다(999 → 999행·1.1MB·8.2초). 응답이 커서 500으로 쓴다.
//  · ★ 응답에 **공고(등록)일 필드가 없다.** itemId·제목·본문(dataContents)·신청시작/마감일
//    (applicationStartDate/EndDate, 23건 중 18건만 채워짐)·담당자·첨부만 온다. 그래서 공고일은
//    기본적으로 "조회구간 안"까지만 알 수 있다. mssDateResolution='day'를 주면 하루 단위로
//    다시 불러 날짜를 붙이는데, 6건 병렬로 부르자 초당 한도(코드 23, HTTP 429)에 걸렸으므로
//    **순차·간격 두고** 부른다(31일 이내만).
//  · ★★ 일일 한도가 **개발계정 100회**다(데이터셋 페이지 표기, 실측: 이 날 약 100회 호출 뒤
//    HTTP 429·코드 22 LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR). 기본 모드는 1~3호출이지만
//    하루 단위 해석은 최대 31호출이라 하루치의 3분의 1을 쓴다. 모든 건에 날짜가 붙으면 남은 날은 건너뛴다.
//  · totalCount가 실제 행 수보다 작을 때가 있다(2020-01: total 84·행 85). 페이지 종료 판정은
//    totalCount가 아니라 "받은 행 < 페이지 크기"로 한다(sys-mcp-server-dev 1-11).
//  · fileName·fileUrl이 item 안에 형제 태그로 반복된다 — 같은 순번끼리 짝지어 첨부로 만든다.
//  · 정렬은 itemId 내림차순(최신 먼저).

import { DEFAULT_KEYWORDS, matchesKeywords } from "./pdp_client.js";
import { callGw, mapLimit, failSummary, sleep } from "./gw_call.js";

const MSIT_URL = "https://apis.data.go.kr/1721000/msitannouncementinfo/businessAnnouncMentList";
const MSS_URL = "https://apis.data.go.kr/1421000/mssBizService_v2/getbizList_v2";
const MSIT_FIXED_ROWS = 10; // ★ numOfRows 무시 — 실측 고정값
const MSS_PAGE_ROWS = 500;
const MSS_MAX_PAGES = 3;

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** YYYYMMDD / YYYY-MM-DD / YYYYMMDDHHMM → YYYY-MM-DD. 형식이 틀리면 null. */
export function toIsoDate(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, "");
  if (d.length < 8) return null;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function addDays(iso, n) {
  return new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
}

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// 과기정통부
// ---------------------------------------------------------------------------

function shapeMsit(it) {
  const files = asArray(it.files)
    .map((f) => (f && f.file ? f.file : f))
    .filter(Boolean)
    .map((f) => ({ 파일명: f.fileName, URL: f.fileUrl }));
  const ntt = String(it.viewUrl || "").match(/nttSeqNo=(\d+)/)?.[1] || null;
  return {
    출처: "과기정통부",
    id: ntt,
    제목: it.subject,
    부처: "과학기술정보통신부",
    부서: it.deptName || null,
    담당자: it.managerName || null,
    연락처: it.managerTel || null,
    공고일: it.pressDt || null,
    접수시작: null,
    접수마감: null,
    URL: it.viewUrl,
    첨부수: files.length,
    첨부: files,
  };
}

async function scanMsit({ since, until, maxPages, deadline }) {
  const items = [];
  const errors = [];
  let calls = 0;
  let page = 1;
  let reachedSince = false;
  let total = null;
  // 2페이지씩 병렬로 넘긴다(초당 한도 회피 — 중기부에서 6병렬에 코드 23 실측).
  let timedOut = false;
  while (page <= maxPages && !reachedSince) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const batch = [page, page + 1].filter((p) => p <= maxPages);
    const res = await mapLimit(batch, 2, (p) =>
      callGw({ url: MSIT_URL, params: { returnType: "json", pageNo: p, numOfRows: MSIT_FIXED_ROWS }, timeoutMs: 15000, deadline: deadline + 5000 })
    );
    calls += res.length;
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (!r.ok) {
        errors.push({ 페이지: batch[i], ...failSummary(r) });
        if (r.rateLimited) reachedSince = true; // 한도 초과면 더 넘기지 않는다
        continue;
      }
      if (total === null) total = r.totalCount;
      const rows = r.items.map(shapeMsit);
      if (!rows.length) reachedSince = true;
      for (const row of rows) {
        if (row.공고일 && row.공고일 < since) reachedSince = true;
        else if (!row.공고일 || row.공고일 <= until) items.push(row);
      }
    }
    page += batch.length;
  }
  const out = { 소스: "과기정통부 사업공고", 수집건수: items.length, 페이지수: page - 1, upstream호출수: calls, 전체게시물수: total, items, errors };
  if (timedOut) {
    out.잘림 = true;
    out.유의사항 = `★ 시간상한(서버 예산)에 걸려 ${page - 1}페이지까지만 넘겼습니다. 이 결과는 ${since}까지의 전체가 아닙니다 — 구간을 좁혀 다시 조회하세요.`;
  } else if (!reachedSince && page > maxPages) {
    out.잘림 = true;
    out.유의사항 =
      `★ 과기정통부 API는 날짜 필터가 없고 한 호출에 10건 고정이라 최신부터 ${maxPages}페이지(${maxPages * MSIT_FIXED_ROWS}건)까지만 넘겼는데 ` +
      `아직 ${since}에 닿지 못했습니다. 이 결과는 구간 전체가 아닙니다 — since를 늦추거나 msitMaxPages를 늘리세요.`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 중기부
// ---------------------------------------------------------------------------

function shapeMss(it) {
  const names = asArray(it.fileName);
  const urls = asArray(it.fileUrl);
  const n = Math.max(names.length, urls.length);
  const files = Array.from({ length: n }, (_, i) => ({ 파일명: names[i] ?? null, URL: urls[i] ?? null }));
  const body = stripHtml(it.dataContents);
  return {
    출처: "중기부",
    id: String(it.itemId ?? ""),
    제목: it.title,
    부처: "중소벤처기업부",
    부서: it.writerPosition || null,
    담당자: it.writerName || null,
    연락처: it.writerPhone || null,
    공고일: null,
    접수시작: it.applicationStartDate || null,
    접수마감: it.applicationEndDate || null,
    URL: it.viewUrl,
    첨부수: files.length,
    첨부: files,
    본문요약: body ? body.slice(0, 200) + (body.length > 200 ? "…" : "") : null,
  };
}

async function fetchMssRange(startDate, endDate) {
  const rows = [];
  let calls = 0;
  let total = null;
  for (let p = 1; p <= MSS_MAX_PAGES; p++) {
    const r = await callGw({
      url: MSS_URL,
      params: { pageNo: p, numOfRows: MSS_PAGE_ROWS, startDate, endDate },
      timeoutMs: 25000,
    });
    calls++;
    if (!r.ok) return { ok: false, fail: r, rows, calls, total };
    if (total === null) total = r.totalCount;
    rows.push(...r.items);
    // ★ totalCount가 실제보다 작게 오는 경우가 있어 종료 판정은 행 수로 한다.
    if (r.items.length < MSS_PAGE_ROWS) return { ok: true, rows, calls, total, complete: true };
  }
  return { ok: true, rows, calls, total, complete: false };
}

async function scanMss({ since, until, dateResolution, deadline }) {
  const r = await fetchMssRange(since, until);
  const out = { 소스: "중기부 사업공고", upstream호출수: r.calls, errors: [] };
  if (!r.ok) {
    out.errors.push(failSummary(r.fail));
    out.items = [];
    out.수집건수 = 0;
    return out;
  }
  const items = r.rows.map(shapeMss);
  out.전체건수 = r.total;
  out.수집건수 = items.length;
  if (!r.complete) {
    out.잘림 = true;
    out.유의사항 = `★ 구간 내 공고가 ${MSS_PAGE_ROWS * MSS_MAX_PAGES}건을 넘어 일부만 받았습니다. 구간을 나눠 다시 조회하세요.`;
  }

  // 공고일 해석 — 기본은 구간만 알린다.
  const days = Math.round((Date.parse(until) - Date.parse(since)) / 86400000) + 1;
  if (dateResolution === "day") {
    if (days > 31) {
      out.공고일해석 = `요청 구간이 ${days}일이라 하루 단위 해석을 생략했습니다(31일 이내만 — 하루 1호출이 들고 초당 한도가 있습니다).`;
    } else if (items.length) {
      const byId = new Map(items.map((x) => [x.id, x]));
      let resolved = 0;
      let dayCalls = 0;
      let stopped = null;
      const failedDays = [];
      for (let d = since; d <= until; d = addDays(d, 1)) {
        // 모든 건에 날짜가 붙었으면 남은 날은 부를 필요가 없다.
        if (resolved === items.length) break;
        if (Date.now() > deadline) {
          stopped = { 날짜: d, 사유: "시간상한(Vercel 60초 안에서 응답하기 위한 서버 예산)" };
          break;
        }
        const dr = await callGw({ url: MSS_URL, params: { pageNo: 1, numOfRows: MSS_PAGE_ROWS, startDate: d, endDate: d }, timeoutMs: 12000, retries: 3, deadline: deadline + 5000 });
        dayCalls++;
        if (!dr.ok) {
          // ★ 한도 초과면 멈추고(재시도·연속 호출은 한도만 더 쓴다), 일시적 네트워크 실패면 그날만 비우고 계속한다.
          if (dr.rateLimited) {
            stopped = { 날짜: d, ...failSummary(dr) };
            break;
          }
          failedDays.push({ 날짜: d, ...failSummary(dr) });
          continue;
        }
        for (const it of dr.items) {
          const x = byId.get(String(it.itemId ?? ""));
          if (x && !x.공고일) {
            x.공고일 = d;
            resolved++;
          }
        }
        await sleep(350); // ★ 초당 한도(코드 23) 회피 간격
      }
      out.upstream호출수 += dayCalls;
      out.공고일해석 =
        `하루 단위로 ${dayCalls}회 다시 불러 ${items.length}건 중 ${resolved}건에 공고일을 붙였습니다.` +
        (failedDays.length ? ` ★ ${failedDays.length}일은 조회가 실패해 그날 공고는 공고일이 비어 있습니다.` : "") +
        (stopped ? ` ★ ${stopped.날짜}부터 중단했습니다(${stopped.사유 || stopped.resultMsg}) — 나머지는 공고일이 비어 있습니다.` : "");
      out.errors.push(...failedDays);
      if (stopped) out.errors.push(stopped);
    }
  } else {
    out.공고일해석 =
      `중기부 API 응답에는 공고(등록)일 필드가 없습니다. 각 건은 조회구간(${since}~${until}) 안에 등록된 것까지만 확실합니다. ` +
      "정확한 날짜가 필요하면 mssDateResolution='day'로 다시 부르세요(31일 이내, 하루 1호출).";
  }
  out.items = items;
  return out;
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

/** 배열·JSON 문자열·쉼표 구분 문자열을 모두 키워드 배열로. (클라이언트가 배열을 문자열로 보내는 경우 대비) */
export function parseKeywords(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return null;
  if (s.startsWith("[")) {
    try {
      return parseKeywords(JSON.parse(s));
    } catch {
      /* 아래 쉼표 분리로 */
    }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

export async function scanGovBizAnnouncements({
  sources = "both",
  since,
  until,
  keywords,
  matchAll = false,
  limit = 100,
  mssDateResolution = "range",
  msitMaxPages = 15,
} = {}) {
  const untilIso = toIsoDate(until) || kstToday();
  const sinceIso = toIsoDate(since) || addDays(untilIso, -30);
  if ((since && !toIsoDate(since)) || (until && !toIsoDate(until))) {
    return { ok: false, 안내: "since·until은 YYYYMMDD(또는 YYYY-MM-DD, YYYYMMDDHHMM) 형식이어야 합니다." };
  }
  if (sinceIso > untilIso) return { ok: false, 안내: `since(${sinceIso})가 until(${untilIso})보다 늦습니다.` };
  const kwParsed = parseKeywords(keywords);
  const kws = matchAll ? [] : kwParsed && kwParsed.length ? kwParsed : DEFAULT_KEYWORDS;
  msitMaxPages = Math.max(1, Math.min(60, Number(msitMaxPages) || 15));
  limit = Math.max(1, Math.min(500, Number(limit) || 100));

  const want = sources === "both" ? ["msit", "mss"] : [sources];
  // Vercel maxDuration 60초 안에서 응답하도록 서버 예산을 둔다(페이지 넘김·하루 단위 재조회가 길어질 수 있음).
  const deadline = Date.now() + 45000;
  const [msit, mss] = await Promise.all([
    want.includes("msit") ? scanMsit({ since: sinceIso, until: untilIso, maxPages: msitMaxPages, deadline }) : null,
    want.includes("mss") ? scanMss({ since: sinceIso, until: untilIso, dateResolution: mssDateResolution, deadline }) : null,
  ]);

  const all = [...(msit?.items || []), ...(mss?.items || [])];
  // 키워드는 제목에만 건다(scan_narajangteo_procurement와 같은 규칙, 대소문자 무시 부분일치).
  const matched = kws.length
    ? all
        .map((x) => ({ ...x, 매칭키워드: kws.filter((k) => matchesKeywords(x.제목, [k])) }))
        .filter((x) => x.매칭키워드.length)
    : all;
  // 정렬: 공고일 있는 것 최신순 → 공고일 없는 중기부 건은 itemId 내림차순
  matched.sort((a, b) => {
    if (a.공고일 && b.공고일) return b.공고일.localeCompare(a.공고일);
    if (a.공고일) return -1;
    if (b.공고일) return 1;
    return Number(b.id) - Number(a.id);
  });
  const returned = matched.slice(0, limit);

  const strip = (s) => (s ? (({ items, ...rest }) => rest)(s) : null);
  const out = {
    ok: true,
    since: sinceIso,
    until: untilIso,
    keywords: kws.length ? kws : "(전체 — 키워드 필터 없음)",
    키워드필터: "서버 측(제목 부분일치, 대소문자 무시). 두 원 API 모두 키워드 파라미터가 없거나 무시됩니다.",
    소스별: { ...(msit ? { 과기정통부: strip(msit) } : {}), ...(mss ? { 중기부: strip(mss) } : {}) },
    수집건수: all.length,
    매칭건수: matched.length,
    반환건수: returned.length,
    items: returned,
  };
  if (matched.length > returned.length) {
    out.반환잘림 = `★ 매칭 ${matched.length}건 중 limit(${limit})만큼만 담았습니다. 건수 집계는 매칭건수를 쓰세요.`;
  }
  const errs = [...(msit?.errors || []), ...(mss?.errors || [])];
  if (errs.length) {
    out.유의사항 = [
      `★ 조회 오류가 ${errs.length}건 있습니다(소스별.*.errors). 해당 소스의 0건·누락은 '공고가 없다'는 뜻이 아닙니다.`,
    ];
  }
  if (msit?.잘림 || mss?.잘림) {
    out.잘림 = true;
    (out.유의사항 ||= []).push("★ 일부 소스가 구간 전체를 받지 못했습니다(소스별.*.유의사항). 이 결과로 건수를 단정하지 마세요.");
  }
  return out;
}
