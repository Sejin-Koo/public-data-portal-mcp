// scripts/refresh-vehicle-cache.mjs
// ────────────────────────────────────────────────────────────────────────────
// 한국교통안전공단 신규등록(15059401) **월별 수집본**(data/vehicle/)을 만든다. (2026-11-26 사용자 결정)
//
// ★ 왜 필요한가
//   이 API는 조건 하나당 건수 하나만 준다. '최근 12개월 시도별 하이브리드 비중' 하나에 원 호출이 수백 회
//   들고, 일일 허용량(3,000회, 계정 공유)을 질문 몇 개로 다 쓴다(2026-11-26 답변 비교 시험에서 약 3,100회로
//   그날 오후 내내 막힘). 자주 묻는 세 축(차종·등록지역·사용연료)을 달마다 한 번 받아 두고, 조회 도구가
//   이 파일에서 답한다(lib/vehicle_cache.js).
//
// ★ 한 달에 받는 칸 (808회)
//   - 차종 4 × 등록지역 17 × 사용연료 11 = 748칸
//   - 지역 전체(지역 조건 없음) × 차종(4 + 전체) × 연료(11 + 전체) = 60칸
//     → 2026-07처럼 지역 코드 밖으로 빠진 몫이 있어도 전국 값이 맞게 남는다.
//   차종 전체·연료 전체는 코드 칸을 더해 만든다(2025-01 실측: 차종 4개 합 = 연료 11개 합 = 전체).
//
// ★ 언제 받나
//   - 당월분은 익월 2일부터 조회된다. 그 전 달은 받지 않는다.
//   - 받은 달은 그다음 달(M+2) 1일 이후에 한 번 더 받아 '확정'으로 바꾼다(늦은 신고 반영).
//   - 보관: 이번 달 기준 지난 24개월. 그보다 오래된 파일은 지운다(prune).
//   - 우선순위: 아직 없는 최근 달 → 확정할 달 → 빈 옛 달(최근부터).
//   - 한 번 실행에 쓰는 호출은 --budget(기본 1700 — 두 달). 한 달을 다 받을 예산이 없으면 시작하지 않는다.
//     일일 허용량 초과(코드 22)를 받으면 그 달은 버리고 멈춘다(받은 데까지만 저장).
//
// ★ 파일
//   data/vehicle/YYYYMM.json — { month, fetchedAt, final, cube: { "t|r|f": 건수 } }  (t·r·f는 코드 또는 *)
//   data/vehicle/manifest.json — { builtAt, retainMonths, months: { YYYYMM: { fetchedAt, final, calls } } }
//
// 사용법
//   node scripts/refresh-vehicle-cache.mjs                   예산 안에서 위 우선순위대로
//   node scripts/refresh-vehicle-cache.mjs --budget 808      한 달만
//   node scripts/refresh-vehicle-cache.mjs --month 202610    지정 달(시험용, 확정 여부 무시하고 다시 받음)
//
// 환경변수: DATA_PORTAL_KEY. 키 값은 어디에도 출력하지 않는다. 외부 패키지를 쓰지 않는다.
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "data", "vehicle");
const KEY = process.env.DATA_PORTAL_KEY || "";
const BASE = "https://apis.data.go.kr/B553881/newRegistlnfoService_02/getnewRegistlnfoService02"; // ★ lnfo(소문자 L)
const RETAIN = 24;
const CONC = 3;
const T = ["1", "2", "3", "4"];
const R = Array.from({ length: 17 }, (_, i) => String(i + 1));
const F = Array.from({ length: 11 }, (_, i) => String(i + 1));
const PER_MONTH = T.length * R.length * F.length + (T.length + 1) * (F.length + 1);

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BUDGET = Number(arg("--budget", "1700"));
const ONLY = arg("--month", "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function kstNow() { return new Date(Date.now() + 9 * 3600e3); }
function ymOf(d) { return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function ymAdd(ym, n) { const y = +ym.slice(0, 4), m = +ym.slice(4) - 1 + n; return `${y + Math.floor(m / 12)}${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`; }

class QuotaError extends Error {}

async function fetchCount(params) {
  const q = new URLSearchParams({ serviceKey: KEY, ...params }).toString();
  let last;
  for (let a = 0; a < 4; a++) {
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(`${BASE}?${q}`, { headers: { "User-Agent": "Mozilla/5.0 (vehicle-cache)" }, signal: ctl.signal });
      const body = new TextDecoder("utf-8").decode(await res.arrayBuffer());
      clearTimeout(tm);
      if (/PER_SECOND|<returnReasonCode>\s*23\s*</.test(body)) { last = new Error("초당 제한(23)"); await sleep(2000 * (a + 1)); continue; }
      if (/LIMITED_NUMBER_OF_SERVICE_REQUESTS|<returnReasonCode>\s*22\s*</.test(body)) throw new QuotaError("일일 허용량 초과(22)");
      if (res.status === 429) { last = new Error("HTTP 429"); await sleep(3000 * (a + 1)); continue; }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (/NODATA_ERROR/.test(body) || /<dtaCo\s*\/>/.test(body)) return 0;
      const m = body.match(/<dtaCo>\s*(\d+)\s*<\/dtaCo>/);
      if (m) return Number(m[1]);
      throw new Error("dtaCo 없음: " + body.slice(0, 120).replace(KEY, "***"));
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      last = e;
      await sleep(800 * (a + 1));
    }
  }
  if (last && /429/.test(last.message)) throw new QuotaError("429가 계속됨(일일 허용량 소진으로 보고 멈춤)");
  throw last || new Error("알 수 없는 오류");
}

async function fetchMonth(ym) {
  const base = { registYy: ym.slice(0, 4), registMt: ym.slice(4) };
  const jobs = [];
  for (const t of T) for (const r of R) for (const f of F) jobs.push({ key: `${t}|${r}|${f}`, p: { ...base, vhctyAsortCode: t, registGrcCode: r, useFuelCode: f } });
  for (const t of [...T, "*"]) for (const f of [...F, "*"]) {
    const p = { ...base };
    if (t !== "*") p.vhctyAsortCode = t;
    if (f !== "*") p.useFuelCode = f;
    jobs.push({ key: `${t}|*|${f}`, p });
  }
  const cube = {};
  let idx = 0, err = null, calls = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (!err) {
      const i = idx++;
      if (i >= jobs.length) return;
      try { calls++; cube[jobs[i].key] = await fetchCount(jobs[i].p); }
      catch (e) { err = err || e; }
    }
  }));
  return { cube, err, calls };
}

function check(ym, cube) {
  // 차종 4개 합 = 지역 전체 합계, 연료 11개 합 = 지역 전체 합계 — 수집본이 맞게 받혔는지 확인
  const all = cube["*|*|*"];
  const sumT = T.reduce((s, t) => s + cube[`${t}|*|*`], 0);
  const sumF = F.reduce((s, f) => s + cube[`*|*|${f}`], 0);
  let sumCube = 0; for (const t of T) for (const r of R) for (const f of F) sumCube += cube[`${t}|${r}|${f}`];
  return { all, sumT, sumF, sumCube, ok: all === sumT && all === sumF };
}

async function main() {
  if (!KEY) { console.error("DATA_PORTAL_KEY 없음"); process.exit(1); }
  mkdirSync(OUT_DIR, { recursive: true });
  const manPath = join(OUT_DIR, "manifest.json");
  const man = existsSync(manPath) ? JSON.parse(readFileSync(manPath, "utf-8")) : { months: {} };
  man.months = man.months || {};

  const now = kstNow();
  const thisYm = ymOf(now);
  // 당월분은 익월 2일부터 — 오늘이 2일 이후면 지난달까지, 아니면 지지난달까지
  const latest = now.getUTCDate() >= 2 ? ymAdd(thisYm, -1) : ymAdd(thisYm, -2);
  const oldest = ymAdd(thisYm, -RETAIN);

  const want = [];
  if (ONLY) want.push(ONLY);
  else {
    const all = []; for (let ym = latest; ym >= oldest; ym = ymAdd(ym, -1)) all.push(ym);
    const missing = all.filter((ym) => !man.months[ym]);
    // 확정할 달: 아직 final이 아니고 M+2 1일이 지났음
    const tofinal = all.filter((ym) => man.months[ym] && !man.months[ym].final && thisYm >= ymAdd(ym, 2));
    if (missing.length && missing[0] === latest) want.push(latest);
    for (const ym of tofinal) if (!want.includes(ym)) want.push(ym);
    for (const ym of missing) if (!want.includes(ym)) want.push(ym);
  }

  let budget = BUDGET, done = 0;
  for (const ym of want) {
    if (budget < PER_MONTH) { console.log(`예산 부족(${budget} < ${PER_MONTH}) — ${ym}부터 다음 실행에`); break; }
    const t0 = Date.now();
    const { cube, err, calls } = await fetchMonth(ym);
    budget -= calls;
    if (err) {
      console.log(`::warning::${ym} 받기 실패(${err.message}) — 이 달은 저장하지 않음, 호출 ${calls}`);
      if (err instanceof QuotaError) break;
      continue;
    }
    const c = check(ym, cube);
    if (!c.ok) console.log(`::warning::${ym} 합계 대조 불일치 — 전체 ${c.all}, 차종합 ${c.sumT}, 연료합 ${c.sumF}`);
    const final = thisYm >= ymAdd(ym, 2);
    const fetchedAt = new Date().toISOString();
    writeFileSync(join(OUT_DIR, `${ym}.json`), JSON.stringify({ month: ym, fetchedAt, final, cube }));
    man.months[ym] = { fetchedAt, final, calls, total: c.all, regionSum: c.sumCube };
    done++;
    console.log(`${ym}: ${calls}회, ${Math.round((Date.now() - t0) / 1000)}초, 전체 ${c.all}, 지역칸 합 ${c.sumCube}${final ? " (확정)" : ""}`);
  }

  // 보관 기간 밖 정리
  for (const ym of Object.keys(man.months)) if (ym < oldest) delete man.months[ym];
  for (const f of readdirSync(OUT_DIR)) {
    const m = f.match(/^(\d{6})\.json$/);
    if (m && (m[1] < oldest || !man.months[m[1]])) unlinkSync(join(OUT_DIR, f));
  }
  man.builtAt = new Date().toISOString();
  man.retainMonths = RETAIN;
  man.perMonthCalls = PER_MONTH;
  writeFileSync(manPath, JSON.stringify(man, null, 1));
  const have = Object.keys(man.months).sort();
  console.log(`완료: 이번에 ${done}개월, 보유 ${have.length}개월(${have[0] || "-"}~${have[have.length - 1] || "-"}), 남은 예산 ${budget}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
