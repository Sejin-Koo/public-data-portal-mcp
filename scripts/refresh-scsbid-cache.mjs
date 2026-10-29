// scripts/refresh-scsbid-cache.mjs
// ────────────────────────────────────────────────────────────────────────────
// 나라장터 공사·용역 **낙찰정보를 월 단위로 미리 받아** data/scsbid/ 에 저장한다.
// 같은 공고의 **입찰공고정보(공사현장 지역·주공종·부공종·추정가격·계약방법)** 와
// **참가가능지역**을 공고번호로 붙여 둔다.
//
// ★ 왜 필요한가 (2026-10-29)
//   "최근 2년 경기도 기계설비공사 많이 한 업체" 같은 질문은 실시간 검색 도구로 답하려면
//   공고명 키워드 × 지역 조건 × 24개월을 따로 불러야 해서 원천 호출이 수백 회가 된다
//   (실측: 384회). 검색형 오퍼레이션 일일 한도 1,000회를 계정과 모든 에이전트 사용자가
//   나눠 쓰므로 질문 하나가 한도의 40%를 쓴다. 그리고 낙찰정보 응답에는 **현장 지역이
//   없어** 수요기관명에 지역명이 없는 학교·대학·공공기관 발주가 조용히 빠졌다
//   (실측: 시흥 소재 대학의 냉난방기 교체 3.70억원 누락).
//   → 월 단위 전량을 기본형 오퍼레이션으로 한 번 받아 두고, 키워드·지역·공종 필터는
//     서버(lib/scsbid_cache.js) 안에서 건다. 공고정보의 공사현장 지역(cnstrtsiteRgnNm)과
//     주공종(mainCnsttyNm)을 붙여 두면 지역·공종 판정이 공고명·기관명에 기대지 않는다.
//
// ★ 파일 단위 = 업무구분 × "개찰예정 월" 창
//   원 API의 기간 필터는 공고상 개찰(예정)일시로 걸리고 실개찰일시는 연기될 수 있다.
//   그래서 파일은 조회 창(개찰예정 월) 단위로 저장하고, 조회 도구가 실개찰일시로 다시
//   거르면서 인접 창 사이 중복을 제거한다.
//
// ★ 공고정보는 git에 저장하지 않는다
//   낙찰 행에 필요한 칸만 붙여 넣고, 원본 공고 목록은 Actions 캐시(.cache/scsbid)에만 둔다.
//   공고 목록까지 커밋하면 저장소 이력이 매 실행마다 수 MB씩 늘어난다.
//
// 사용법
//   node scripts/refresh-scsbid-cache.mjs --backfill 25        최근 25개 창(이번 달 포함) 전부
//   node scripts/refresh-scsbid-cache.mjs --months 3           최근 3개 창만 다시 받기(기본)
//   node scripts/refresh-scsbid-cache.mjs --months 1 --types cnstwk   공사만
//
// 환경변수: DATA_PORTAL_KEY (공공데이터포털 공용키). 키 값은 어디에도 출력하지 않는다.
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "data", "scsbid");
const CACHE_DIR = join(ROOT, ".cache", "scsbid");

const KEY = process.env.DATA_PORTAL_KEY || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const S = "https://apis.data.go.kr/1230000/as/ScsbidInfoService";
const B = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";

// 원 API 페이지 상한(실측 2026-09-01: 999까지 전량, 2000은 10행으로 되돌아감).
const PAGE = 999;
// 보존 창 수 — 이번 달 + 직전 24개월. 사용자 결정(2026-10-29): 24개월.
const RETAIN_WINDOWS = 25;
// 낙찰 창 W의 공고는 W-3 ~ W 사이에 등록된 것으로 본다(입찰공고→개찰 기간이 3개월을 넘는
// 건은 드물다. 넘으면 그 행은 공고정보 없이 저장되고 조회 도구가 '공고 미연결'로 센다).
const NOTICE_LOOKBACK = 3;
const CONCURRENCY = 5;

const TYPES = {
  cnstwk: { name: "공사", award: "getScsbidListSttusCnstwk", notice: "getBidPblancListInfoCnstwk", rgnDiv: "공사" },
  servc: { name: "용역", award: "getScsbidListSttusServc", notice: "getBidPblancListInfoServc", rgnDiv: "용역" },
};

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const BACKFILL = argv.includes("--backfill") ? Number(argVal("--backfill", RETAIN_WINDOWS)) : 0;
const MONTHS = BACKFILL || Number(argVal("--months", 3));
// 백필을 이틀로 나눌 때 쓴다(참가가능지역·면허제한 오퍼레이션은 한 달에 30여 쪽이라 25개 창을 하루에 받으면
// 일일 한도 1,000회에 닿는다). --skip 12 = 최근 12개 창을 건너뛰고 그 앞부터.
const SKIP = Number(argVal("--skip", 0));
const TYPE_KEYS = String(argVal("--types", "cnstwk,servc"))
  .split(",")
  .map((s) => s.trim())
  .filter((k) => TYPES[k]);

if (!KEY) {
  console.error("DATA_PORTAL_KEY 환경변수가 없습니다.");
  process.exit(1);
}

// ── 날짜 ────────────────────────────────────────────────────────────────────
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function ym(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function addMonth(yyyymm, n) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6)) - 1 + n;
  const d = new Date(Date.UTC(y, m, 1));
  return ym(d);
}
function monthRange(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${yyyymm}010000`, to: `${yyyymm}${String(last).padStart(2, "0")}2359` };
}
const THIS_MONTH = ym(kstNow());

// ── 호출 ────────────────────────────────────────────────────────────────────
let rateLimited = false;
const callCount = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function itemsOf(j) {
  const it = j?.response?.body?.items;
  if (Array.isArray(it)) return it;
  if (Array.isArray(it?.item)) return it.item;
  if (it?.item) return [it.item];
  return [];
}

async function callPage(base, op, params) {
  const q = new URLSearchParams({ ServiceKey: KEY, type: "json", numOfRows: String(PAGE), ...params }).toString();
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (rateLimited) return { ok: false, code: "RATELIMIT" };
    callCount[op] = (callCount[op] || 0) + 1;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(`${base}/${op}?${q}`, { headers: { "User-Agent": UA }, signal: ctl.signal });
      const text = await res.text();
      clearTimeout(t);
      if (res.status === 429) {
        rateLimited = true;
        return { ok: false, code: "RATELIMIT" };
      }
      if (res.status !== 200) {
        last = `HTTP ${res.status}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!text) {
        last = "빈 본문";
        await sleep(2000 * (attempt + 1));
        continue;
      }
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        last = `JSON 아님: ${text.slice(0, 80)}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const code = String(j?.response?.header?.resultCode ?? "").padStart(2, "0");
      if (code === "03") return { ok: true, items: [], total: 0 };
      if (code !== "00") {
        last = `resultCode ${code} ${j?.response?.header?.resultMsg ?? ""}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { ok: true, items: itemsOf(j), total: Number(j?.response?.body?.totalCount ?? 0) };
    } catch (e) {
      last = e.name === "AbortError" ? "timeout 60s" : e.message;
      await sleep(2000 * (attempt + 1));
    }
  }
  return { ok: false, code: "ERR", msg: last };
}

/** 한 오퍼레이션 × 한 달 창을 끝까지 받는다. */
async function fetchMonth(base, op, yyyymm, inqryDiv, label) {
  const { from, to } = monthRange(yyyymm);
  const rows = [];
  let total = 0;
  for (let page = 1; page < 200; page++) {
    const r = await callPage(base, op, { inqryDiv: String(inqryDiv), inqryBgnDt: from, inqryEndDt: to, pageNo: String(page) });
    if (!r.ok) return { ok: false, rows, total, err: r.code === "RATELIMIT" ? "RATELIMIT" : r.msg };
    if (page === 1) total = r.total;
    rows.push(...r.items);
    if (r.items.length < PAGE) break;
  }
  const t = Date.now();
  console.log(`  ${label} ${yyyymm}: ${rows.length}/${total}행`);
  return { ok: true, rows, total, at: t };
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < tasks.length) {
        const k = i++;
        out[k] = await tasks[k]();
      }
    })
  );
  return out;
}

// ── 캐시(Actions 캐시에 남는 공고·지역 원본) ───────────────────────────────
function cachePath(kind, yyyymm) {
  return join(CACHE_DIR, `${kind}-${yyyymm}.json.gz`);
}
function readCache(kind, yyyymm) {
  const p = cachePath(kind, yyyymm);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(p)).toString("utf-8"));
  } catch {
    return null;
  }
}
function writeCache(kind, yyyymm, obj) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(kind, yyyymm), gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 }));
}
// 지난 지 2개월이 넘은 달의 공고 등록은 더 바뀌지 않는다고 보고 캐시를 그대로 쓴다.
function closedMonth(yyyymm) {
  return yyyymm <= addMonth(THIS_MONTH, -2);
}

// ── 공고정보 정리 ───────────────────────────────────────────────────────────
const nz = (v) => (v === undefined || v === null ? "" : String(v).trim());

function noticeSlim(it) {
  const subs = [];
  for (let k = 1; k <= 9; k++) {
    const v = nz(it[`subsiCnsttyNm${k}`]);
    if (v) subs.push(v);
  }
  return {
    o: Number(it.bidNtceOrd) || 0,
    site: nz(it.cnstrtsiteRgnNm),
    main: nz(it.mainCnsttyNm),
    subs: subs.join("|"),
    price: Number(it.presmptPrce) || 0,
    ntce: nz(it.ntceInsttNm),
    cntrct: nz(it.cntrctCnclsMthdNm),
    sucsf: nz(it.sucsfbidMthdNm),
    jv: nz(it.cmmnSpldmdMethdNm),
    // 용역 분류(있으면). 필드명이 응답에 없으면 빈 값이다.
    cls: nz(it.pubPrcrmntClsfcNm || it.pubPrcrmntMidClsfcNm || it.pubPrcrmntLrgClsfcNm || it.srvceDivNm),
  };
}

let loggedNoticeKeys = {};

async function getNotices(tk, yyyymm) {
  const kind = `notice-${tk}`;
  if (closedMonth(yyyymm)) {
    const c = readCache(kind, yyyymm);
    if (c) return { ok: true, map: c.map, cached: true };
  }
  const t = TYPES[tk];
  const r = await fetchMonth(B, t.notice, yyyymm, 1, `공고(${t.name})`);
  if (!r.ok) return { ok: false, err: r.err };
  if (!loggedNoticeKeys[tk] && r.rows[0]) {
    loggedNoticeKeys[tk] = true;
    console.log(`  공고(${t.name}) 응답 필드: ${Object.keys(r.rows[0]).join(",")}`);
  }
  const map = {};
  for (const it of r.rows) {
    const no = nz(it.bidNtceNo);
    if (!no) continue;
    const s = noticeSlim(it);
    if (!map[no] || s.o >= map[no].o) map[no] = s;
  }
  writeCache(kind, yyyymm, { month: yyyymm, total: r.total, fetched: r.rows.length, map });
  return { ok: true, map, cached: false };
}

async function getRegions(yyyymm) {
  const kind = "region";
  if (closedMonth(yyyymm)) {
    const c = readCache(kind, yyyymm);
    if (c) return { ok: true, map: c.map, cached: true };
  }
  const r = await fetchMonth(B, "getBidPblancListInfoPrtcptPsblRgn", yyyymm, 1, "참가가능지역");
  if (!r.ok) return { ok: false, err: r.err };
  const map = {};
  for (const it of r.rows) {
    const no = nz(it.bidNtceNo);
    const rg = nz(it.prtcptPsblRgnNm);
    if (!no || !rg) continue;
    const div = nz(it.bsnsDivNm);
    const k = `${div}|${no}`;
    (map[k] = map[k] || []).includes(rg) || map[k].push(rg);
  }
  writeCache(kind, yyyymm, { month: yyyymm, total: r.total, fetched: r.rows.length, map });
  return { ok: true, map, cached: false };
}

async function getLicenses(yyyymm) {
  const kind = "license";
  if (closedMonth(yyyymm)) {
    const c = readCache(kind, yyyymm);
    if (c) return { ok: true, map: c.map, cached: true };
  }
  const r = await fetchMonth(B, "getBidPblancListInfoLicenseLimit", yyyymm, 1, "면허제한");
  if (!r.ok) return { ok: false, err: r.err };
  const map = {};
  for (const it of r.rows) {
    const no = nz(it.bidNtceNo);
    // "기계설비ㆍ가스공사업/6202" → 코드 떼고 이름만
    const nm = nz(it.lcnsLmtNm).replace(/\/[0-9A-Za-z]+$/, "");
    if (!no || !nm) continue;
    const k = `${nz(it.bsnsDivNm)}|${no}`;
    (map[k] = map[k] || []).includes(nm) || map[k].push(nm);
  }
  writeCache(kind, yyyymm, { month: yyyymm, total: r.total, fetched: r.rows.length, map });
  return { ok: true, map, cached: false };
}

// ── 낙찰 행 정리 ────────────────────────────────────────────────────────────
const COLS = [
  "공고번호", "공고차수", "분류번호", "재입찰번호", "공고명",
  "수요기관코드", "수요기관", "공고기관",
  "낙찰업체", "사업자번호", "대표자", "업체소재지",
  "낙찰금액", "낙찰률", "참가업체수", "실개찰일시",
  "현장지역", "주공종", "부공종", "참가가능지역",
  "추정가격", "계약방법", "낙찰방법", "공동수급", "분류", "면허제한", "테스트의심",
];

function shortAddr(a) {
  const p = nz(a).split(/\s+/).filter(Boolean);
  return p.slice(0, 2).join(" ");
}
function looksTest(it) {
  return (
    /^업체\d+$/.test(nz(it.bidwinnrNm).replace(/\s/g, "")) ||
    /테스트\s*[&＆]\s*기관/.test(nz(it.dminsttNm)) ||
    /^\s*\[SHR\]/.test(nz(it.bidNtceNm)) ||
    /^T\d{2}[A-Z]{2}\d+/.test(nz(it.bidNtceNo))
  );
}
const awardKey = (it) => [it.bidNtceNo, it.bidNtceOrd, it.bidClsfcNo, it.rbidNo].map(nz).join("|");

function buildRow(it, notice, regions, licenses) {
  const n = notice || {};
  return [
    nz(it.bidNtceNo), nz(it.bidNtceOrd), nz(it.bidClsfcNo), nz(it.rbidNo), nz(it.bidNtceNm),
    nz(it.dminsttCd), nz(it.dminsttNm), n.ntce || "",
    nz(it.bidwinnrNm), nz(it.bidwinnrBizno).replace(/[^0-9]/g, ""), nz(it.bidwinnrCeoNm), shortAddr(it.bidwinnrAdrs),
    Number(it.sucsfbidAmt) || 0,
    nz(it.sucsfbidRate) === "" ? null : Number(it.sucsfbidRate),
    Number(it.prtcptCnum) || 0,
    nz(it.rlOpengDt),
    n.site || "", n.main || "", n.subs || "", (regions || []).join("|"),
    n.price || 0, n.cntrct || "", n.sucsf || "", n.jv || "", n.cls || "",
    (licenses || []).join("|"),
    looksTest(it) ? 1 : 0,
  ];
}

// ── 메인 ────────────────────────────────────────────────────────────────────
const windows = [];
for (let k = SKIP; k < SKIP + MONTHS && k < RETAIN_WINDOWS; k++) windows.push(addMonth(THIS_MONTH, -k));
const noticeMonths = new Set();
for (const w of windows) for (let k = 0; k <= NOTICE_LOOKBACK; k++) noticeMonths.add(addMonth(w, -k));
const noticeList = [...noticeMonths].sort().reverse();

console.log(`대상 창: ${windows.join(", ")} / 업무구분: ${TYPE_KEYS.join(",")} / 공고 월: ${noticeList.length}개`);
mkdirSync(OUT_DIR, { recursive: true });

// 1) 참가가능지역(업무구분 공통)과 공고정보를 먼저 모은다.
const regionByMonth = {};
const licenseByMonth = {};
const noticeByType = Object.fromEntries(TYPE_KEYS.map((k) => [k, {}]));
const failures = [];

await pool(
  noticeList.map((m) => async () => {
    const r = await getRegions(m);
    if (r.ok) regionByMonth[m] = r.map;
    else failures.push(`참가가능지역 ${m}: ${r.err}`);
  }),
  CONCURRENCY
);
await pool(
  noticeList.map((m) => async () => {
    const r = await getLicenses(m);
    if (r.ok) licenseByMonth[m] = r.map;
    else failures.push(`면허제한 ${m}: ${r.err}`);
  }),
  CONCURRENCY
);
await pool(
  TYPE_KEYS.flatMap((tk) =>
    noticeList.map((m) => async () => {
      const r = await getNotices(tk, m);
      if (r.ok) noticeByType[tk][m] = r.map;
      else failures.push(`공고(${TYPES[tk].name}) ${m}: ${r.err}`);
    })
  ),
  CONCURRENCY
);

// 2) 낙찰 창을 받아 붙여서 저장한다.
const written = [];
const skipped = [];
await pool(
  TYPE_KEYS.flatMap((tk) =>
    windows.map((w) => async () => {
      const t = TYPES[tk];
      // 필요한 공고 월 중 하나라도 실패했으면 이 창은 덮어쓰지 않는다(기존 파일 보존).
      const need = Array.from({ length: NOTICE_LOOKBACK + 1 }, (_, k) => addMonth(w, -k));
      const missing = need.filter((m) => !noticeByType[tk][m] || !regionByMonth[m] || !licenseByMonth[m]);
      if (missing.length) {
        skipped.push(`${t.name} ${w}: 공고·지역 정보 미수집(${missing.join(",")})`);
        return;
      }
      const r = await fetchMonth(S, t.award, w, 3, `낙찰(${t.name})`);
      if (!r.ok) {
        failures.push(`낙찰(${t.name}) ${w}: ${r.err}`);
        return;
      }
      const seen = new Set();
      const rows = [];
      let joined = 0;
      let withMain = 0;
      let withRgn = 0;
      let withLic = 0;
      for (const it of r.rows) {
        const key = awardKey(it);
        if (seen.has(key)) continue;
        seen.add(key);
        const no = nz(it.bidNtceNo);
        let notice = null;
        let regions = null;
        let licenses = null;
        for (const m of need) {
          if (!licenses && licenseByMonth[m][`${t.rgnDiv}|${no}`]) licenses = licenseByMonth[m][`${t.rgnDiv}|${no}`];
          if (!notice && noticeByType[tk][m][no]) notice = noticeByType[tk][m][no];
          if (!regions && regionByMonth[m][`${t.rgnDiv}|${no}`]) regions = regionByMonth[m][`${t.rgnDiv}|${no}`];
        }
        if (notice) joined++;
        if (notice && notice.main) withMain++;
        if (regions) withRgn++;
        if (licenses) withLic++;
        rows.push(buildRow(it, notice, regions, licenses));
      }
      rows.sort((a, b) => (a[0] + a[1] + a[2] + a[3]).localeCompare(b[0] + b[1] + b[2] + b[3]));
      const payload = {
        v: 1,
        type: t.name,
        window: w,
        award: { total: r.total, fetched: r.rows.length, unique: rows.length, complete: r.rows.length >= r.total },
        join: { notice: joined, missing: rows.length - joined, mainCnstty: withMain, region: withRgn, license: withLic, noticeMonths: need },
        cols: COLS,
        rows,
      };
      const buf = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
      writeFileSync(join(OUT_DIR, `${tk}-${w}.json.gz`), buf);
      written.push(`${t.name} ${w}: ${rows.length}건, 공고연결 ${joined} · 주공종 ${withMain} · 참가가능지역 ${withRgn} · 면허제한 ${withLic}, ${(buf.length / 1024).toFixed(0)}KB`);
    })
  ),
  CONCURRENCY
);

// 3) 보존기간 밖 창 삭제 + 목록(manifest) 갱신
const oldest = addMonth(THIS_MONTH, -(RETAIN_WINDOWS - 1));
const removed = [];
for (const f of readdirSync(OUT_DIR)) {
  const m = f.match(/^(cnstwk|servc)-(\d{6})\.json\.gz$/);
  if (m && m[2] < oldest) {
    unlinkSync(join(OUT_DIR, f));
    removed.push(f);
  }
}
const manifest = { updated: kstNow().toISOString().slice(0, 16).replace("T", " ") + " KST", retainWindows: RETAIN_WINDOWS, files: {} };
let bytes = 0;
for (const f of readdirSync(OUT_DIR).sort()) {
  const m = f.match(/^(cnstwk|servc)-(\d{6})\.json\.gz$/);
  if (!m) continue;
  const p = JSON.parse(gunzipSync(readFileSync(join(OUT_DIR, f))).toString("utf-8"));
  const size = readFileSync(join(OUT_DIR, f)).length;
  bytes += size;
  const prev = (() => {
    try {
      return JSON.parse(readFileSync(join(OUT_DIR, "manifest.json"), "utf-8")).files[f];
    } catch {
      return null;
    }
  })();
  const builtNow = written.some((s) => s.startsWith(`${p.type} ${p.window}:`));
  manifest.files[f] = {
    type: p.type,
    window: p.window,
    rows: p.rows.length,
    complete: p.award.complete,
    noticeJoined: p.join.notice,
    mainCnstty: p.join.mainCnstty,
    license: p.join.license,
    kb: Math.round(size / 1024),
    builtAt: builtNow ? manifest.updated : prev?.builtAt ?? manifest.updated,
  };
}
manifest.totalKB = Math.round(bytes / 1024);
writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 1));

console.log("\n== 결과 ==");
for (const s of written) console.log("저장 " + s);
for (const s of skipped) console.log("건너뜀 " + s);
for (const s of failures) console.log("실패 " + s);
for (const s of removed) console.log("삭제 " + s);
console.log(`원천 호출 수: ${JSON.stringify(callCount)}`);
console.log(`data/scsbid 합계: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
if (rateLimited) console.log("::warning::요청한도(429)에 걸려 일부를 받지 못했습니다. 받은 창만 저장했습니다.");
if (failures.length && !written.length) process.exit(1);
