// public-data-portal-mcp / lib/bizno_resolver.js
//
// "회사명 ↔ 사업자등록번호 10자리" 공통 해석기.
//
// 왜 공통 파일인가: 공공데이터포털 계열 API는 기관이 달라도 회사를 사업자등록번호
// 10자리 완전일치로만 좁히는 경우가 많다. 근로복지공단 고용·산재보험(v_saeopjaDrno)이
// 그랬고, 식약처 의약품 계열(bizrno)도 같다. 회사명 부분검색은 그룹 접두어에서 계열사를
// 끌고 들어온다 — 실측(2026-08-26): entp_name="대웅" 567건 vs bizrno=1248601143 244건.
//
// 이 로직은 원래 comwel_client.js 안에 있어 4대보험 도구 전용이었다. 사업자등록번호를
// 받는 도구가 늘면서 공통 파일로 분리했고, 이후 기업 조사 전반에서 쓰도록
// resolve_bizno 도구로도 노출했다. 새 도구는 resolveBizNo 한 줄만 부르면 된다.
//
// ── 해석 경로는 세 단계다 ────────────────────────────────────────────────────
//
// 1단계 DART. 정적 인덱스(data/corp_name_index.json.gz)에서 회사명 → corp_code를 찾고,
//   OpenDART 기업개황(company.json)을 한 번 호출해 bizr_no를 받는다. 회사명으로 corp_code를
//   찾는 API가 OpenDART에 없고, 전체 목록 corpCode.xml은 다운로드에만 3분 39초가 걸려
//   (2026-08-25 실측) Vercel 함수의 maxDuration 60초 안에 받을 수 없기 때문이다.
//   이 경로는 법인등록번호·종목코드까지 함께 준다. 인덱스는 GitHub Actions가 매주 갱신한다.
//
// 2단계 키스콘. DART는 상장·외감법인 위주라 소규모 비상장사가 통째로 빠진다. 그 구간을
//   메우려고 국토교통부 키스콘 건설업체 공시에서 사업자등록번호·상호를 모아 둔 누적 색인
//   (data/kiscon_bizno_index.json.gz)을 2단계로 본다. 건설업 등록업체에 한정되지만,
//   DART 미등록 비상장사를 실제로 해석할 수 있는 유일한 경로다.
//
// 3단계 SWIT(소프트웨어사업자 신고). DART·키스콘 어디에도 없는 비상장·비건설업 법인 중,
//   소프트웨어산업진흥법에 따라 SW사업자로 신고된 곳이라면 SWIT(www.swit.or.kr, NIPA 운영)
//   공개 검색(인증키 불요)으로 확인할 수 있다. 화면 표에는 사업자등록번호 열이 없지만,
//   상세보기 onclick 핸들러(showDetail(...))에 10자리 번호가 그대로 실려 있다.
//   실측(2026-09-10, 로컬 스크립트로 브라우저형 UA GET 호출): "포니링크" 검색 →
//   1198137606, DART 기업개황의 실제 사업자등록번호와 정확히 일치해 파싱 로직의
//   신뢰성은 확인했다. 이름 검색만 지원해 정방향(회사명→번호)에서만 쓴다.
//
//   ★★ 단, SWIT는 **클라우드/데이터센터 IP를 차단한다.** Vercel에서 직접 호출하면
//   TCP 연결 후 곧바로 리셋된다(`ECONNRESET`, 2026-09-10 실측 — DNS 실패도 타임아웃도
//   아니다). 그래서 이 단계는 **Nimble Web API를 국내 IP 경유 프록시로 써서**
//   호출한다(`NIMBLE_API_KEY` 환경변수, `country: "KR"`). Nimble 경유로는 정상
//   조회되며, 포니링크(1198137606)·삼성에스디에스(1108128774) 둘 다 DART 기업개황의
//   실제 사업자등록번호와 일치하는 것을 확인했다.
//   키가 없으면 직접 호출로 폴백하지만 그 경로는 위 이유로 사실상 항상 실패한다.
//
//   SW사업자 신고가 없는 회사는 이 경로로도 못 찾지만, 그 자체가 정상이다 — 신고 대상이
//   아닌 업종일 뿐 "회사가 없다"는 뜻이 아니다. "신고 없음"(빈 배열)과 "조회 실패"
//   (switError)는 반드시 구분해서 읽을 것. 정적 인덱스가 아니라 매 호출마다 실시간
//   조회하므로(외부 왕복 + Nimble 과금) 세 번째 순서로 둔다.
//
// ★ 세 소스의 갱신 방식이 다르다. DART 인덱스는 매주 **통째로 교체**되고, 키스콘 색인은
//   월 1회 **누적 병합**된다(사명 변경 이력이 배열로 쌓이므로 옛 사명으로도 찾힌다). SWIT는
//   색인 파일이 없다 — 매번 그 자리에서 조회한다.
//   ★ DART·키스콘 두 파일을 하나로 합치면 안 된다 — 합치면 키스콘 누적분이 다음 주에 날아간다.
//
// ★ 휴업·폐업 상태는 위 세 소스 어디에도 없다. 그래서 해석이 끝난 뒤 **국세청 사업자등록
//   상태조회를 조회 시점에 실시간으로 붙인다**(아래 ntsStatus / resolveCompanyIdentifiers).
//   색인에 굳혀 넣지 않는 것이 핵심이다 — 굳히면 갱신 주기 내내 낡은 값을 답하게 된다.

import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rawFetch, SERVICE_KEY } from "./pdp_client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "..", "data", "corp_name_index.json.gz");
const KISCON_INDEX_PATH = join(__dirname, "..", "data", "kiscon_bizno_index.json.gz");
const DART_API = "https://opendart.fss.or.kr/api";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let corpIndexCache = null;

export function loadCorpIndex() {
  if (corpIndexCache !== null) return corpIndexCache;
  try {
    const payload = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString("utf-8"));
    corpIndexCache = payload;
  } catch (e) {
    corpIndexCache = { map: {}, generatedAt: null, count: 0, loadError: e.message };
  }
  return corpIndexCache;
}

/** 회사명 정규화 — 법인격 표기(주식회사·(주)·㈜)와 공백을 제거해 대조한다. */
export function normalizeCorpName(s) {
  if (!s) return "";
  return String(s)
    .normalize("NFKC")
    .replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function normalizeBizNo(s) {
  const d = String(s ?? "").replace(/[^0-9]/g, "");
  if (d.length === 9) return `0${d}`;
  return d.length === 10 ? d : null;
}

export function lookupCorpCode(companyName) {
  const idx = loadCorpIndex();
  const key = normalizeCorpName(companyName);
  if (!key) return null;
  const hit = idx.map?.[key];
  if (!hit) return null;
  return { corpCode: hit[0], corpName: hit[1], indexGeneratedAt: idx.generatedAt };
}

// ── 키스콘 누적 색인 ─────────────────────────────────────────────────────────
//
// 파일에는 사업자등록번호 → {n:[상호 최신순], r:대표자, a:지역, i:건설업 면허 업종,
// d:최근관측일}만 담는다. 상호 → 번호 역방향은 파일 크기를 두 배로 만들므로 저장하지 않고
// 여기서 만든다.
// 20만 건 규모에서 수십 ms이고, 워밍된 함수 인스턴스에서는 한 번만 돈다.

let kisconCache = null;
let kisconNameMap = null;

export function loadKisconIndex() {
  if (kisconCache !== null) return kisconCache;
  try {
    kisconCache = JSON.parse(gunzipSync(readFileSync(KISCON_INDEX_PATH)).toString("utf-8"));
  } catch (e) {
    kisconCache = { byBizNo: {}, generatedAt: null, count: 0, loadError: e.message };
  }
  return kisconCache;
}

function kisconNames() {
  if (kisconNameMap !== null) return kisconNameMap;
  const idx = loadKisconIndex();
  const m = new Map();
  for (const [bizNo, v] of Object.entries(idx.byBizNo || {})) {
    for (const n of v.n || []) {
      const k = normalizeCorpName(n);
      if (!k) continue;
      const arr = m.get(k);
      if (arr) {
        if (!arr.includes(bizNo)) arr.push(bizNo);
      } else m.set(k, [bizNo]);
    }
  }
  kisconNameMap = m;
  return m;
}

/** 사업자등록번호 → 키스콘 색인 레코드. 없으면 null. */
export function kisconByBizNo(bizNo) {
  const b = normalizeBizNo(bizNo);
  if (!b) return null;
  const v = loadKisconIndex().byBizNo?.[b];
  if (!v) return null;
  return {
    bizNo: b,
    상호: v.n?.[0] ?? null,
    상호이력: v.n || [],
    대표자: v.r ?? null,
    지역: v.a ?? null,
    // ★ 이 값은 키스콘의 **건설업 등록 면허 업종**이지 그 회사의 주력 업종이 아니다.
    //   "업종"이라는 일반적인 이름으로 내보냈더니 삼성전자에 "금속구조물·창호·온실공사업"이
    //   붙어 주력 업종으로 오해되는 일이 실제로 있었다(2026-09-10). 이름으로 구분한다.
    건설업면허업종: v.i ?? null,
    최근관측일: v.d ?? null,
  };
}

/**
 * 상호 → 키스콘 색인 레코드 배열. 같은 상호를 쓰는 업체가 여럿이면 여러 건이 나온다.
 *
 * ★ 정렬이 중요하다. 상호 이력을 누적하다 보니 "지금은 다른 이름인데 예전에 그 상호를 썼던"
 *   업체가 함께 걸린다(실측: "지에스건설"로 10곳 이상). 그래서
 *   ①현재 상호가 일치하는 업체를 먼저, ②그중에서도 최근 관측일이 늦은 순으로 세운다.
 *   호출부는 이 순서를 그대로 후보 목록에 실어, 사람이 대표자·지역·업종으로 고르게 한다.
 */
export function kisconByName(companyName) {
  const key = normalizeCorpName(companyName);
  if (!key) return [];
  const hits = kisconNames().get(key) || [];
  return hits
    .map((b) => kisconByBizNo(b))
    .filter(Boolean)
    .map((r) => ({ ...r, 현재상호일치: normalizeCorpName(r.상호) === key }))
    .sort((a, b) => {
      if (a.현재상호일치 !== b.현재상호일치) return a.현재상호일치 ? -1 : 1;
      return String(b.최근관측일 || "").localeCompare(String(a.최근관측일 || ""));
    });
}

/**
 * DART 기업개황에서 사업자등록번호 10자리를 가져온다.
 * 게이트웨이가 간헐적으로 "upstream connect error"(JSON이 아닌 평문)를 돌려주는 것을
 * 스모크테스트에서 실측했으므로, 파싱 실패도 재시도 대상으로 삼는다. 재시도가 없으면
 * 회사명 해석이 조용히 실패해 "DART 미등록"으로 오분류된다.
 */
export async function dartBizNo(corpCode, { retries = 3 } = {}) {
  const key = process.env.DART_API_KEY || "";
  if (!key) return { ok: false, transient: false, reason: "DART_API_KEY 미설정" };
  const url = `${DART_API}/company.json?crtfc_key=${encodeURIComponent(key)}&corp_code=${corpCode}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { text } = await rawFetch(url, {}, 15000);
      let d;
      try {
        d = JSON.parse(text);
      } catch {
        lastErr = `JSON 아님: ${String(text).slice(0, 60)}`;
        d = null;
      }
      if (d) {
        if (d.status !== "000") {
          // status 013(자료 없음)처럼 서버가 정상 응답한 경우는 재시도해도 결과가 같다.
          // 일시적 연결 오류와 구분해 두지 않으면 "잠시 뒤 다시 해보라"는 엉뚱한 안내가 나간다.
          return { ok: false, transient: false, reason: `DART status ${d.status}: ${d.message}` };
        }
        const raw = String(d.bizr_no || "").replace(/\D/g, "");
        if (raw.length !== 10) return { ok: false, reason: "DART 기업개황에 사업자등록번호가 없습니다" };
        return {
          ok: true,
          bizNo: raw,
          corpName: d.corp_name,
          jurirNo: String(d.jurir_no || "").replace(/\D/g, "") || null,
          stockCode: (d.stock_code || "").trim(),
          ceoName: (d.ceo_nm || "").trim() || null,
          address: (d.adres || "").trim() || null,
          estDate: (d.est_dt || "").trim() || null,
        };
      }
    } catch (e) {
      lastErr = e.message;
    }
    if (attempt < retries) await sleep(600 * attempt);
  }
  return { ok: false, transient: true, reason: `DART 호출 실패(${retries}회 재시도): ${lastErr}` };
}

// ── SWIT 소프트웨어사업자 검색 (3단계) ───────────────────────────────────────
//
// 인증키 없는 공개 GET 검색. 화면 표에는 사업자등록번호 열이 없지만, 각 행의 상세보기
// 링크(showDetail(document.birPublic_SearhList,'<entRegno>','<회사명>', ...))에 10자리
// 사업자등록번호가 그대로 실려 있다. entRegno == 사업자등록번호임을 "포니링크" 검색으로
// 실측 확인했다(1198137606, DART 대조 일치, 2026-09-10).
const SWIT_SEARCH_URL = "https://www.swit.or.kr/IS/web/birPublic_SearhList.jsp";

// Nimble Web API — SWIT의 클라우드 IP 차단을 우회하는 국내 경유 프록시.
// 인증은 `Authorization: Bearer <API키>`다. 공식 문서에는 계정 이메일·비밀번호를
// base64로 묶는 `Basic` 방식이 안내되어 있으나, 현행 API키는 Basic으로 보내면
// 401 "No supported authentication method found"가 난다(2026-09-10 실측). Bearer를 쓸 것.
const NIMBLE_API_URL = "https://api.webit.live/api/v1/realtime/web";

/** SWIT 검색 결과 HTML에서 회사명·사업자등록번호 쌍을 전부 뽑는다. */
function parseSwitHits(html) {
  const re = /showDetail\(document\.birPublic_SearhList,\s*'(\d{10})'\s*,\s*'([^']*)'/g;
  const hits = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    hits.push({ bizNo: m[1], 상호: m[2] || null });
  }
  return hits;
}

/**
 * 받아온 HTML이 **정말 SWIT 검색결과 페이지인지** 확인한다.
 *
 * ★★ 이 가드가 없으면 오류 페이지가 조용히 "0건 = 신고 없음"이 된다. 실제로 그랬다
 *   (2026-09-11 발견): `rawFetch`는 HTTP 상태를 검사하지 않고 {status, text}를 그대로
 *   돌려주므로, SWIT가 503을 주면 본문("DNS resolution failed…")에 매칭이 없어 빈 배열이
 *   나오고, 호출부는 그것을 "SW사업자 등록이 없다"로 읽었다. 도구 설명이 보장하는
 *   "신고 없음 vs 조회 실패" 구분이 정면으로 깨지는 경로였다.
 *
 * 검색어가 0건이어도 페이지 골격(검색 폼)은 그대로 오므로, 폼 이름을 마커로 쓴다.
 * 실측: '대아글로벌'(0건)·'포니링크'(1건) 응답 모두에 이 문자열이 있다.
 */
function looksLikeSwitPage(html) {
  return typeof html === "string" && html.includes("birPublic_SearhList");
}

/** SWIT 검색 URL을 만든다. */
function switSearchUrl(companyName) {
  const qsStr = new URLSearchParams({
    compNm: companyName,
    mode: "1",
    compstatuscd: "X",
    complimitfg: "X",
    lagfgcd: "X",
    approval: "X",
    pageNum: "1",
  }).toString();
  return `${SWIT_SEARCH_URL}?${qsStr}`;
}

/**
 * Nimble Web API를 통해 SWIT 페이지를 받아온다. country: "KR"로 국내 IP를 경유시킨다.
 * 반환은 HTML 문자열. 실패하면 예외를 던진다(호출부가 잡는다).
 *
 * ★ render는 false로 둔다. SWIT 검색 결과는 서버가 렌더한 HTML에 이미 들어 있어
 *   자바스크립트 실행이 필요 없고, render:true는 과금 단가가 올라간다.
 */
async function switViaNimble(companyName, apiKey) {
  const res = await fetch(NIMBLE_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: switSearchUrl(companyName), country: "KR", render: false }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Nimble HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const d = await res.json();
  if (d.status && d.status !== "success") {
    throw new Error(`Nimble status=${d.status}: ${(d.msg || "").slice(0, 200)}`);
  }
  const html = d.html_content || "";
  if (!html) throw new Error("Nimble 응답에 html_content가 비어 있습니다");
  return html;
}

/**
 * 회사명으로 SWIT 소프트웨어사업자를 검색한다.
 *
 * 성공하면 항상 배열을 돌려준다(0건도 빈 배열 — "신고 없음"은 정상 결과이지 실패가
 * 아니다). 호출 자체가 실패했을 때만 { transient: true, reason } 모양으로 구분해서
 * 돌려준다 — resolveBizNo가 "등록 없음"과 "조회 실패"를 섞지 않도록 하기 위해서다.
 *
 * ★ NIMBLE_API_KEY가 설정돼 있으면 Nimble 경유로 부른다(권장 — 직접 호출은 SWIT의
 *   클라우드 IP 차단에 걸려 ECONNRESET으로 실패한다). 키가 없으면 직접 호출로
 *   폴백하는데, 그 경로는 현재 사실상 항상 실패한다는 점을 알고 쓸 것.
 */
export async function switByName(companyName, { retries = 2 } = {}) {
  if (!companyName) return [];
  const apiKey = process.env.NIMBLE_API_KEY || "";
  const url = switSearchUrl(companyName);
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (apiKey) {
        const html = await switViaNimble(companyName, apiKey);
        if (!looksLikeSwitPage(html)) {
          throw new Error(`SWIT 검색결과 페이지가 아닙니다(본문 ${html.length}자). 차단 페이지이거나 사이트 구조가 바뀌었을 수 있습니다`);
        }
        return parseSwitHits(html);
      }
      // ★ rawFetch는 HTTP 상태를 검사하지 않는다 — 여기서 직접 본다. 이 검사가 없으면
      //   503 오류 본문에 매칭이 없어 "0건 = 신고 없음"으로 조용히 뒤바뀐다.
      const { status, text } = await rawFetch(url, {}, 15000);
      if (status < 200 || status >= 300) {
        throw new Error(`SWIT HTTP ${status}: ${String(text).slice(0, 120)}`);
      }
      if (!looksLikeSwitPage(text)) {
        throw new Error(`SWIT 검색결과 페이지가 아닙니다(HTTP ${status}, 본문 ${String(text).length}자)`);
      }
      return parseSwitHits(text);
    } catch (e) {
      // ★ Node fetch는 실패 시 message가 "fetch failed"뿐이고 진짜 원인은 e.cause에
      //   있다(ENOTFOUND/ECONNRESET/UND_ERR_CONNECT_TIMEOUT 등). cause를 못 뽑으면
      //   "fetch failed"만 남아 원인 진단이 안 된다 — 실제로 이 문제로 한 번 막혔다
      //   (2026-09-10, cause 없이 "SWIT 호출 실패: fetch failed"만 보고 원인을 못 좁힘).
      const causeDetail = e.cause
        ? `${e.cause.code || e.cause.errno || ""} ${e.cause.message || e.cause}`.trim()
        : null;
      lastErr = causeDetail ? `${e.message} (cause: ${causeDetail})` : e.message;
    }
    if (attempt < retries) await sleep(600 * attempt);
  }
  const via = apiKey ? "Nimble 경유" : "직접 호출(NIMBLE_API_KEY 미설정)";
  return { transient: true, reason: `SWIT 호출 실패(${via}, ${retries}회 재시도): ${lastErr}` };
}

// ── 국세청 사업자등록 상태조회 ───────────────────────────────────────────────
//
// 위 세 경로가 "이 번호가 어느 회사냐"를 답한다면, 이쪽은 "그 번호가 지금도 살아 있냐"를
// 답한다. 공공데이터포털 계열이고 **DATA_PORTAL_KEY를 그대로 쓴다**(별도 키 불필요 —
// 2026-09-10 실측). 한 번에 여러 건을 물을 수 있어 후보가 여럿이어도 호출 1회로 끝난다.
//
// ★★ **이 결과는 절대 색인에 저장하지 않는다.** 휴폐업은 수시로 바뀌는데 색인은 스냅샷이라
//   (DART 주 1회 / 키스콘 월 1회), 굳혀 두면 갱신 주기 내내 낡은 값을 답하게 된다. 그래서
//   조회 시점에 실시간으로만 묻는다. 이 구분이 중요하다 — 종전 주석의 "휴폐업은 답하지
//   않는다"는 **색인에 넣지 말라**는 뜻이었지 물어보지도 말라는 뜻이 아니었다.
//
// ★ 번호를 알아야 상태를 답하는 구조라 **회사명으로 번호를 찾는 용도로는 쓸 수 없다.**
//   resolve_bizno의 대체재가 아니라 그 뒤에 붙는 검증 단계다.
const NTS_STATUS_URL = "https://api.odcloud.kr/api/nts-businessman/v1/status";

/**
 * 사업자등록번호 여러 건의 국세청 등록 상태를 한 번에 조회한다.
 *
 * 반환: { ok: true, byBizNo: { "1198137606": {상태, 상태코드, 폐업일, 과세유형} } }
 *       실패 시 { ok: false, reason }.
 *
 * ★ **조회 실패를 "폐업"으로 읽지 말 것.** 응답이 없는 것과 폐업은 전혀 다르다. 실패는
 *   ok:false로 구분해 돌려주고, 호출부는 그것을 상태 미확인으로 표시한다.
 * ★ 국세청에 등록 이력이 없는 번호는 b_stt가 빈 문자열로 온다 — "국세청에 등록되지 않은
 *   번호"로 표기한다. 이것도 폐업과 다르다.
 */
export async function ntsStatus(bizNos = []) {
  const list = [...new Set(bizNos.map(normalizeBizNo).filter(Boolean))];
  if (!list.length) return { ok: true, byBizNo: {} };
  if (!SERVICE_KEY) return { ok: false, reason: "DATA_PORTAL_KEY 미설정" };
  try {
    const res = await fetch(`${NTS_STATUS_URL}?serviceKey=${encodeURIComponent(SERVICE_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b_no: list }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, reason: `국세청 상태조회 HTTP ${res.status}: ${detail.slice(0, 200)}` };
    }
    const d = await res.json();
    const byBizNo = {};
    for (const x of d.data || []) {
      byBizNo[x.b_no] = {
        상태: x.b_stt || "국세청에 등록되지 않은 번호",
        상태코드: x.b_stt_cd || null,
        폐업일: x.end_dt || null,
        과세유형: x.tax_type || null,
      };
    }
    return { ok: true, byBizNo, 조회시각: new Date().toISOString() };
  } catch (e) {
    const causeDetail = e.cause
      ? `${e.cause.code || e.cause.errno || ""} ${e.cause.message || e.cause}`.trim()
      : null;
    return {
      ok: false,
      reason: `국세청 상태조회 실패: ${causeDetail ? `${e.message} (cause: ${causeDetail})` : e.message}`,
    };
  }
}

/**
 * 회사명 하나로 사업자등록번호 10자리를 해석한다. (기존 도구들이 부르는 진입점 — 반환
 * 모양을 바꾸지 않는다. 필드는 늘었지만 ok·bizNo·reason·resolvedVia는 그대로다.)
 *
 * 반환값은 성공·실패 모두 같은 모양이다. 호출하는 쪽은 ok만 보고 분기하고, 실패해도
 * 예외를 던지지 않으므로 "해석 실패 시 회사명 부분검색으로 폴백" 같은 처리를 각 도구가
 * 자유롭게 할 수 있다. 어느 경로를 탔는지는 resolvedVia에 남겨 답변에 그대로 옮긴다.
 *
 * ★ 세 소스 어디에도 없는 회사(DART 미등록 + 건설업 미등록 + SW사업자 미신고)는
 *   해석이 불가능하다. 실패 사유를 reason에 담아 돌려주되, **"그 회사가 존재하지
 *   않는다"는 뜻이 아니다.**
 * ★ 같은 상호를 쓰는 업체가 여럿이면 하나를 고르지 않고 candidates에 전부 담아 ok=false로
 *   돌려준다. 임의로 하나를 고르면 엉뚱한 회사의 재무·처분 이력을 답하게 된다.
 */
export async function resolveBizNo(companyName) {
  const out = {
    ok: false,
    입력회사명: companyName || null,
    bizNo: null,
    resolvedVia: null,
    indexGeneratedAt: null,
    reason: null,
  };
  if (!companyName) {
    out.reason = "회사명이 비어 있습니다";
    return out;
  }

  // ── 1단계 DART ──
  const hit = lookupCorpCode(companyName);
  if (hit) {
    out.indexGeneratedAt = hit.indexGeneratedAt;
    out.matchedCorpName = hit.corpName;
    const dart = await dartBizNo(hit.corpCode);
    if (dart.ok) {
      out.ok = true;
      out.bizNo = dart.bizNo;
      out.jurirNo = dart.jurirNo;
      out.corpCode = hit.corpCode;
      out.stockCode = dart.stockCode || null;
      out.대표자 = dart.ceoName;
      out.소재지 = dart.address;
      out.설립일 = dart.estDate || null;
      out.matchedCorpName = dart.corpName || hit.corpName;
      out.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no)";
      return out;
    }
    out.reason = dart.reason;
    // DART 인덱스에는 있는데 기업개황 호출이 실패한 경우다. 키스콘으로 한 번 더 시도하되,
    // "DART에 있는 회사인데 호출이 안 됐다"는 사실을 반드시 함께 돌려준다 — 이걸 감추면
    // 상장사인데 건설업 색인의 동명 업체로 잘못 풀려도 티가 나지 않는다.
    out.dartError = dart.reason;
    out.dartErrorTransient = dart.transient !== false;
  }

  // ── 2단계 키스콘 ──
  const kis = kisconByName(companyName);
  const kIdx = loadKisconIndex();
  if (kis.length === 1) {
    const k = kis[0];
    out.ok = true;
    out.bizNo = k.bizNo;
    out.matchedCorpName = k.상호;
    out.상호이력 = k.상호이력;
    out.대표자 = k.대표자;
    out.지역 = k.지역;
    out.건설업면허업종 = k.건설업면허업종;
    out.indexGeneratedAt = kIdx.generatedAt;
    out.resolvedVia = hit
      ? "companyName → 키스콘 건설업체 색인 (DART 기업개황 실패 후 폴백)"
      : "companyName → 키스콘 건설업체 색인";
    out.reason = null;
    return out;
  }
  if (kis.length > 1) {
    out.candidates = kis.slice(0, 20);
    out.candidateTotal = kis.length;
    out.indexGeneratedAt = kIdx.generatedAt;
    const nowNamed = kis.filter((k) => k.현재상호일치).length;
    out.reason =
      `같은 상호의 건설업 등록업체가 ${kis.length}곳이라 하나로 좁히지 못했습니다` +
      (nowNamed < kis.length
        ? `(현재 상호가 일치하는 곳 ${nowNamed}곳, 나머지는 과거에 이 상호를 썼다가 개명한 업체입니다)`
        : "") +
      ". candidates에서 대표자·지역·건설업면허업종·최근관측일로 고른 뒤 사업자등록번호를 직접 넘기세요.";
    return out;
  }

  // ── 3단계 SWIT ──
  // DART·키스콘 둘 다 회사를 특정하지 못했을 때만 여기까지 온다(특정했으면 이미 위에서
  // return했다). SW사업자로 신고되지 않은 회사는 여기서도 0건이며, 그 자체가 정상이다 —
  // 신고 대상이 아닌 업종일 뿐 "회사가 없다"는 뜻이 아니다.
  const swit = await switByName(companyName);
  if (Array.isArray(swit)) {
    if (swit.length === 1) {
      out.ok = true;
      out.bizNo = swit[0].bizNo;
      out.matchedCorpName = swit[0].상호;
      out.resolvedVia = hit
        ? "companyName → SWIT 소프트웨어사업자 검색 (DART 기업개황 실패 후 폴백)"
        : "companyName → SWIT 소프트웨어사업자 검색";
      out.reason = null;
      return out;
    }
    if (swit.length > 1) {
      out.candidates = swit.slice(0, 20).map((s) => ({ 상호: s.상호, bizNo: s.bizNo, 출처: "SWIT" }));
      out.candidateTotal = swit.length;
      out.reason =
        `같은 이름을 포함하는 SW사업자 신고업체가 ${swit.length}곳이라 하나로 좁히지 못했습니다. ` +
        "candidates에서 상호로 고른 뒤 사업자등록번호를 직접 넘기세요.";
      return out;
    }
  } else if (swit && swit.transient) {
    // SWIT 호출 자체가 실패한 경우 — "신고 없음"과 뒤섞이지 않도록 별도 필드에 남긴다.
    out.switError = swit.reason;
  }

  if (!hit) {
    const idx = loadCorpIndex();
    out.indexGeneratedAt = idx.generatedAt;
    out.reason =
      "DART 고유번호 인덱스·키스콘 건설업체 색인·SWIT 소프트웨어사업자 검색 어디에서도 " +
      "회사를 찾지 못했습니다. DART 미등록 비상장사이면서 건설업 등록·SW사업자 신고 모두 " +
      "없는 법인이거나, 사명이 변경됐거나, 인덱스·SWIT 스냅샷 이후 신규 설립·등록된 " +
      "법인일 수 있습니다. **그 회사가 존재하지 않는다는 뜻은 아닙니다.**";
  }

  // ★★ SWIT 조회 실패는 **hit 여부와 무관하게 항상** reason에 실어 보낸다.
  //   종전에는 이 문장을 위 `if (!hit)` 블록 **안에서** 이어 붙였는데, 그러면
  //   "DART 인덱스에는 있으나 기업개황 호출이 실패한" 경로(hit이 truthy)에서 switError가
  //   설정돼도 reason에 전혀 나타나지 않았다. 그 경우 읽는 쪽은 3단계가 조회 실패한 것을
  //   모른 채 "SW사업자 등록이 없다"로 오해하게 된다 — 도구 설명이 보장하는
  //   "신고 없음 vs 조회 실패" 구분이 일부 경로에서만 지켜지던 버그였다(2026-09-11 발견).
  if (out.switError) {
    out.reason =
      (out.reason ? `${out.reason} ` : "") +
      `(SWIT 조회 자체는 실패했습니다: ${out.switError} — SW사업자 등록이 없다는 뜻이 아닙니다.)`;
  }
  return out;
}

/**
 * 기업 조사용 식별자 묶음 해석의 본체 — 회사명이든 사업자등록번호든 받아 양방향으로 답한다.
 *
 * resolveBizNo가 "사업자등록번호 한 개"만 돌려주는 데 비해, 이쪽은 DART 고유번호·
 * 법인등록번호·종목코드까지 한 번에 묶어 준다. 다른 도구(재무제표·공시·특허·낙찰)로
 * 이어 붙일 때 재조회를 없애려는 것이다.
 *
 * ★ 국세청 상태는 여기서 붙이지 않는다 — 아래 resolveCompanyIdentifiers 래퍼가 담당한다.
 *   반환 지점이 여러 곳이라 각 지점마다 조회를 끼워 넣으면 빠뜨리기 쉽기 때문이다.
 */
async function resolveIdentifiersCore({ companyName, bizNo } = {}) {
  const dartIdx = loadCorpIndex();
  const kIdx = loadKisconIndex();
  const out = {
    ok: false,
    입력: { companyName: companyName || null, bizNo: bizNo || null },
    사업자등록번호: null,
    법인등록번호: null,
    DART고유번호: null,
    종목코드: null,
    상호: null,
    상호이력: null,
    대표자: null,
    소재지: null,
    건설업면허업종: null,
    국세청상태: null,
    해석경로: null,
    후보: null,
    색인기준: {
      DART인덱스: dartIdx.generatedAt || null,
      키스콘색인: kIdx.generatedAt || null,
      키스콘수록업체수: kIdx.count || 0,
    },
    안내: null,
  };

  const nb = normalizeBizNo(bizNo);
  if (bizNo && !nb) {
    out.안내 = "사업자등록번호는 숫자 10자리여야 합니다.";
    return out;
  }

  // ── 번호로 물은 경우: 역방향 ──
  if (nb) {
    out.사업자등록번호 = nb;
    const k = kisconByBizNo(nb);
    if (k) {
      out.상호 = k.상호;
      out.상호이력 = k.상호이력.length > 1 ? k.상호이력 : null;
      out.대표자 = k.대표자;
      out.소재지 = k.지역;
      out.건설업면허업종 = k.건설업면허업종;
      out.해석경로 = "bizNo → 키스콘 건설업체 색인(역방향)";
      out.ok = true;
    }
    // 상호를 알아냈으면 DART 쪽 식별자까지 채워 본다.
    const nameForDart = out.상호 || companyName;
    if (nameForDart) {
      const hit = lookupCorpCode(nameForDart);
      if (hit) {
        const d = await dartBizNo(hit.corpCode);
        if (d.ok && d.bizNo === nb) {
          out.DART고유번호 = hit.corpCode;
          out.법인등록번호 = d.jurirNo;
          out.종목코드 = d.stockCode || null;
          out.상호 = out.상호 || d.corpName;
          out.대표자 = out.대표자 || d.ceoName;
          out.소재지 = out.소재지 || d.address;
          out.해석경로 = out.해석경로
            ? `${out.해석경로} + DART 기업개황 대조`
            : "bizNo → 상호 → DART 인덱스 → 기업개황";
          out.ok = true;
        }
      }
    }
    if (!out.ok) {
      out.안내 =
        "이 사업자등록번호는 키스콘 건설업체 색인에 없습니다(건설업 등록업체가 아니거나 " +
        "색인 스냅샷 이후 등록된 업체). 상호·대표자는 확인하지 못했지만 " +
        "**국세청 등록 상태는 아래 국세청상태에 함께 담았습니다.** " +
        "**번호가 틀렸다는 뜻이 아닙니다.**";
    }
    return out;
  }

  // ── 이름으로 물은 경우: 정방향 ──
  if (!companyName) {
    out.안내 = "companyName 또는 bizNo 중 하나는 반드시 주세요.";
    return out;
  }

  const r = await resolveBizNo(companyName);
  out.해석경로 = r.resolvedVia;
  // ★ 3단계 조회 실패를 안내 문장뿐 아니라 **별도 필드로도** 올린다. 국세청상태조회오류와
  //   같은 취급이다 — 문장만 있으면 읽는 쪽이 흘려보내기 쉽다.
  if (r.switError) out.SWIT조회오류 = r.switError;
  if (r.dartError) {
    out.경고 =
      `이 회사는 DART 고유번호 인덱스에 있으나 기업개황을 받지 못했습니다(${r.dartError}). ` +
      "아래 값은 키스콘 건설업체 색인으로만 해석한 것이라 법인등록번호·종목코드가 비어 있고, " +
      "동명의 다른 건설업체일 수 있습니다. " +
      (r.dartErrorTransient
        ? "일시적 연결 오류로 보이니 잠시 뒤 다시 호출해 DART 경로로 확인하세요."
        : "서버가 정상 응답한 결과이므로 재호출해도 같습니다. DART 고유번호가 최근 바뀌었거나 인덱스가 낡았을 수 있습니다.");
  }
  if (r.candidates) {
    out.후보 = r.candidates;
    out.후보총수 = r.candidateTotal ?? r.candidates.length;
    out.안내 = r.reason;
    return out;
  }
  if (!r.ok) {
    out.안내 = r.reason;
    return out;
  }

  out.ok = true;
  out.사업자등록번호 = r.bizNo;
  out.법인등록번호 = r.jurirNo || null;
  out.DART고유번호 = r.corpCode || null;
  out.종목코드 = r.stockCode || null;
  out.상호 = r.matchedCorpName || companyName;
  out.대표자 = r.대표자 || null;
  out.건설업면허업종 = r.건설업면허업종 || null;
  out.소재지 = r.소재지 || r.지역 || null;

  // ★ DART가 한 곳으로 풀어 줬어도, 같은 상호를 쓰는 건설업 등록업체가 따로 있으면 알린다.
  //   실측: "대성건설"은 키스콘에 98곳이다. 그중 DART에 올라온 한 곳만 조용히 돌려주면
  //   사용자는 자기가 찾던 회사가 맞는지 확인할 기회를 잃는다.
  const sameName = kisconByName(out.상호).filter((c) => c.bizNo !== out.사업자등록번호);
  if (sameName.length) {
    out.동명업체 = sameName.slice(0, 10);
    out.동명업체수 = sameName.length;
    out.참고 =
      `같은 상호의 건설업 등록업체가 키스콘 색인에 ${sameName.length}곳 더 있습니다. ` +
      "위 값은 DART에 등록된 법인 기준이므로, 찾는 회사가 비상장 동명 업체라면 " +
      "동명업체 목록에서 대표자·지역·건설업면허업종으로 확인하세요.";
  }

  // DART로 풀렸어도 키스콘에 있으면 사명 이력·소재지·업종을 덧붙인다(반대도 마찬가지).
  const k = kisconByBizNo(out.사업자등록번호);
  if (k) {
    out.상호이력 = k.상호이력.length > 1 ? k.상호이력 : null;
    out.대표자 = out.대표자 || k.대표자;
    out.소재지 = out.소재지 || k.지역;
    out.건설업면허업종 = out.건설업면허업종 || k.건설업면허업종;
    if (!out.해석경로?.includes("키스콘")) out.해석경로 = `${out.해석경로} + 키스콘 색인 보강`;
  }

  // 이름으로 풀었는데 DART 식별자가 비어 있으면(키스콘 경로) 한 번 더 채워 본다.
  if (!out.DART고유번호 && out.상호) {
    const hit = lookupCorpCode(out.상호);
    if (hit) {
      const d = await dartBizNo(hit.corpCode);
      if (d.ok && d.bizNo === out.사업자등록번호) {
        out.DART고유번호 = hit.corpCode;
        out.법인등록번호 = out.법인등록번호 || d.jurirNo;
        out.종목코드 = d.stockCode || null;
        out.해석경로 = `${out.해석경로} + DART 기업개황 대조`;
      }
    }
  }
  return out;
}

/**
 * 기업 조사용 식별자 묶음 해석 + 국세청 등록 상태 확인. (공개 진입점 — resolve_bizno 도구가 부른다.)
 *
 * 본체(resolveIdentifiersCore)가 "이 번호가 어느 회사냐"를 풀고, 여기서 "그 번호가 지금도
 * 살아 있냐"를 덧붙인다. 해석된 번호와 후보 번호를 **한 번의 호출로 묶어** 조회하므로
 * 후보가 여럿이어도 왕복은 1회다.
 *
 * ★ 후보에 상태를 붙이는 것이 실무에서 특히 유용하다. 실측(2026-09-10): "링크아이"의
 *   SWIT 후보 3곳 중 1곳이 2018-12-31 폐업자였다. 상태가 없으면 셋을 나란히 놓고
 *   "대표자·지역으로 고르라"고 안내하게 되는데, 그중 하나는 애초에 후보가 아니다.
 *
 * ★ 상태조회가 실패해도 해석 결과는 그대로 돌려준다 — 부가 정보가 하나 빠질 뿐이고,
 *   실패 사유는 국세청상태조회오류에 남긴다. **이것을 폐업으로 읽지 말 것.**
 */
export async function resolveCompanyIdentifiers({ companyName, bizNo } = {}) {
  const out = await resolveIdentifiersCore({ companyName, bizNo });

  const targets = [];
  if (out.사업자등록번호) targets.push(out.사업자등록번호);
  for (const c of out.후보 || []) if (c.bizNo) targets.push(c.bizNo);
  for (const c of out.동명업체 || []) if (c.bizNo) targets.push(c.bizNo);
  if (!targets.length) return out;

  const st = await ntsStatus(targets);
  if (!st.ok) {
    out.국세청상태조회오류 = st.reason;
    out.국세청상태 = null;
    return out;
  }

  if (out.사업자등록번호) out.국세청상태 = st.byBizNo[out.사업자등록번호] || null;
  for (const c of out.후보 || []) c.국세청상태 = st.byBizNo[c.bizNo] || null;
  for (const c of out.동명업체 || []) c.국세청상태 = st.byBizNo[c.bizNo] || null;
  out.국세청상태조회시각 = st.조회시각;

  // 해석된 회사가 폐업·휴업이면 눈에 띄게 알린다. 재무·수주 이력을 이어서 묻는 흐름에서
  // 이 사실이 조용히 묻히면 이미 없는 회사를 현재형으로 분석하게 된다.
  const s = out.국세청상태;
  if (s && s.상태코드 && s.상태코드 !== "01") {
    out.상태경고 =
      `★ 이 사업자등록번호는 현재 **${s.상태}**입니다` +
      (s.폐업일 ? `(폐업일 ${s.폐업일})` : "") +
      ". 재무·수주 이력을 이어서 조회하기 전에 이 사실을 답변에 먼저 밝히세요.";
  }

  // 후보 중 살아 있는 곳이 실제로 몇 곳인지 알려준다(후보 좁히기에 직접 쓰인다).
  if (out.후보?.length) {
    const alive = out.후보.filter((c) => c.국세청상태?.상태코드 === "01").length;
    if (alive < out.후보.length) {
      out.후보안내 =
        `후보 ${out.후보.length}곳 중 국세청 기준 계속사업자는 ${alive}곳입니다. ` +
        "나머지는 폐업·휴업이거나 국세청에 등록되지 않은 번호이므로 먼저 제외하고 고르세요.";
    }
  }
  return out;
}
