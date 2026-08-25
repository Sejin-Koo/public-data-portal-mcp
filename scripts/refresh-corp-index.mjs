// public-data-portal-mcp / scripts/refresh-corp-index.mjs
//
// OpenDART corpCode.xml(zip)을 받아 "회사명 → corp_code" 정적 인덱스를 만들어
// data/corp_name_index.json.gz 로 저장한다.
//
// 왜 정적 파일인가: get_employment_insurance_workplace가 회사명을 사업자등록번호
// 10자리로 바꾸려면 corp_code가 필요한데, OpenDART에는 이름으로 corp_code를 찾는 API가
// 없고 전체 목록인 corpCode.xml은 다운로드에만 3분 39초가 걸린다(2026-08-25 실측).
// Vercel 함수의 maxDuration이 60초라 요청 시점에는 받을 수 없어, GitHub Actions가
// 주기적으로 이 스크립트를 돌려 결과를 커밋하고 런타임은 정적 파일만 읽는다.
// (dart-mcp의 scripts/refresh-corp-code.mjs와 같은 패턴)
//
// 실행: DART_API_KEY=xxx node scripts/refresh-corp-index.mjs

import AdmZip from "adm-zip";
import { writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data");
const OUT_PATH = path.join(OUT_DIR, "corp_name_index.json.gz");

const key = process.env.DART_API_KEY;
if (!key) {
  console.error("DART_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

// 데이터센터 IP에서 opendart의 대용량 파일 전송이 간헐적으로 503이 되거나 극단적으로
// 느려지는 사례가 dart-mcp에서 실측됐다. 타임아웃 + 백오프 재시도로 방어한다.
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 300_000;
const BACKOFF_MS = [0, 30_000, 60_000, 120_000];

async function download() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt - 1]) {
      console.log(`[refresh] ${BACKOFF_MS[attempt - 1] / 1000}초 대기 후 재시도...`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      console.log(`[refresh] 다운로드 시도 ${attempt}/${MAX_ATTEMPTS}`);
      const res = await fetch(
        `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`,
        { signal: ac.signal }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[refresh] 수신 ${buf.length.toLocaleString()} bytes`);
      return buf;
    } catch (e) {
      lastErr = e;
      console.error(`[refresh] 실패: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 회사명 정규화 — lib/comwel_client.js의 normalizeCorpName과 반드시 동일해야 한다. */
function normalizeCorpName(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function tag(block, name) {
  const o = `<${name}>`;
  const c = `</${name}>`;
  const s = block.indexOf(o);
  if (s === -1) return "";
  const e = block.indexOf(c, s);
  if (e === -1) return "";
  return block.slice(s + o.length, e).trim();
}

const zipBuf = await download();
const xml = new AdmZip(zipBuf).getEntries()[0].getData().toString("utf-8");

const blocks = xml.split("<list>").slice(1);
console.log(`[refresh] 파싱 대상 ${blocks.length.toLocaleString()}건`);

const map = {};
let listedWins = 0;
for (const b of blocks) {
  const code = tag(b, "corp_code");
  const name = tag(b, "corp_name");
  if (!code || !name) continue;
  const k = normalizeCorpName(name);
  if (!k) continue;
  const listed = tag(b, "stock_code") !== "";
  const mdate = tag(b, "modify_date");
  const cur = map[k];
  // 동명이 있으면 ①상장사 우선 ②그다음 최종변경일이 최근인 쪽
  if (!cur) {
    map[k] = [code, name, listed, mdate];
  } else if ((listed && !cur[2]) || (listed === cur[2] && mdate > cur[3])) {
    if (listed && !cur[2]) listedWins++;
    map[k] = [code, name, listed, mdate];
  }
}

const slim = {};
for (const [k, v] of Object.entries(map)) slim[k] = [v[0], v[1]];

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: "OpenDART corpCode.xml",
  count: Object.keys(slim).length,
  map: slim,
};

// mtime을 0으로 고정해야 내용이 같을 때 gz 바이트도 같아진다.
// 그래야 GitHub Actions의 "변경 없으면 커밋 생략"이 실제로 동작한다.
const gz = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9, mtime: 0 });

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_PATH, gz);

console.log(`[refresh] 고유 회사명 ${payload.count.toLocaleString()}건 (상장사 우선 적용 ${listedWins}건)`);
console.log(`[refresh] 저장 ${OUT_PATH}  ${statSync(OUT_PATH).size.toLocaleString()} bytes`);
