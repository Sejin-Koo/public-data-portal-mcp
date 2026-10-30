// 식약처 건강기능식품 품목정보(HtfsInfoService03/getHtfsItem01) 전수 수집 → data/hff/
//
// 원료·기능성별 건수와 업체 집중도를 내려면 전수가 필요한데, 실시간 도구(search_health_functional_food)는
// 한 번에 100건까지만 받고 기능성으로 거를 수 없다. 그래서 월 1회 전수를 받아 둔다(2026-10-30 결정).
//   - 남기는 필드 6개: 업체(ENTRPS)·제품명(PRDUCT)·신고번호(STTEMNT_NO)·등록일(REGIST_DT)·
//     기능성 내용(MAIN_FNCTN)·기준규격(BASE_STANDARD). 섭취 주의·보관·성상 등은 집계에 쓰지 않아 뺀다.
//   - 등록 연도별 파일(hff-YYYY.json.gz)로 나눈다. 갱신 때 대개 올해 파일만 바뀐다.
//   - 하나라도 쪽 받기에 실패하거나 받은 건수가 totalCount와 다르면 아무것도 쓰지 않는다(부분 수집 방지).
//
//   DATA_PORTAL_KEY=... node scripts/refresh-hff.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const KEY = process.env.DATA_PORTAL_KEY;
if (!KEY) { console.error("DATA_PORTAL_KEY 환경변수가 없습니다."); process.exit(1); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "hff");
const BASE = "https://apis.data.go.kr/1471000/HtfsInfoService03/getHtfsItem01";
const PER = 500;
const COLS = ["ENTRPS", "PRDUCT", "STTEMNT_NO", "REGIST_DT", "MAIN_FNCTN", "BASE_STANDARD"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(no) {
  const url = `${BASE}?serviceKey=${encodeURIComponent(KEY)}&type=json&pageNo=${no}&numOfRows=${PER}`;
  let last;
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(t);
      const b = j.body || (j.response && j.response.body);
      const code = (j.header && j.header.resultCode) || (j.response && j.response.header && j.response.header.resultCode);
      if (!b || (code && code !== "00")) throw new Error(`결과코드 ${code}`);
      const items = (b.items || []).map((x) => x.item || x);
      return { total: Number(b.totalCount), items };
    } catch (e) {
      last = e;
      await sleep(2000 * i);
    }
  }
  throw new Error(`${no}쪽 실패: ${last && last.message}`);
}

const first = await page(1);
const total = first.total;
const pages = Math.ceil(total / PER);
const all = [...first.items];
for (let no = 2; no <= pages; no++) {
  const p = await page(no);
  all.push(...p.items);
  if (no % 10 === 0) console.log(`${no}/${pages}쪽, ${all.length}건`);
}
const uniq = new Map();
for (const it of all) uniq.set(it.STTEMNT_NO, it);
console.log(`받은 행 ${all.length}, 신고번호 기준 ${uniq.size}, totalCount ${total}`);
if (uniq.size !== total) {
  console.error("::error::받은 건수가 totalCount와 다릅니다 — 쓰지 않고 끝냅니다(원천이 수집 중에 바뀌었을 수 있음, 다시 실행).");
  process.exit(1);
}

const clean = (v) => (v == null ? "" : String(v).replace(/\r/g, "").trim());
const byYear = {};
for (const it of uniq.values()) {
  const row = COLS.map((c) => clean(it[c]));
  const y = /^\d{8}$/.test(row[3]) ? row[3].slice(0, 4) : "unknown";
  (byYear[y] ||= []).push(row);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^hff-.*\.json\.gz$/.test(f)) fs.rmSync(path.join(OUT, f));
const years = {};
for (const y of Object.keys(byYear).sort()) {
  const rows = byYear[y].sort((a, b) => (a[2] < b[2] ? -1 : 1));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ cols: COLS, rows }), "utf8"), { level: 9, mtime: 0 });
  fs.writeFileSync(path.join(OUT, `hff-${y}.json.gz`), gz);
  years[y] = rows.length;
}
// 수집 시각은 따로 둔다 — 내용이 같으면 연도 파일 바이트가 같아 릴리스에 다시 올리지 않는다.
fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ 원천: "식약처 건강기능식품 품목정보 HtfsInfoService03/getHtfsItem01", totalCount: total, 연도별: years, 필드: COLS }, null, 1) + "\n"
);
fs.writeFileSync(path.join(OUT, "collected.json"), JSON.stringify({ 수집시각: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " KST" }) + "\n");
console.log(`연도 파일 ${Object.keys(years).length}개, 합계 ${Object.values(years).reduce((a, b) => a + b, 0)}건`);
