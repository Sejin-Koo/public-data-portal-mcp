// scripts/refresh-cntrct-cache.mjs
// ────────────────────────────────────────────────────────────────────────────
// 나라장터 **계약정보 중 공동계약(컨소시엄)만** 하루 단위로 받아 data/cntrct/ 에 월별로 저장한다.
//
// ★ 왜 필요한가 (2026-11-25)
//   "이 회사가 다른 회사 컨소시엄의 구성원으로 들어간 수주"는 낙찰정보(대표사만)에 없고, 계약정보를
//   업체로 걸러야만 나온다. 그런데 원 API에는 업체 조건이 없어 기간 안의 계약 전부를 받아 걸러야 한다.
//   실측(2026-11-18 하루): 용역 2,642·공사 3,096·물품 1,489·외자 2건 — 하루 7천 건이 넘어 1년을
//   실시간으로 거르면 시간 초과·잘림으로 끝났다(비교 시험 22-5절, 계정·에이전트 모두).
//   → 매일 전량을 받아 공동계약(같은 날 165건, 2.3%)만 남겨 두고, 조회 도구가 이 파일에서 거른다.
//
// ★ 실측 근거
//   - numOfRows 상한 999(2000을 주면 에러 없이 10행으로 되돌아감).
//   - inqryDiv=1 + inqryBgnDate/inqryEndDate = 계약체결일 기준(받은 행의 체결일이 모두 조회일).
//   - 등록 지연(등록일 − 체결일, 2026-09-15 체결분): 7일 안 93~95%, 30일 안 98%, 60일 안 99.6%, 최대 71일.
//     → 매일 최근 7일을 다시 받고, 일요일에는 최근 60일을 다시 받는다.
//   - 일일 한도는 오퍼레이션(업무구분)마다 따로다. 429가 오면 그 업무구분만 멈추고 나머지는 계속한다.
//
// ★ 파일
//   data/cntrct/YYYYMM.json.gz — { month, rows: [원 필드 일부 + _d(체결 조회일) + _t(업무구분)] }
//   data/cntrct/manifest.json  — { builtAt, retainMonths, days: { YYYYMMDD: { 용역: {total, joint, at}, … } } }
//   하루·업무구분을 다시 받으면 그 칸의 행을 통째로 바꾼다(실패하면 기존 행을 그대로 둔다).
//
// 사용법
//   node scripts/refresh-cntrct-cache.mjs                  최근 7일(일요일 60일) + 빈 날 채우기(예산 안)
//   node scripts/refresh-cntrct-cache.mjs --recent 3 --budget 0      최근 3일만
//   node scripts/refresh-cntrct-cache.mjs --from 20261101 --to 20261118   지정 구간(시험용)
//
// 환경변수: DATA_PORTAL_KEY. 키 값은 어디에도 출력하지 않는다.
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "data", "cntrct");
const KEY = process.env.DATA_PORTAL_KEY || "";
const BASE = "https://apis.data.go.kr/1230000/ao/CntrctInfoService";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const OPS = {
  용역: "getCntrctInfoListServcPPSSrch",
  공사: "getCntrctInfoListCnstwkPPSSrch",
  물품: "getCntrctInfoListThngPPSSrch",
  외자: "getCntrctInfoListFrgcptPPSSrch",
};
const PAGE = 999;
// 보관 = 이번 달 + 직전 24개월(사용자 결정 2026-11-25, 낙찰 수집본과 같다).
const RETAIN_MONTHS = 25;
const KEEP_FIELDS = [
  "untyCntrctNo", "bsnsDivNm", "dcsnCntrctNo", "cntrctRefNo", "cntrctNm", "ntceNo", "cmmnCntrctYn",
  "lngtrmCtnuDivNm", "cntrctCnclsDate", "cntrctPrd", "totCntrctAmt", "thtmCntrctAmt", "cntrctCnclsMthdNm",
  "cntrctInsttNm", "dminsttList", "corpList", "cntrctDtlInfoUrl", "rgstDt",
];

// ── 인자 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const NOW = kstNow();
const SUNDAY = NOW.getUTCDay() === 0;
const RECENT = Number(argVal("--recent", SUNDAY ? 60 : 7));
// 빈 날 채우기에 쓸 호출 수 — 업무구분마다 따로 센다(일일 한도가 업무구분(오퍼레이션)별 1,000회라서).
// 첫 실행(2026-11-25)에서 합계로 셌더니 하루 1회면 되는 외자가 예산을 다 써 용역·공사는 24일만 채웠다.
// 같은 키를 실시간 조회 도구(get_narajangteo_contract 공고번호 조회 등)도 쓰므로, 수집이 하루 한도를 다 쓰면
// 그날 실시간 조회가 429로 막힌다(2026-11-25 첫 채우기 날 실측 — 용역 공고번호 조회 7회가 모두 429).
// → 채우기는 업무구분마다 500회, 최근 재수신을 합친 하루 총량은 650회로 막아 실시간 몫을 남긴다.
const BUDGET = Number(argVal("--budget", 500));
const CAP = Number(argVal("--cap", 650)); // 업무구분별 이번 실행 총 호출 상한(최근 재수신 + 채우기)
const MAX_MIN = Number(argVal("--max-minutes", 270));
const FROM = argVal("--from", null);
const TO = argVal("--to", null);
const TYPES = String(argVal("--types", "용역,공사,물품,외자")).split(",").map((s) => s.trim()).filter((t) => OPS[t]);

if (!KEY) {
  console.error("DATA_PORTAL_KEY 환경변수가 없습니다.");
  process.exit(1);
}

// ── 날짜 ────────────────────────────────────────────────────────────────────
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const dayAdd = (s, n) => ymd(new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + n)));
const TODAY = ymd(NOW);
const ym = (s) => s.slice(0, 6);
function addMonth(yyyymm, n) {
  const d = new Date(Date.UTC(+yyyymm.slice(0, 4), +yyyymm.slice(4, 6) - 1 + n, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const FIRST_MONTH = addMonth(ym(TODAY), -(RETAIN_MONTHS - 1));
const FIRST_DAY = `${FIRST_MONTH}01`;

// ── 저장소 ──────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const MANIFEST = join(OUT_DIR, "manifest.json");
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf-8")) : { days: {} };
manifest.days ||= {};
const months = new Map(); // YYYYMM → { month, rows }
const dirty = new Set();
function monthObj(m) {
  if (months.has(m)) return months.get(m);
  const p = join(OUT_DIR, `${m}.json.gz`);
  const obj = existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString("utf-8")) : { month: m, rows: [] };
  months.set(m, obj);
  return obj;
}

// ── 호출 ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const limited = new Set(); // 일일 한도에 걸린 업무구분
const calls = {};
const started = Date.now();
const timeUp = () => Date.now() - started > MAX_MIN * 60000;

function itemsOf(j) {
  const it = j?.response?.body?.items;
  if (Array.isArray(it)) return it;
  if (Array.isArray(it?.item)) return it.item;
  if (it?.item) return [it.item];
  return [];
}

async function callPage(type, day, pageNo) {
  const q = new URLSearchParams({
    ServiceKey: KEY, type: "json", numOfRows: String(PAGE), pageNo: String(pageNo),
    inqryDiv: "1", inqryBgnDate: day, inqryEndDate: day,
  }).toString();
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (limited.has(type)) return { ok: false, code: "RATELIMIT" };
    calls[type] = (calls[type] || 0) + 1;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(`${BASE}/${OPS[type]}?${q}`, { headers: { "User-Agent": UA }, signal: ctl.signal });
      const text = await res.text();
      clearTimeout(t);
      if (res.status === 429) {
        limited.add(type);
        return { ok: false, code: "RATELIMIT" };
      }
      if (res.status !== 200 || !text) {
        last = res.status !== 200 ? `HTTP ${res.status}` : "빈 본문";
        await sleep(2000 * (attempt + 1));
        continue;
      }
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text)) {
          limited.add(type);
          return { ok: false, code: "RATELIMIT" };
        }
        last = `JSON 아님: ${text.slice(0, 80)}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      // 오류 응답은 response.header가 아니라 최상위 "nkoneps.com.response.ResponseError".header로 온다(실측 2026-11-25:
      // 7일 이상 구간 → 07). 예전 코드는 header를 못 찾으면 ""를 "00"으로 채워 0건 정상으로 읽었다 — 11-16 낙찰 갱신이
      // 9~11월 창을 0행으로 덮은 원인. header가 없으면 오류로 다룬다.
      const hdr = j?.response?.header ?? j?.["nkoneps.com.response.ResponseError"]?.header;
      if (!hdr || hdr.resultCode === undefined || hdr.resultCode === null || hdr.resultCode === "") {
        last = `응답 머리 없음: ${text.slice(0, 120)}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      const code = String(hdr.resultCode).padStart(2, "0");
      if (code === "03") return { ok: true, items: [], total: 0 };
      if (code === "22") {
        limited.add(type);
        return { ok: false, code: "RATELIMIT" };
      }
      if (code !== "00") {
        last = `resultCode ${code} ${hdr.resultMsg ?? ""}`;
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

const corpCount = (s) => String(s || "").split(/\]\s*,\s*\[/).filter((x) => x.replace(/[[\]]/g, "").trim()).length;
const isJoint = (it) => it.cmmnCntrctYn === "Y" || corpCount(it.corpList) > 1;

/** 하루 × 업무구분 하나를 끝까지 받아 공동계약만 저장한다. 실패하면 기존 행을 건드리지 않는다. */
async function fetchDay(type, day) {
  const all = [];
  let total = 0;
  for (let p = 1; p < 100; p++) {
    const r = await callPage(type, day, p);
    if (!r.ok) return { ok: false, err: r.code === "RATELIMIT" ? "RATELIMIT" : r.msg };
    if (p === 1) total = r.total;
    all.push(...r.items);
    if (r.items.length < PAGE) break;
  }
  if (all.length < total) return { ok: false, err: `받은 ${all.length} < 전체 ${total}` };
  const joint = all.filter(isJoint).map((it) => {
    const o = { _d: day, _t: type };
    for (const k of KEEP_FIELDS) if (it[k] !== undefined && it[k] !== null && it[k] !== "") o[k] = it[k];
    return o;
  });
  const mo = monthObj(ym(day));
  mo.rows = mo.rows.filter((r) => !(r._d === day && r._t === type)).concat(joint);
  dirty.add(ym(day));
  manifest.days[day] ||= {};
  manifest.days[day][type] = { total, joint: joint.length, at: new Date().toISOString() };
  return { ok: true, total, joint: joint.length };
}

// ── 작업 목록 ────────────────────────────────────────────────────────────────
const tasks = []; // { day, type, kind }
const seen = new Set();
const push = (day, type, kind) => {
  const k = `${day}|${type}`;
  if (seen.has(k) || day < FIRST_DAY || day > TODAY) return;
  seen.add(k);
  tasks.push({ day, type, kind });
};
if (FROM) {
  for (let d = FROM; d <= (TO || FROM); d = dayAdd(d, 1)) for (const t of TYPES) push(d, t, "지정");
} else {
  for (let i = 0; i <= RECENT; i++) for (const t of TYPES) push(dayAdd(TODAY, -i), t, "최근");
  if (BUDGET > 0) for (let d = dayAdd(TODAY, -(RECENT + 1)); d >= FIRST_DAY; d = dayAdd(d, -1))
    for (const t of TYPES) if (!manifest.days[d]?.[t]) push(d, t, "채우기");
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const stat = { 최근: 0, 채우기: 0, 지정: 0, 실패: 0, 한도: 0, 예산초과: 0 };
const failures = [];
const fillCalls = {};
// 업무구분마다 따로 차례를 돈다(한도가 업무구분별이라 한쪽이 막혀도 다른 쪽은 계속).
await Promise.all(TYPES.map(async (type) => {
  for (const task of tasks.filter((x) => x.type === type)) {
    if (limited.has(type)) { stat.한도++; continue; }
    if ((calls[type] || 0) >= CAP) { stat.예산초과++; continue; }
    if (timeUp()) { stat.예산초과++; continue; }
    if (task.kind === "채우기" && (fillCalls[type] || 0) >= BUDGET) { stat.예산초과++; continue; }
    const before = calls[type] || 0;
    const r = await fetchDay(type, task.day);
    if (task.kind === "채우기") fillCalls[type] = (fillCalls[type] || 0) + (calls[type] || 0) - before;
    if (r.ok) stat[task.kind]++;
    else if (r.err === "RATELIMIT") stat.한도++;
    else { stat.실패++; failures.push(`${task.day} ${type}: ${r.err}`); }
  }
}));

// ── 보관 기간 밖 정리 ────────────────────────────────────────────────────────
let pruned = 0;
for (const f of readdirSync(OUT_DIR)) {
  const m = f.match(/^(\d{6})\.json\.gz$/);
  if (m && m[1] < FIRST_MONTH) { unlinkSync(join(OUT_DIR, f)); pruned++; }
}
for (const d of Object.keys(manifest.days)) if (d < FIRST_DAY) delete manifest.days[d];

// ── 저장 ────────────────────────────────────────────────────────────────────
for (const m of dirty) {
  const mo = months.get(m);
  mo.rows.sort((a, b) => (a._d + a._t + (a.dcsnCntrctNo || "")).localeCompare(b._d + b._t + (b.dcsnCntrctNo || "")));
  writeFileSync(join(OUT_DIR, `${m}.json.gz`), gzipSync(Buffer.from(JSON.stringify(mo)), { level: 9 }));
}
const doneDays = Object.keys(manifest.days).filter((d) => TYPES.every((t) => manifest.days[d][t])).sort();
manifest.builtAt = new Date().toISOString();
manifest.retainMonths = RETAIN_MONTHS;
manifest.firstDay = FIRST_DAY;
manifest.coverage = { 완료일수: doneDays.length, 처음: doneDays[0] || null, 마지막: doneDays[doneDays.length - 1] || null };
writeFileSync(MANIFEST, JSON.stringify(manifest));

const summary = {
  작업: tasks.length, ...stat, 호출: calls, 한도걸린업무구분: [...limited], 정리한월파일: pruned,
  고친월: [...dirty].sort(), 수집범위: manifest.coverage, 실패내역: failures.slice(0, 20),
};
console.log(JSON.stringify(summary, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, "```json\n" + JSON.stringify(summary, null, 1) + "\n```\n", { flag: "a" });
}
