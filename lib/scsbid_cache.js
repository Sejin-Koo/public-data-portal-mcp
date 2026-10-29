// lib/scsbid_cache.js
// ────────────────────────────────────────────────────────────────────────────
// 나라장터 공사·용역 낙찰정보 **월 단위 사전수집본**(data/scsbid/)을 읽어
// 키워드·지역·공종·업체로 거르고 업체별 순위·월별 분포를 낸다.
//
// ★ 실시간 도구(search_narajangteo_scsbid)와의 차이
//   - 원 API를 부르지 않는다 → 일일 한도(오퍼레이션당 1,000회)를 쓰지 않고, 24개월도 수 초 안에 끝난다.
//   - 낙찰 행마다 **입찰공고의 공사현장 지역·주공종·부공종·추정가격·계약방법**과 **참가가능지역**이
//     붙어 있다 → 수요기관명에 지역명이 없는 학교·대학·공공기관 발주도 지역으로 잡힌다.
//   - 대신 수집 시점 이후의 낙찰은 없다(월 2회 갱신, manifest의 builtAt). 최근 1개월은 실시간 도구로 보충한다.
//
// 수집 스크립트: scripts/refresh-scsbid-cache.mjs (GitHub Actions가 매월 1일·15일 실행)
// ────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "..", "data", "scsbid");
const TYPE_FILE = { 공사: "cnstwk", 용역: "servc" };

// 시도 별칭 — 입력은 짧은 이름이든 정식 이름이든 받는다. 지역 문자열은 "경상남도 진주시"처럼 정식 이름으로 온다.
const SIDO = [
  ["서울", ["서울특별시", "서울"]],
  ["부산", ["부산광역시", "부산"]],
  ["대구", ["대구광역시", "대구"]],
  ["인천", ["인천광역시", "인천"]],
  ["광주", ["광주광역시", "전남광주통합특별시", "광주"]],
  ["대전", ["대전광역시", "대전"]],
  ["울산", ["울산광역시", "울산"]],
  ["세종", ["세종특별자치시", "세종"]],
  ["경기", ["경기도", "경기"]],
  ["강원", ["강원특별자치도", "강원도", "강원"]],
  ["충북", ["충청북도", "충북"]],
  ["충남", ["충청남도", "충남"]],
  ["전북", ["전북특별자치도", "전라북도", "전북"]],
  ["전남", ["전라남도", "전남"]],
  ["경북", ["경상북도", "경북"]],
  ["경남", ["경상남도", "경남"]],
  ["제주", ["제주특별자치도", "제주도", "제주"]],
];
const SIDO_ALIAS = new Map();
for (const [short, names] of SIDO) for (const n of [short, ...names]) SIDO_ALIAS.set(n, { short, names });

const cache = new Map(); // 파일명 → { cols, rows, award, join, window, type }
let manifestCache = null;

function loadManifest() {
  if (manifestCache) return manifestCache;
  const p = join(DIR, "manifest.json");
  manifestCache = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : { files: {} };
  return manifestCache;
}

function loadFile(name) {
  if (cache.has(name)) return cache.get(name);
  const p = join(DIR, name);
  if (!existsSync(p)) return null;
  const obj = JSON.parse(gunzipSync(readFileSync(p)).toString("utf-8"));
  cache.set(name, obj);
  return obj;
}

function availableWindows(tk) {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .map((f) => f.match(new RegExp(`^${tk}-(\\d{6})\\.json\\.gz$`)))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

// ── 입력 정리 ────────────────────────────────────────────────────────────────
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function ymOf(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function addMonth(yyyymm, n) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6)) - 1 + n;
  return ymOf(new Date(Date.UTC(y, m, 1)));
}
/** "2025-01", "202501", "20250115", "2025.01.15" → 8자리 날짜. end면 그 달 말일. */
function normDate(s, end) {
  const d = String(s || "").replace(/[^0-9]/g, "");
  if (d.length >= 8) return d.slice(0, 8);
  if (d.length === 6) {
    if (!end) return `${d}01`;
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(4, 6));
    return `${d}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  return null;
}
const norm = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const stripCorp = (s) =>
  norm(s).replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)|합자회사|\(재\)|재단법인|\(사\)|사단법인/g, "");

/** 지역 입력 하나를 매칭 함수로. "경기" → 시도 일치, "시흥" → 부분 일치, "경기 시흥" → 둘 다. */
function regionMatcher(input) {
  const parts = String(input).trim().split(/\s+/).filter(Boolean);
  // 지역 문자열은 "경기도 시흥시" 또는 여러 개면 "경기도|서울특별시". 시도는 각 항목의 맨 앞에서만 맞춘다
  // ("경기도 광주시"가 '광주'(광역시) 조건에 걸리지 않게). 시도는 첫 단어만 시도로 해석하고, 나머지는 부분 일치.
  const tests = parts.map((p, i) => {
    const a = i === 0 ? SIDO_ALIAS.get(p) : null;
    if (a) return (item) => a.names.some((n) => item.startsWith(n));
    const q = p.length > 2 ? p.replace(/(시|군|구)$/, "") : p;
    return (item) => item.includes(q);
  });
  return (txt) => !!txt && String(txt).split("|").some((item) => tests.every((t) => t(item.trim())));
}

function quantiles(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const q = (p) => {
    const i = (a.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return +(a[lo] + (a[hi] - a[lo]) * (i - lo)).toFixed(3);
  };
  return { n: a.length, 최소: a[0], p25: q(0.25), 중앙값: q(0.5), p75: q(0.75), 최대: a[a.length - 1] };
}
const won = (n) => Math.round(n);
const eok = (n) => +(n / 1e8).toFixed(2);

// ── 본체 ────────────────────────────────────────────────────────────────────
export async function scanAwardsCache(args = {}) {
  const t0 = Date.now();
  const types = (args.bizTypes && args.bizTypes.length ? args.bizTypes : ["공사", "용역"]).filter((t) => TYPE_FILE[t]);
  if (!types.length) return { ok: false, 오류: "bizTypes는 공사·용역만 지원합니다(물품·외자는 search_narajangteo_scsbid)." };

  const now = kstNow();
  const toD = normDate(args.to, true) || `${ymOf(now)}${String(now.getUTCDate()).padStart(2, "0")}`;
  const fromD = normDate(args.from, false) || `${addMonth(toD.slice(0, 6), -23)}01`;
  if (fromD > toD) return { ok: false, 오류: `from(${fromD})이 to(${toD})보다 늦습니다.` };

  const keywords = (args.keywords || []).map(norm).filter(Boolean);
  const excludes = (args.excludeKeywords || []).map(norm).filter(Boolean);
  const kwMode = args.keywordMode === "all" ? "all" : "any";
  const kwFields = args.keywordFields && args.keywordFields.length ? args.keywordFields : ["공고명", "주공종", "부공종", "면허제한", "분류"];
  const regionMs = (args.regions || []).map((r) => ({ label: r, fn: regionMatcher(r) }));
  const basis = args.regionBasis || "우선순위";
  const dminstt = (args.dminsttNm || []).map(norm).filter(Boolean);
  const bizno = args.bizno ? String(args.bizno).replace(/[^0-9]/g, "") : "";
  const company = args.companyName ? stripCorp(args.companyName) : "";
  const minAmt = args.minAmount != null ? Number(args.minAmount) : null;
  const maxAmt = args.maxAmount != null ? Number(args.maxAmount) : null;
  const includeTest = !!args.includeTest;
  const rankBy = args.rankBy === "금액" ? "금액" : "건수";
  const groupBy = args.groupBy || "업체";
  const topN = Math.min(Math.max(Number(args.topN) || 30, 1), 200);
  const rowLimit = args.summaryOnly ? 0 : Math.min(Math.max(Number(args.limit ?? 30), 0), 300);

  const manifest = loadManifest();
  const coverage = [];
  const funnel = { 적재행: 0, 창중복제거: 0, 기간밖_실개찰: 0, 실개찰결측: 0, 테스트제외: 0, 키워드탈락: 0, 제외어탈락: 0, 지역탈락: 0, 기관탈락: 0, 업체탈락: 0, 금액탈락: 0, 최종: 0 };
  const regionBasisCount = { 현장지역: 0, 참가가능지역: 0, 기관명: 0 };
  const matched = [];
  let joinMissingMatched = 0;

  for (const tName of types) {
    const tk = TYPE_FILE[tName];
    const avail = availableWindows(tk);
    if (!avail.length) {
      coverage.push({ 업무구분: tName, 상태: "수집본 없음" });
      continue;
    }
    // 실개찰은 공고상 개찰예정보다 늦어질 수 있으므로 from 두 달 전 창부터 읽는다.
    const wFrom = addMonth(fromD.slice(0, 6), -2);
    const wTo = toD.slice(0, 6);
    const need = [];
    for (let w = wFrom; w <= wTo; w = addMonth(w, 1)) need.push(w);
    const have = need.filter((w) => avail.includes(w));
    const missing = need.filter((w) => !avail.includes(w) && w >= addMonth(avail[0], 0));
    const beforeData = need.filter((w) => w < avail[0]);
    const incomplete = [];
    const seen = new Set();

    for (const w of have) {
      const fname = `${tk}-${w}.json.gz`;
      const f = loadFile(fname);
      if (!f) continue;
      if (!f.award.complete) incomplete.push(w);
      const C = Object.fromEntries(f.cols.map((c, i) => [c, i]));
      for (const r of f.rows) {
        funnel.적재행++;
        const key = `${r[C.공고번호]}|${r[C.공고차수]}|${r[C.분류번호]}|${r[C.재입찰번호]}`;
        if (seen.has(key)) {
          funnel.창중복제거++;
          continue;
        }
        seen.add(key);
        const rl = String(r[C.실개찰일시] || "").replace(/[^0-9]/g, "").slice(0, 8);
        if (!rl) {
          funnel.실개찰결측++;
          continue;
        }
        if (rl < fromD || rl > toD) {
          funnel.기간밖_실개찰++;
          continue;
        }
        if (!includeTest && r[C.테스트의심]) {
          funnel.테스트제외++;
          continue;
        }
        const fieldTxt = kwFields.map((k) => norm(r[C[k]] ?? "")).join("|");
        if (keywords.length) {
          const hit = kwMode === "all" ? keywords.every((k) => fieldTxt.includes(k)) : keywords.some((k) => fieldTxt.includes(k));
          if (!hit) {
            funnel.키워드탈락++;
            continue;
          }
        }
        if (excludes.length && excludes.some((k) => norm(r[C.공고명]).includes(k))) {
          funnel.제외어탈락++;
          continue;
        }
        let rBasis = null;
        if (regionMs.length) {
          const site = r[C.현장지역] || "";
          const elig = r[C.참가가능지역] || "";
          const inst = `${r[C.수요기관] || ""}|${r[C.공고기관] || ""}`;
          const any = (txt) => regionMs.some((m) => m.fn(txt));
          if (basis === "현장지역") rBasis = any(site) ? "현장지역" : null;
          else if (basis === "참가가능지역") rBasis = any(elig) ? "참가가능지역" : null;
          else if (basis === "전부") rBasis = any(site) ? "현장지역" : any(elig) ? "참가가능지역" : any(inst) ? "기관명" : null;
          else {
            // 우선순위: 현장지역이 있으면 그것만 본다. 없으면 참가가능지역, 그것도 없으면 기관명.
            if (site) rBasis = any(site) ? "현장지역" : null;
            else if (elig) rBasis = any(elig) ? "참가가능지역" : null;
            else rBasis = any(inst) ? "기관명" : null;
          }
          if (!rBasis) {
            funnel.지역탈락++;
            continue;
          }
        }
        if (dminstt.length && !dminstt.some((d) => norm(r[C.수요기관]).includes(d) || norm(r[C.공고기관]).includes(d))) {
          funnel.기관탈락++;
          continue;
        }
        if (bizno && r[C.사업자번호] !== bizno) {
          funnel.업체탈락++;
          continue;
        }
        if (!bizno && company && !stripCorp(r[C.낙찰업체]).includes(company)) {
          funnel.업체탈락++;
          continue;
        }
        const amt = Number(r[C.낙찰금액]) || 0;
        if ((minAmt != null && amt < minAmt) || (maxAmt != null && amt > maxAmt)) {
          funnel.금액탈락++;
          continue;
        }
        if (rBasis) regionBasisCount[rBasis]++;
        if (!r[C.공고기관] && !r[C.추정가격]) joinMissingMatched++;
        matched.push({
          업무구분: tName,
          공고번호: r[C.공고번호],
          공고차수: r[C.공고차수],
          공고명: r[C.공고명],
          수요기관: r[C.수요기관],
          공고기관: r[C.공고기관],
          낙찰업체: r[C.낙찰업체],
          사업자번호: r[C.사업자번호],
          대표자: r[C.대표자],
          업체소재지: r[C.업체소재지],
          낙찰금액: amt,
          낙찰률: r[C.낙찰률],
          참가업체수: r[C.참가업체수],
          실개찰일시: r[C.실개찰일시],
          현장지역: r[C.현장지역],
          주공종: r[C.주공종],
          부공종: r[C.부공종],
          면허제한: r[C.면허제한] || undefined,
          참가가능지역: r[C.참가가능지역],
          추정가격: r[C.추정가격],
          계약방법: r[C.계약방법],
          낙찰방법: r[C.낙찰방법],
          공동수급: r[C.공동수급],
          지역판정근거: rBasis || undefined,
          테스트의심: r[C.테스트의심] ? true : undefined,
        });
      }
    }
    coverage.push({
      업무구분: tName,
      읽은창: have.length ? `${have[0]}~${have[have.length - 1]} (${have.length}개월)` : "없음",
      수집본범위: `${avail[0]}~${avail[avail.length - 1]}`,
      수집본없는창: missing.length ? missing : undefined,
      수집시작전_창: beforeData.length ? beforeData : undefined,
      수집미완료창: incomplete.length ? incomplete : undefined,
    });
  }
  funnel.최종 = matched.length;

  // ── 집계 ──
  const total = matched.reduce((s, r) => s + r.낙찰금액, 0);
  const groupKey = {
    업체: (r) => r.사업자번호 || `이름:${r.낙찰업체}`,
    수요기관: (r) => r.수요기관 || "(없음)",
    월: (r) => String(r.실개찰일시).replace(/[^0-9]/g, "").slice(0, 6),
    주공종: (r) => r.주공종 || "(공고 미연결 또는 공종 없음)",
    현장지역: (r) => (r.현장지역 || "").split(/\s+/)[0] || "(현장지역 없음)",
  }[groupBy] || ((r) => r.사업자번호 || r.낙찰업체);

  const groups = new Map();
  for (const r of matched) {
    const k = groupKey(r);
    let g = groups.get(k);
    if (!g) {
      g = { key: k, rows: [] };
      groups.set(k, g);
    }
    g.rows.push(r);
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}(${v})`).join(", ");
  const groupsOut = [...groups.values()].map((g) => {
    const sum = g.rows.reduce((s, r) => s + r.낙찰금액, 0);
    const dates = g.rows.map((r) => String(r.실개찰일시).slice(0, 10)).sort();
    const cnt = (f) => {
      const m = new Map();
      for (const r of g.rows) {
        const v = f(r);
        if (v) m.set(v, (m.get(v) || 0) + 1);
      }
      return m;
    };
    const base = {
      건수: g.rows.length,
      낙찰금액합계_억원: eok(sum),
      최대건_억원: eok(Math.max(...g.rows.map((r) => r.낙찰금액))),
      첫_실개찰: dates[0],
      마지막_실개찰: dates[dates.length - 1],
    };
    if (groupBy === "업체") {
      const r0 = g.rows[0];
      return {
        낙찰업체: r0.낙찰업체,
        사업자번호: r0.사업자번호 || undefined,
        대표자: r0.대표자 || undefined,
        업체소재지: r0.업체소재지 || undefined,
        ...base,
        현장지역_상위: top(cnt((r) => (r.현장지역 || "").split(/\s+/).slice(0, 2).join(" ")), 3) || undefined,
        주공종_상위: top(cnt((r) => r.주공종), 3) || undefined,
        면허제한_상위: top(cnt((r) => r.면허제한), 3) || undefined,
        수요기관수: cnt((r) => r.수요기관).size,
        공동수급건: g.rows.filter((r) => r.공동수급 && !/불허|없음/.test(r.공동수급)).length,
        _sum: sum,
      };
    }
    return { [groupBy]: g.key, ...base, 업체수: cnt((r) => r.사업자번호 || r.낙찰업체).size, _sum: sum };
  });
  if (groupBy === "월") groupsOut.sort((a, b) => String(a.월).localeCompare(String(b.월)));
  else groupsOut.sort((a, b) => (rankBy === "금액" ? b._sum - a._sum || b.건수 - a.건수 : b.건수 - a.건수 || b._sum - a._sum));
  const groupsTotal = groupsOut.length;
  const groupsShown = (groupBy === "월" ? groupsOut : groupsOut.slice(0, topN)).map((g, i) => {
    delete g._sum;
    return groupBy === "월" ? g : { 순위: i + 1, ...g };
  });

  const rates = matched.map((r) => r.낙찰률).filter((v) => v !== null && v !== undefined && !Number.isNaN(v) && v > 0);
  const bidders = matched.map((r) => r.참가업체수).filter((v) => v > 0);
  const amounts = matched.map((r) => r.낙찰금액).filter((v) => v > 0);

  const sortRows = args.sort === "일자" ? (a, b) => String(b.실개찰일시).localeCompare(String(a.실개찰일시)) : (a, b) => b.낙찰금액 - a.낙찰금액;
  const rows = rowLimit ? [...matched].sort(sortRows).slice(0, rowLimit) : undefined;

  const warnings = [];
  const builtAts = Object.values(manifest.files || {}).map((f) => f.builtAt).filter(Boolean).sort();
  const lastBuilt = builtAts[builtAts.length - 1];
  warnings.push(
    `수집본 기준 시각: ${lastBuilt || "알 수 없음"}. 그 이후 등록된 낙찰은 없습니다 — 최근 1개월은 search_narajangteo_scsbid로 보충하세요(개찰→낙찰 등록 지연 중앙값 약 7일).`
  );
  if (regionMs.length && basis === "우선순위")
    warnings.push(
      "지역 판정: 공고의 공사현장 지역이 있으면 그것만, 없으면 참가가능지역, 그것도 없으면 수요기관·공고기관명으로 봤습니다(지역판정근거 집계 참조). 참가가능지역은 '이 지역 업체만 참가 가능'이라는 뜻이라 현장 위치와 다를 수 있습니다."
    );
  if (joinMissingMatched)
    warnings.push(
      `공고정보가 연결되지 않은 행 ${joinMissingMatched}건이 포함됐습니다(공고 등록이 개찰 3개월보다 앞선 건 등). 이 행은 주공종·현장지역이 비어 있어 공종·지역 조건으로는 걸러지지 않고 공고명·기관명으로만 판정됐습니다.`
    );
  warnings.push(
    "장기계속공사는 총공사비가 아니라 차수분 금액으로 기록됩니다. 낙찰률은 협상계약 등에서 결측이 많아 결측을 뺀 평균을 대표값으로 쓰지 마세요."
  );
  if (rankBy === "건수" && groupBy === "업체")
    warnings.push("순위는 건수 기준(동률이면 금액)입니다. 금액 순위는 rankBy='금액'으로 따로 보세요 — 대형 1건이 순위를 뒤집습니다.");

  return {
    ok: true,
    출처: "조달청 나라장터 낙찰정보·입찰공고정보(공공데이터포털) 월별 사전수집본",
    조건: {
      업무구분: types,
      실개찰기간: `${fromD}~${toD}`,
      키워드: keywords.length ? `${kwMode === "all" ? "모두" : "하나라도"}: ${args.keywords.join(", ")} (대상: ${kwFields.join("·")})` : undefined,
      제외어: excludes.length ? args.excludeKeywords.join(", ") : undefined,
      지역: regionMs.length ? `${args.regions.join(", ")} (기준: ${basis})` : undefined,
      수요기관: dminstt.length ? args.dminsttNm.join(", ") : undefined,
      업체: bizno || args.companyName || undefined,
      금액: minAmt != null || maxAmt != null ? `${minAmt ?? ""}~${maxAmt ?? ""}원` : undefined,
      테스트공고: includeTest ? "포함" : "제외",
    },
    수집범위: coverage,
    걸러진_단계: funnel,
    지역판정근거: regionMs.length ? regionBasisCount : undefined,
    요약: {
      건수: matched.length,
      낙찰금액합계_억원: eok(total),
      낙찰업체수: new Set(matched.map((r) => r.사업자번호 || r.낙찰업체)).size,
      수요기관수: new Set(matched.map((r) => r.수요기관)).size,
      낙찰금액_분포_억원: amounts.length ? Object.fromEntries(Object.entries(quantiles(amounts)).map(([k, v]) => [k, k === "n" ? v : eok(v)])) : null,
      참가업체수_분포: quantiles(bidders),
      낙찰률_분포: quantiles(rates),
      낙찰률_결측: matched.length - rates.length,
    },
    묶음기준: groupBy,
    순위기준: groupBy === "월" ? "월순" : rankBy,
    묶음_전체수: groupsTotal,
    묶음: groupsShown,
    행: rows,
    행_반환: rows ? `${rows.length}/${matched.length} (${args.sort === "일자" ? "실개찰일 최신순" : "금액순"})` : undefined,
    주의: warnings,
    소요ms: Date.now() - t0,
  };
}

export function scsbidCacheStatus() {
  const m = loadManifest();
  return m;
}
