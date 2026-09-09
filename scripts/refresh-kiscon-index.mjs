// scripts/refresh-kiscon-index.mjs
// ────────────────────────────────────────────────────────────────────────────
// 키스콘(KISCON) 건설업체정보 공시에서 "사업자등록번호 ↔ 상호" 색인을 만들어
// data/kiscon_bizno_index.json.gz 로 저장한다.
//
// ★ 왜 필요한가
//   기존 회사명 → 사업자등록번호 해석기(lib/bizno_resolver.js)는 DART 고유번호
//   인덱스에만 의존해서, DART에 등록되지 않은 비상장·비외감 법인은 해석이 아예
//   불가능했다. 키스콘 공시는 건설업 등록업체 전수를 사업자등록번호와 함께
//   공개하므로, DART가 못 덮는 구간을 그대로 메운다.
//
// ★ 왜 corp_name_index.json.gz 에 합치지 않는가
//   그 파일은 GitHub Actions가 매주 **통째로 교체**한다. 키스콘 누적분을 거기에
//   넣으면 다음 주에 사라진다. 그래서 별도 파일로 두고 **누적 병합**한다.
//
// ★ 자료구조 — 사업자등록번호가 키, 상호는 배열
//   사명이 바뀌면 같은 사업자등록번호에 새 상호가 얹힌다. 상호를 배열로 쌓아 두면
//   옛 사명으로 물어봐도 찾히고, 최신 사명도 함께 답할 수 있다. 배열 0번이 최신이다.
//   역방향(상호 → 번호) 색인은 파일 크기를 두 배로 만들므로 저장하지 않고,
//   해석기가 로드 시점에 만든다.
//
// ★ 휴업·폐업 상태는 이 색인에 담지 않는다
//   폐업 공시(GongsiCess)는 "그 시점에 폐업 신고가 있었다"는 사실일 뿐이고,
//   현재 상태는 국세청 사업자등록 상태조회로 조회 시점에 확인하는 것이 정확하다.
//   색인에 상태를 굳혀 넣으면 한 달 내내 낡은 값을 답하게 된다.
//
// 사용법
//   node scripts/refresh-kiscon-index.mjs --backfill        전 구간(2003-01-01~오늘) 재수집
//   node scripts/refresh-kiscon-index.mjs                   최근 2개월 증분 병합(기본)
//   node scripts/refresh-kiscon-index.mjs --months 6        최근 6개월 증분 병합
//
// 환경변수: DATA_PORTAL_KEY (공공데이터포털 공용키)
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "kiscon_bizno_index.json.gz");

const BASE = "https://apis.data.go.kr/1613000/ConAdminInfoSvc1";
const MAX_ROWS = 10000;
const PAGE_CONCURRENCY = 6;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 상호와 사업자등록번호가 함께 실려 오는 공시 오퍼레이션만 담는다.
//
// ★ 실측(2026-09-09) — 8개 오퍼레이션 중 사업자등록번호(ncrMasterNum)를 주는 것은 넷뿐이다.
//   양도(GongsiTrans)·합병(GongsiUnion)·상속(GongsiInheri)은 상호·대표자·주소만 주고
//   사업자등록번호 필드가 아예 없으며, 가처분(GongsiAdmiPD)은 전 구간 0건이다. 그래서 뺐다.
//
// ★ 행정처분(GongsiAdmi)만 상호·대표자 필드명이 다르다(ncrAdmiKname·ncrAdmiMaster).
//   ncrGsKname으로만 읽으면 5만여 행이 통째로 버려진다 — 실제로 첫 시험에서 그렇게 됐다.
//
// ★ 등록기준사항신고(GongsiRenew)는 전 구간 36.9만 행으로 가장 크지만 등록일이
//   2024-12-12에서 끊겨 있고, 연도별 조회는 2021년 이후 0건을 돌려준다(제도 변경으로
//   공시가 사실상 멈춘 것으로 보인다). 그래서 증분 실행에서는 기간 조회 대신
//   **전 구간 총건수를 1행짜리 호출로 물어 지난번보다 늘었을 때만** 다시 훑는다.
const OPS = [
  { op: "GongsiReg", label: "신규등록", name: "ncrGsKname", rep: "ncrGsMaster" },
  { op: "GongsiRenew", label: "등록기준사항신고", name: "ncrGsKname", rep: "ncrGsMaster", fullRange: true },
  { op: "GongsiCess", label: "폐업신고", name: "ncrGsKname", rep: "ncrGsMaster" },
  { op: "GongsiAdmi", label: "행정처분", name: "ncrAdmiKname", rep: "ncrAdmiMaster" },
];

const SERVICE_KEY = (process.env.DATA_PORTAL_KEY || "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function qs(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function onlyDigits(s) {
  return String(s ?? "").replace(/[^0-9]/g, "");
}

/** 회사명 정규화 — lib/bizno_resolver.js의 normalizeCorpName과 동일 규칙이어야 한다. */
function normalizeCorpName(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// 서버가 연달아 호출하면 연결을 끊는 일이 있다. 인증 문제가 아니므로 재시도로 흡수한다.
async function callKiscon(op, params, { timeoutMs = 120000, retries = 4 } = {}) {
  const url = `${BASE}/${op}?serviceKey=${SERVICE_KEY}&_type=json&${qs(params)}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`JSON 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 160)}`);
      }
      const svcErr = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (svcErr) throw new Error(`${svcErr.errMsg || "오류"} (code ${svcErr.returnReasonCode || "?"})`);
      const header = data?.response?.header;
      if (header && header.resultCode !== "00") {
        throw new Error(`${op}: ${header.resultMsg} (resultCode ${header.resultCode})`);
      }
      const body = data?.response?.body ?? {};
      let items = body.items;
      if (!items || typeof items === "string") items = [];
      else items = Array.isArray(items.item) ? items.item : items.item ? [items.item] : [];
      return { items, totalCount: Number(body.totalCount ?? items.length) };
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error(`timeout after ${timeoutMs}ms`) : e;
      console.warn(`    ${op} p${params.pageNo} 시도 ${attempt + 1}/${retries + 1} 실패: ${lastErr.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 한 행에서 색인에 담을 것만 뽑는다. 전체 행을 메모리에 쌓으면 70만 행에서 터진다.
 * 상호·대표자 필드명은 오퍼레이션마다 다르므로 OPS의 매핑을 받아 쓴다.
 * ncrGsDate(공시일)에는 오류값이 섞여 있어 ncrGsRegdate(등록일)만 쓴다.
 */
function pick(row, spec) {
  let bizNo = onlyDigits(row.ncrMasterNum);
  // 응답이 숫자형이라 앞자리 0이 떨어질 수 있다. 9자리면 되살린다.
  if (bizNo.length === 9) bizNo = `0${bizNo}`;
  if (bizNo.length !== 10) return null;
  const name = String(row[spec.name] ?? "").trim();
  if (!name || name === "-") return null;
  return {
    bizNo,
    name,
    rep: String(row[spec.rep] ?? "").trim().replace(/^-$/, "") || null,
    area: [row.ncrAreaName, row.ncrAreaDetailName]
      .filter((v) => v && v !== "-")
      .join(" ")
      .trim() || null,
    item: String(row.ncrItemName ?? "").trim().replace(/^-$/, "") || null,
    date: onlyDigits(row.ncrGsRegdate).slice(0, 8) || null,
  };
}

/**
 * 색인 병합. 같은 사업자등록번호를 다시 만나면
 *   - 상호가 새 것이면 배열 맨 앞에 넣고(최신 우선), 기존 상호는 뒤로 밀어 보존한다.
 *   - 대표자·지역·업종은 관측일이 더 최신일 때만 덮어쓴다.
 * 관측일이 없는 행은 기존 값을 건드리지 않는다 — 낡은 값이 최신을 밀어내지 않게 한다.
 */
function merge(index, r) {
  const cur = index[r.bizNo];
  if (!cur) {
    index[r.bizNo] = { n: [r.name], r: r.rep, a: r.area, i: r.item, d: r.date };
    return "new";
  }
  const newer = r.date && (!cur.d || r.date >= cur.d);
  const pos = cur.n.indexOf(r.name);
  if (pos === -1) {
    if (newer) cur.n.unshift(r.name);
    else cur.n.push(r.name);
    if (cur.n.length > 8) cur.n.length = 8; // 사명 이력이 무한정 늘어나지 않게 상한을 둔다
  } else if (newer && pos !== 0) {
    cur.n.splice(pos, 1);
    cur.n.unshift(r.name);
  }
  if (newer) {
    if (r.rep) cur.r = r.rep;
    if (r.area) cur.a = r.area;
    if (r.item) cur.i = r.item;
    cur.d = r.date;
  }
  return pos === -1 ? "alias" : "hit";
}

async function harvest(spec, sDate, eDate, index, stats) {
  const params = { sDate, eDate, numOfRows: MAX_ROWS };
  const first = await callKiscon(spec.op, { ...params, pageNo: 1 });
  const total = first.totalCount;
  const pages = Math.max(1, Math.ceil(total / MAX_ROWS));
  console.log(`  ${spec.label}(${spec.op}): ${total.toLocaleString()}행 / ${pages}페이지`);

  const absorb = (items) => {
    for (const row of items) {
      const r = pick(row, spec);
      if (!r) {
        stats.skipped++;
        continue;
      }
      stats.rows++;
      const kind = merge(index, r);
      if (kind === "new") stats.newBiz++;
      else if (kind === "alias") stats.newAlias++;
    }
  };

  absorb(first.items);

  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);
  for (let i = 0; i < rest.length; i += PAGE_CONCURRENCY) {
    const batch = rest.slice(i, i + PAGE_CONCURRENCY);
    const got = await Promise.all(batch.map((p) => callKiscon(spec.op, { ...params, pageNo: p })));
    for (const g of got) absorb(g.items);
    console.log(
      `    p${batch[0]}~p${batch[batch.length - 1]} 완료 — 누적 고유 ${Object.keys(index).length.toLocaleString()}`
    );
  }
  return total;
}

/** 전 구간 총건수만 1행짜리 호출로 확인한다(fullRange 오퍼레이션의 증분 판정용). */
async function totalOnly(op, sDate, eDate) {
  const r = await callKiscon(op, { sDate, eDate, numOfRows: 1, pageNo: 1 });
  return r.totalCount;
}

function loadExisting() {
  if (!existsSync(OUT)) return null;
  try {
    return JSON.parse(gunzipSync(readFileSync(OUT)).toString("utf-8"));
  } catch (e) {
    console.warn(`기존 색인을 읽지 못했습니다(${e.message}). 새로 만듭니다.`);
    return null;
  }
}

async function main() {
  if (!SERVICE_KEY) {
    console.error("환경변수 DATA_PORTAL_KEY가 설정되지 않았습니다.");
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const backfill = argv.includes("--backfill");
  const mIdx = argv.indexOf("--months");
  const months = mIdx >= 0 ? Number(argv[mIdx + 1]) || 2 : 2;

  const now = new Date();
  const eDate = now.toISOString().slice(0, 10).replace(/-/g, "");
  let sDate;
  if (backfill) {
    sDate = "20030101"; // 키스콘 공시 제공 시작일
  } else {
    const s = new Date(now.getTime());
    s.setMonth(s.getMonth() - months);
    sDate = s.toISOString().slice(0, 10).replace(/-/g, "");
  }

  const prev = backfill ? null : loadExisting();
  const index = prev?.byBizNo ? prev.byBizNo : {};
  const before = Object.keys(index).length;

  console.log(
    `모드: ${backfill ? "백필(전 구간)" : `증분(최근 ${months}개월)`} / 기간 ${sDate}~${eDate} / 기존 고유 ${before.toLocaleString()}`
  );

  const stats = { rows: 0, skipped: 0, newBiz: 0, newAlias: 0 };
  const perOp = {};
  const prevPerOp = prev?.perOpTotalRows || {};
  const t0 = Date.now();
  for (const spec of OPS) {
    try {
      // fullRange 오퍼레이션은 기간 필터가 신뢰할 수 없어(2021년 이후 0건) 증분 조회로는
      // 새 공시를 못 잡는다. 전 구간 총건수를 먼저 물어, 지난 실행보다 늘었을 때만 다시 훑는다.
      if (!backfill && spec.fullRange) {
        const now = await totalOnly(spec.op, "20030101", eDate);
        const was = prevPerOp[spec.label];
        if (typeof was === "number" && now <= was) {
          console.log(`  ${spec.label}(${spec.op}): 전 구간 ${now.toLocaleString()}행 — 지난 실행과 동일, 건너뜀`);
          perOp[spec.label] = was;
          continue;
        }
        console.log(`  ${spec.label}(${spec.op}): 전 구간 ${was ?? "?"} → ${now.toLocaleString()} — 전량 재수집`);
        perOp[spec.label] = await harvest(spec, "20030101", eDate, index, stats);
        continue;
      }
      perOp[spec.label] = await harvest(spec, sDate, eDate, index, stats);
    } catch (e) {
      // 한 오퍼레이션이 죽어도 나머지는 살린다. 다만 백필에서는 실패를 반드시 남긴다.
      console.error(`  ${spec.label}(${spec.op}) 실패: ${e.message}`);
      perOp[spec.label] = null;
    }
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  const failed = Object.entries(perOp).filter(([, v]) => v === null).map(([k]) => k);
  if (backfill && failed.length) {
    console.error(`백필 중 실패한 오퍼레이션이 있어 색인을 저장하지 않습니다: ${failed.join(", ")}`);
    process.exit(2);
  }

  const after = Object.keys(index).length;
  const payload = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    lastRange: { sDate, eDate },
    mode: backfill ? "backfill" : "incremental",
    count: after,
    perOpTotalRows: perOp,
    note:
      "사업자등록번호 → {n:[상호 최신순], r:대표자, a:지역, i:업종, d:최근 관측일(YYYYMMDD)}. " +
      "휴업·폐업 상태는 담지 않으므로 국세청 상태조회로 별도 확인할 것.",
    byBizNo: index,
  };

  const buf = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"), { level: 9 });
  writeFileSync(OUT, buf);

  // 정규화 상호 기준 고유 개수도 함께 보고한다 — 해석기가 이 키로 역방향 조회를 만든다.
  const names = new Set();
  for (const v of Object.values(index)) for (const n of v.n) names.add(normalizeCorpName(n));

  console.log(
    [
      "",
      `소요 ${elapsed}초`,
      `처리 행 ${stats.rows.toLocaleString()} (사업자번호·상호 결측으로 제외 ${stats.skipped.toLocaleString()})`,
      `고유 사업자등록번호 ${before.toLocaleString()} → ${after.toLocaleString()} (신규 ${stats.newBiz.toLocaleString()})`,
      `상호 별칭 추가 ${stats.newAlias.toLocaleString()} / 정규화 상호 고유 ${names.size.toLocaleString()}`,
      `저장 ${OUT} (${(buf.length / 1024 / 1024).toFixed(2)} MB gzip)`,
    ].join("\n")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
