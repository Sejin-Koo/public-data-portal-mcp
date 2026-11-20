// 공정위 가맹본부 일반현황·브랜드 목록 연도별 전량 수집 → data/ftc/
//
// 원 API는 이름·사업자등록번호 필터가 없어(에러 없이 무시) 회사 하나를 찾으려 해도 그 연도 전량
// (가맹본부 약 8,600곳·브랜드 약 1만 건)을 받아야 한다. 원천이 느린 시간대에는 이 전량 받기가
// 서버 함수 한도(60초)를 넘어 끊겼다(2026-11-12·11-19·11-20 반복). 그래서 월 1회 받아 두고
// search_franchise_headquarters·get_franchise_brand_stores가 수집본을 먼저 쓴다(2026-11-20 결정).
//   - 대상 연도: 올해와 그 앞 3개 연도. 원천에 자료가 없는 연도(0건)는 건너뛴다.
//   - 행은 원천 필드 그대로 둔다(도구가 쓰는 필드가 바뀌어도 다시 받지 않게).
//   - 쪽 받기가 하나라도 실패하거나 받은 건수가 totalCount와 다르면 그 연도·종류는 쓰지 않는다(부분 수집 방지).
//     전에 받아 둔 파일은 그대로 남는다.
//
//   DATA_PORTAL_KEY=... node scripts/refresh-ftc.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const KEY = process.env.DATA_PORTAL_KEY;
if (!KEY) { console.error("DATA_PORTAL_KEY 환경변수가 없습니다."); process.exit(1); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "ftc");
const BASE = "https://apis.data.go.kr/1130000";
const SERVICES = {
  hq: "FftcJnghdqrtrsGnrlDtl3_Service/getjnghdqrtrsGnlinfo2",
  brand: "FftcBrandRlsInfo2_Service/getBrandinfo",
};
const PER = 10000; // 원 API 상한
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(svc, year, no) {
  const url = `${BASE}/${svc}?serviceKey=${KEY}&resultType=json&jngBizCrtraYr=${year}&pageNo=${no}&numOfRows=${PER}`;
  let last;
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(t);
      const svcErr = j?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (svcErr) throw new Error(`${svcErr.errMsg || "오류"} (code ${svcErr.returnReasonCode || "?"})`);
      if (j.resultCode && j.resultCode !== "00") throw new Error(`결과코드 ${j.resultCode} ${j.resultMsg || ""}`);
      return { total: Number(j.totalCount ?? 0), items: j.items ?? [] };
    } catch (e) {
      last = e;
      await sleep(3000 * i);
    }
  }
  throw new Error(`${svc} ${year}년 ${no}쪽 실패: ${last && last.message}`);
}

async function all(key, year) {
  const first = await page(SERVICES[key], year, 1);
  let items = first.items;
  const pages = Math.ceil(first.total / PER);
  for (let p = 2; p <= pages; p++) items = items.concat((await page(SERVICES[key], year, p)).items);
  return { total: first.total, items };
}

fs.mkdirSync(OUT, { recursive: true });
const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const thisYear = Number(now.slice(0, 4));
const manifestPath = path.join(OUT, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
let wrote = 0, failed = 0;
for (let y = thisYear - 3; y <= thisYear; y++) {
  for (const key of Object.keys(SERVICES)) {
    try {
      const r = await all(key, y);
      if (!r.total) { console.log(`${key} ${y}: 원천 0건 — 건너뜀`); continue; }
      if (r.items.length !== r.total) throw new Error(`받은 건수 ${r.items.length} ≠ totalCount ${r.total}`);
      const body = JSON.stringify({ key, year: y, total: r.total, collectedAt: now, items: r.items });
      fs.writeFileSync(path.join(OUT, `${key}-${y}.json.gz`), zlib.gzipSync(body, { level: 9 }));
      manifest[`${key}-${y}`] = { total: r.total, collectedAt: now };
      wrote++;
      console.log(`${key} ${y}: ${r.total}건`);
    } catch (e) {
      failed++;
      console.error(`::warning::${key} ${y} 수집 실패 — 전에 받은 파일 유지: ${e.message}`);
    }
  }
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log(`완료: ${wrote}개 파일, 실패 ${failed}`);
if (!wrote) process.exit(1);
