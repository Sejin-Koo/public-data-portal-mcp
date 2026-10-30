// 건강기능식품 품목정보 전수 수집본(data/hff/) 집계 — analyze_health_functional_food
//
// 실시간 도구(search_health_functional_food)는 한 번에 100건까지만 받고 기능성으로 거를 수 없어,
// 원료 간 제품 수·업체 집중도처럼 전수가 있어야 하는 질문에는 쓸 수 없다. 이 모듈은 월 1회 받아 둔
// 전수(scripts/refresh-hff.mjs)에서 기능성 내용·기준규격(지표성분)으로 거르고 센다.
//
// 정의(응답에도 싣는다)
//   - 건수 = 신고 품목 수(신고번호 기준, 중복 없음). 판매량·매출이 아니다.
//   - 지표성분 = 기준규격에서 '표시량'이 적힌 줄의 성분명(예: "루테인 : 표시량(20mg/…)의 80~120%").
//     성상·중금속·미생물·붕해 같은 시험 항목은 표시량이 없어 빠진다. 표기가 제품마다 달라
//     ("EPA와 DHA의 합" / "EPA+DHA") 같은 성분이 여러 이름으로 나올 수 있다.
//   - 업체 = 신고 업소명(ENTRPS). (주)·주식회사·공백을 떼어 같은 업체로 묶는다. 제조사인지
//     판매사인지는 이 자료로 가릴 수 없다.
//   - 집중도: 상위 3·5개 업체 점유율(CR3·CR5)과 HHI(점유율% 제곱합, 0~10,000).
import { readFileSync, readdirSync, existsSync } from "fs";
import { gunzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "hff");
let ROWS = null;
let META = null;

function load() {
  if (ROWS) return;
  if (!existsSync(DIR)) throw new Error("건강기능식품 수집본(data/hff/)이 없습니다. 배포 빌드가 릴리스 첨부파일을 받지 못했을 수 있습니다.");
  const files = readdirSync(DIR).filter((f) => /^hff-.*\.json\.gz$/.test(f)).sort();
  ROWS = [];
  for (const f of files) {
    const o = JSON.parse(gunzipSync(readFileSync(join(DIR, f))).toString("utf-8"));
    const ix = Object.fromEntries(o.cols.map((c, i) => [c, i]));
    for (const r of o.rows) {
      ROWS.push({
        업체: r[ix.ENTRPS], 제품명: r[ix.PRDUCT], 신고번호: r[ix.STTEMNT_NO], 등록일: r[ix.REGIST_DT],
        기능성: r[ix.MAIN_FNCTN], 기준규격: r[ix.BASE_STANDARD],
      });
    }
  }
  let m = {}, c = {};
  try { m = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf-8")); } catch {}
  try { c = JSON.parse(readFileSync(join(DIR, "collected.json"), "utf-8")); } catch {}
  META = { ...m, ...c };
}

const squash = (s) => String(s || "").replace(/\s+/g, "").toLowerCase();
const normCo = (s) => String(s || "").replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|농업회사법인|\s+/g, "").trim();

// 기준규격에서 지표성분 이름 뽑기
const TEST_ITEMS = /^(성상|납|비소|카드뮴|수은|대장균|대장균군|세균수|붕해|붕해시험|산가|과산화물가|수분|잔류용매|총아플라톡신|아플라톡신|이물|타르색소|살모넬라|황색포도상구균|리스테리아)/;
export function indicatorNames(bs) {
  const out = [];
  for (let ln of String(bs || "").split(/\n|\s\/\s|(?=\(\d+\)\s)|(?=\s\d+[).]\s)/)) {
    if (!/표시량/.test(ln)) continue;
    ln = ln.replace(/^\s*[\(\[]?\d+[\)\].]?\s*/, "").replace(/^\s*[①-⑳]\s*/, "");
    const i = ln.search(/[:：]/);
    if (i <= 0) continue;
    let name = ln.slice(0, i).replace(/\s+/g, " ").replace(/\s*\(.*?\)\s*$/, "").trim();
    if (!name || name.length > 40 || TEST_ITEMS.test(name)) continue;
    out.push(name);
  }
  return [...new Set(out)];
}

function concentration(counter, total) {
  const arr = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  const share = (n) => (total ? (n / total) * 100 : 0);
  const cr = (k) => Math.round(arr.slice(0, k).reduce((s, x) => s + share(x[1]), 0) * 10) / 10;
  const hhi = Math.round(arr.reduce((s, x) => s + share(x[1]) ** 2, 0));
  return { 업체수: arr.length, CR3: cr(3), CR5: cr(5), HHI: hhi, arr };
}

function inRange(d, from, to) {
  if (!from && !to) return true;
  if (!/^\d{8}$/.test(d)) return false;
  const f = from ? String(from).padEnd(8, "0") : "00000000";
  const t = to ? (String(to).length === 4 ? to + "1231" : String(to).length === 6 ? to + "31" : String(to)) : "99999999";
  return d >= f && d <= t;
}

/**
 * @param {object} a
 *  functionKeywords  기능성 내용에서 찾을 말(목록). 공백 무시 부분 일치
 *  functionMode      any(기본)/all
 *  ingredients       원료 목록. "루테인|마리골드꽃추출물"처럼 | 로 별칭을 묶으면 하나로 센다
 *  ingredientFields  원료를 찾을 칸: 기준규격(기본)·기능성·제품명
 *  company           업체명 부분 일치
 *  productKeywords   제품명 부분 일치(목록, any)
 *  from, to          등록일 YYYY / YYYYMM / YYYYMMDD
 *  topN              업체·지표성분 묶음 개수(기본 15)
 *  limit             표본 행 수(기본 10, 최대 200)
 *  recentYears       최근 추이 연수(기본 5)
 */
export function analyzeHff(a = {}) {
  load();
  const fkw = (a.functionKeywords || []).map(squash).filter(Boolean);
  const fall = a.functionMode === "all";
  const pkw = (a.productKeywords || []).map(squash).filter(Boolean);
  const co = a.company ? normCo(a.company).toLowerCase() : "";
  const fields = (a.ingredientFields && a.ingredientFields.length ? a.ingredientFields : ["기준규격"]);
  const topN = Math.min(Math.max(Number(a.topN) || 15, 1), 100);
  const limit = a.limit !== undefined && Number(a.limit) === 0 ? 0 : Math.min(Math.max(Number(a.limit) || 10, 1), 200);
  const recentYears = Math.min(Math.max(Number(a.recentYears) || 5, 1), 15);

  const ings = (a.ingredients || []).map((s) => {
    const names = String(s).split("|").map((x) => x.trim()).filter(Boolean);
    return { label: names[0], aliases: names.slice(1), keys: names.map(squash) };
  }).filter((x) => x.keys.length);

  const 탈락 = { 기능성: 0, 업체: 0, 제품명: 0, 등록일: 0 };
  const base = [];
  for (const r of ROWS) {
    if (fkw.length) {
      const t = squash(r.기능성);
      const ok = fall ? fkw.every((k) => t.includes(k)) : fkw.some((k) => t.includes(k));
      if (!ok) { 탈락.기능성++; continue; }
    }
    if (co && !normCo(r.업체).toLowerCase().includes(co)) { 탈락.업체++; continue; }
    if (pkw.length && !pkw.some((k) => squash(r.제품명).includes(k))) { 탈락.제품명++; continue; }
    if (!inRange(r.등록일, a.from, a.to)) { 탈락.등록일++; continue; }
    base.push(r);
  }

  const thisYear = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
  const yearsWanted = Array.from({ length: recentYears }, (_, i) => String(thisYear - recentYears + 1 + i));
  const yearCount = (rows) => {
    const c = Object.fromEntries(yearsWanted.map((y) => [y, 0]));
    for (const r of rows) { const y = (r.등록일 || "").slice(0, 4); if (y in c) c[y]++; }
    return c;
  };
  const coCounter = (rows) => {
    const m = new Map(), raw = new Map();
    for (const r of rows) {
      const k = normCo(r.업체) || "(업체명 없음)";
      m.set(k, (m.get(k) || 0) + 1);
      if (!raw.has(k)) raw.set(k, r.업체);
    }
    return { m, raw };
  };
  const coTable = (rows) => {
    const { m, raw } = coCounter(rows);
    const c = concentration(m, rows.length);
    return {
      집중도: { 업체수: c.업체수, CR3: c.CR3, CR5: c.CR5, HHI: c.HHI },
      상위업체: c.arr.slice(0, topN).map(([k, n]) => ({ 업체: raw.get(k), 건수: n, 점유율: Math.round((n / rows.length) * 1000) / 10 })),
    };
  };

  // 원료별
  const 원료별 = ings.map((ing) => {
    const hit = base.filter((r) => fields.some((f) => {
      const t = squash(f === "기준규격" ? r.기준규격 : f === "기능성" ? r.기능성 : r.제품명);
      return ing.keys.some((k) => t.includes(k));
    }));
    return {
      원료: ing.label, 별칭: ing.aliases.length ? ing.aliases : undefined,
      건수: hit.length,
      비중: base.length ? Math.round((hit.length / base.length) * 1000) / 10 : 0,
      ...coTable(hit),
      연도별: yearCount(hit),
    };
  });

  // 지표성분 후보(걸러진 집합 안에서) — 원료를 일반 지식으로 정하지 말고 여기서 열거한 뒤 비교한다
  const ind = new Map();
  for (const r of base) for (const n of indicatorNames(r.기준규격)) ind.set(n, (ind.get(n) || 0) + 1);
  const 지표성분 = [...ind.entries()].sort((x, y) => y[1] - x[1]).slice(0, topN).map(([n, c]) => ({ 지표성분: n, 건수: c }));

  const sample = base.slice().sort((x, y) => (y.등록일 > x.등록일 ? 1 : -1)).slice(0, limit).map((r) => ({
    신고번호: r.신고번호, 업체: r.업체, 제품명: r.제품명, 등록일: r.등록일,
    기능성: r.기능성.slice(0, 160), 지표성분: indicatorNames(r.기준규격),
  }));

  return {
    수집본: {
      원천: META.원천 || "식약처 건강기능식품 품목정보",
      수집시각: META.수집시각 || null,
      원천_totalCount: META.totalCount ?? null,
      보유건수: ROWS.length,
      전수여부: META.totalCount ? META.totalCount === ROWS.length : null,
    },
    조건: {
      functionKeywords: a.functionKeywords, functionMode: fall ? "all" : "any", ingredients: a.ingredients,
      ingredientFields: fields, company: a.company, productKeywords: a.productKeywords, from: a.from, to: a.to,
    },
    걸러진_단계: 탈락,
    일치건수: base.length,
    전체: { ...coTable(base), 연도별: yearCount(base) },
    원료별: 원료별.length ? 원료별 : undefined,
    지표성분_상위: 지표성분,
    표본: limit ? sample : undefined,
    정의: {
      건수: "신고 품목 수(신고번호 기준). 판매량·매출이 아님",
      지표성분: "기준규격에서 '표시량'이 적힌 줄의 성분명. 표기 변형(예: EPA와 DHA의 합 / EPA+DHA)은 따로 센다",
      업체: "신고 업소명. (주)·주식회사·공백을 떼어 묶음. 제조·판매 구분 불가",
      집중도: "CR3·CR5 = 상위 3·5개 업체 점유율(%), HHI = 점유율(%) 제곱합(0~10,000)",
      원료별: "ingredientFields 칸에 원료명(별칭 포함)이 들어 있는 품목 수. 한 품목이 여러 원료에 동시에 잡힐 수 있어 원료별 합은 일치건수보다 클 수 있음",
      연도별: "등록일 연도 기준 신고 건수. 올해는 수집 시각까지",
    },
    주의: [
      "수집본은 월 1회 갱신된다. 수집 시각 이후 신고분은 search_health_functional_food(신고번호·제품명 단건)로 확인한다.",
      "원료 간 제품 수 비교는 제품명 검색이 아니라 이 도구의 기준규격·기능성 기준 건수로 낸다.",
    ],
  };
}
