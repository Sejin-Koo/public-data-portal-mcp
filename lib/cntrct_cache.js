// lib/cntrct_cache.js
// ────────────────────────────────────────────────────────────────────────────
// 나라장터 계약정보 **공동계약 수집본**(data/cntrct/)을 읽는다. 업체(사업자번호·업체명)로 긴 기간을 거를 때
// 원 API를 다시 부르지 않고 이 파일에서 찾는다 — 하루 7천 건이 넘어 실시간으로는 1년 조회가 시간 초과로 끝난다.
//
// ★ 공동계약(cmmnCntrctYn=Y 또는 업체 2곳 이상)만 들어 있다. 단독 계약은 없다 — 그 회사의 단독 수주는
//   낙찰 수집본(scan_narajangteo_awards)이나 공고번호 조회로 본다.
// 수집 스크립트: scripts/refresh-cntrct-cache.mjs (GitHub Actions 매일, 최근 7일·일요일 60일 재수신 + 빈 날 채우기)
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let DIR = join(__dirname, "..", "data", "cntrct");
export function _setCntrctDir(d) { DIR = d; manifest = null; files.clear(); } // 시험용

let manifest = null;
const files = new Map();

export function cntrctManifest() {
  if (manifest) return manifest;
  const p = join(DIR, "manifest.json");
  manifest = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  return manifest;
}

function monthRows(m) {
  if (files.has(m)) return files.get(m);
  const p = join(DIR, `${m}.json.gz`);
  const rows = existsSync(p) ? JSON.parse(gunzipSync(readFileSync(p)).toString("utf-8")).rows || [] : [];
  files.set(m, rows);
  return rows;
}

const dayAdd = (s, n) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + n)).toISOString().slice(0, 10).replace(/-/g, "");

/** [from, to] 안에서 수집본이 받아 둔 날(요청한 업무구분 모두)과 못 받은 날을 나누고, 받은 날의 행을 돌려준다. */
export function queryCntrctCache({ from, to, types }) {
  const man = cntrctManifest();
  if (!man || !man.days) return null;
  const covered = [];
  const missing = [];
  for (let d = from; d <= to; d = dayAdd(d, 1)) {
    const e = man.days[d];
    if (e && types.every((t) => e[t])) covered.push(d);
    else missing.push(d);
  }
  const cov = new Set(covered);
  const tset = new Set(types);
  const rows = [];
  const monthsNeeded = [...new Set(covered.map((d) => d.slice(0, 6)))];
  for (const m of monthsNeeded) for (const r of monthRows(m)) if (cov.has(r._d) && tset.has(r._t)) rows.push(r);
  return { rows, covered, missing, builtAt: man.builtAt, firstDay: man.firstDay, coverage: man.coverage };
}
