// lib/vehicle_cache.js
// ────────────────────────────────────────────────────────────────────────────
// 자동차 신규등록(공단 15059401) 호출을 줄이는 장치 세 가지 (2026-11-26 사용자 결정 ①+②+③)
//
// ① 월별 수집본(data/vehicle/) — scripts/refresh-vehicle-cache.mjs(GitHub Actions)가 달마다
//    차종(4) × 등록지역(17) × 사용연료(11) 칸 748개와 '지역 전체' 칸 60개(차종·연료가 코드 또는 전체)를
//    받아 둔다. 이 세 축만 쓰는 조회는 원 API를 부르지 않고 여기서 답한다. 지역 전체 칸을 따로 받는
//    까닭: 2026-07은 광주·전남 몫이 지역 코드 1~17 밖으로 빠져 지역 칸을 더해도 전국과 맞지 않는다.
//    차종 전체·연료 전체는 코드 칸을 더해 만든다(2025-01 실측: 차종 4개 합·연료 11개 합 = 전체).
// ② 결과 저장 — 원 API로 받은 칸(월 × 조건)을 저장해 같은 칸을 다시 부르지 않는다. 같은 함수 인스턴스
//    안에서는 메모리에, 환경변수 KV_REST_API_URL·KV_REST_API_TOKEN(Upstash)이 있으면 그곳에도 둔다.
//    지난 달 이전 칸은 40일, 최근 두 달 칸은 하루 보관한다(신고 반영이 늦게 바뀔 수 있음).
//    2026-11-26 Vercel Storage의 Upstash 저장소(중계 서버·웹 읽기 서버와 같은 저장소)를 이 프로젝트에 연결했다(접두어 KV).
//    키는 vr1: 접두어라 다른 서버 키와 겹치지 않는다.
// ③ 남은 한도 — 일일 한도 초과(코드 22)를 받으면 그날 자정(한국시간)까지 원 API를 부르지 않고 바로
//    안내한다. Upstash가 있으면 오늘 원 API 호출 수를 세어, 남은 한도를 넘는 조회는 부르기 전에 거절한다.
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let DIR = join(__dirname, "..", "data", "vehicle");
export function _setVehicleDir(d) { DIR = d; manifest = null; months.clear(); } // 시험용

export const DAILY_LIMIT = 3000;
// 새벽 수집 작업이 쓰는 몫(scripts/refresh-vehicle-cache.mjs 기본 예산)과 같게 둔다
export const COLLECT_BUDGET = 1700;

export const CUBE_T = ["1", "2", "3", "4"];
export const CUBE_R = Array.from({ length: 17 }, (_, i) => String(i + 1));
export const CUBE_F = Array.from({ length: 11 }, (_, i) => String(i + 1));

// 원 API 파라미터 이름(vehicle_regist_client.js DIMENSIONS와 같아야 함)
const P_T = "vhctyAsortCode", P_R = "registGrcCode", P_F = "useFuelCode";
const CUBE_PARAMS = new Set([P_T, P_R, P_F, "registYy", "registMt"]);

let manifest = null;
const months = new Map();

export function vehicleManifest() {
  if (manifest) return manifest;
  const p = join(DIR, "manifest.json");
  try { manifest = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { months: {} }; } catch { manifest = { months: {} }; }
  return manifest;
}

function monthCube(ym) {
  if (months.has(ym)) return months.get(ym);
  const p = join(DIR, `${ym}.json`);
  let c = null;
  try { c = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")).cube || null : null; } catch { c = null; }
  months.set(ym, c);
  return c;
}

/** 수집본 칸 하나. t·r·f는 코드 문자열 또는 "*". 없으면 null */
export function cubeCell(ym, t, r, f) {
  const c = monthCube(ym);
  if (!c) return null;
  if (r === "*") { const v = c[`${t}|*|${f}`]; return typeof v === "number" ? v : null; }
  if (t === "*") { let s = 0; for (const x of CUBE_T) { const v = cubeCell(ym, x, r, f); if (v === null) return null; s += v; } return s; }
  if (f === "*") { let s = 0; for (const x of CUBE_F) { const v = cubeCell(ym, t, r, x); if (v === null) return null; s += v; } return s; }
  const v = c[`${t}|${r}|${f}`];
  return typeof v === "number" ? v : null;
}

/** 원 API 파라미터(params)로 수집본에서 답할 수 있으면 건수, 아니면 null */
export function cubeLookup(params) {
  for (const k of Object.keys(params)) if (!CUBE_PARAMS.has(k)) return null;
  const ym = `${params.registYy}${params.registMt}`;
  return cubeCell(ym, params[P_T] || "*", params[P_R] || "*", params[P_F] || "*");
}

export function cubeInfo() {
  const m = vehicleManifest();
  const list = Object.keys(m.months || {}).sort();
  return { months: list, first: list[0] || null, last: list[list.length - 1] || null, builtAt: m.builtAt || null };
}

// ---------------------------------------------------------------------------
// ② 결과 저장 · ③ 한도 — 메모리 + (있으면) Upstash
// ---------------------------------------------------------------------------

const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const KV_ON = !!(KV_URL && KV_TOKEN);

async function kv(cmds) {
  if (!KV_ON) return null;
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(`${KV_URL}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cmds),
      signal: ctl.signal,
    });
    clearTimeout(tm);
    if (!r.ok) return null;
    return (await r.json()).map((x) => (x && "result" in x ? x.result : null));
  } catch { return null; }
}

const mem = new Map(); // key → { v, exp }
const MEM_MAX = 20000;

/** 한국시간 기준 날짜(YYYYMMDD)와 그날 자정까지 남은 초 */
export function kstDay(now = Date.now()) {
  const d = new Date(now + 9 * 3600e3);
  const day = d.toISOString().slice(0, 10).replace(/-/g, "");
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 9 * 3600e3;
  return { day, untilMs: next, secLeft: Math.max(60, Math.ceil((next - now) / 1000)) };
}

function ymKST(now = Date.now()) { return kstDay(now).day.slice(0, 6); }
function ymAdd(ym, n) { const y = +ym.slice(0, 4), m = +ym.slice(4) - 1 + n; return `${y + Math.floor(m / 12)}${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`; }

export function cellKey(params) {
  return "vr1:" + Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
}

/** 저장된 칸들 — keys 배열 순서대로 건수 또는 null */
export async function getSaved(keys) {
  const out = keys.map((k) => { const e = mem.get(k); return e && e.exp > Date.now() ? e.v : null; });
  const miss = keys.map((k, i) => (out[i] === null ? i : -1)).filter((i) => i >= 0);
  if (miss.length && KV_ON) {
    const res = await kv(miss.map((i) => ["GET", keys[i]]));
    if (res) res.forEach((v, j) => { if (v !== null && v !== undefined && /^\d+$/.test(String(v))) { out[miss[j]] = Number(v); } });
  }
  return out;
}

/** 받은 칸 저장. ym이 최근 두 달이면 하루, 그 전이면 40일 */
export async function saveCells(entries) {
  if (!entries.length) return;
  const recent = ymAdd(ymKST(), -2);
  const cmds = [];
  for (const { key, ym, v } of entries) {
    const sec = ym >= recent ? 86400 : 40 * 86400;
    if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value);
    mem.set(key, { v, exp: Date.now() + sec * 1000 });
    cmds.push(["SET", key, String(v), "EX", String(sec)]);
  }
  if (KV_ON) await kv(cmds);
}

let quotaUntil = 0;

/** 일일 한도 초과로 표시돼 있으면 그 시각(ms), 아니면 0 */
export async function quotaBlockedUntil() {
  if (quotaUntil > Date.now()) return quotaUntil;
  if (KV_ON) {
    const r = await kv([["GET", "vr1:quota"]]);
    const v = r && r[0] ? Number(r[0]) : 0;
    if (v > Date.now()) { quotaUntil = v; return v; }
  }
  return 0;
}

export async function markQuotaExhausted() {
  const { untilMs, secLeft } = kstDay();
  quotaUntil = untilMs;
  if (KV_ON) await kv([["SET", "vr1:quota", String(untilMs), "EX", String(secLeft)]]);
}

/** 오늘 이 서버가 원 API를 부른 횟수(Upstash가 있을 때만, 없으면 null) */
export async function usedToday() {
  if (!KV_ON) return null;
  const r = await kv([["GET", `vr1:cnt:${kstDay().day}`]]);
  return r && r[0] ? Number(r[0]) || 0 : 0;
}

export async function addUsed(n) {
  if (!KV_ON || !n) return;
  const { day } = kstDay();
  await kv([["INCRBY", `vr1:cnt:${day}`, String(n)], ["EXPIRE", `vr1:cnt:${day}`, String(2 * 86400)]]);
}
