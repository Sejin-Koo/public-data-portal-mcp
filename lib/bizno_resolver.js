// public-data-portal-mcp / lib/bizno_resolver.js
//
// "회사명 → 사업자등록번호 10자리" 공통 해석기.
//
// 왜 공통 파일인가: 공공데이터포털 계열 API는 기관이 달라도 회사를 사업자등록번호
// 10자리 완전일치로만 좁히는 경우가 많다. 근로복지공단 고용·산재보험(v_saeopjaDrno)이
// 그랬고, 식약처 의약품 계열(bizrno)도 같다. 회사명 부분검색은 그룹 접두어에서 계열사를
// 끌고 들어온다 — 실측(2026-08-26): entp_name="대웅" 567건 vs bizrno=1248601143 244건.
//
// 이 로직은 원래 comwel_client.js 안에 있어 4대보험 도구 전용이었다. 사업자등록번호를
// 받는 도구가 넷으로 늘면서(고용산재 1 + 식약처 3) 공통 파일로 분리했다. 새 도구는
// resolveBizNo 한 줄만 부르면 된다.
//
// 해석 경로: 정적 인덱스(data/corp_name_index.json.gz)에서 회사명 → corp_code를 찾고,
// OpenDART 기업개황(company.json)을 한 번 호출해 bizr_no를 받는다. 회사명으로 corp_code를
// 찾는 API가 OpenDART에 없고, 전체 목록 corpCode.xml은 다운로드에만 3분 39초가 걸려
// (2026-08-25 실측) Vercel 함수의 maxDuration 60초 안에 받을 수 없기 때문이다.
// 인덱스는 GitHub Actions가 매주 갱신하는 스냅샷이다.

import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rawFetch } from "./pdp_client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "..", "data", "corp_name_index.json.gz");
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

export function lookupCorpCode(companyName) {
  const idx = loadCorpIndex();
  const key = normalizeCorpName(companyName);
  if (!key) return null;
  const hit = idx.map?.[key];
  if (!hit) return null;
  return { corpCode: hit[0], corpName: hit[1], indexGeneratedAt: idx.generatedAt };
}

/**
 * DART 기업개황에서 사업자등록번호 10자리를 가져온다.
 * 게이트웨이가 간헐적으로 "upstream connect error"(JSON이 아닌 평문)를 돌려주는 것을
 * 스모크테스트에서 실측했으므로, 파싱 실패도 재시도 대상으로 삼는다. 재시도가 없으면
 * 회사명 해석이 조용히 실패해 "DART 미등록"으로 오분류된다.
 */
export async function dartBizNo(corpCode, { retries = 3 } = {}) {
  const key = process.env.DART_API_KEY || "";
  if (!key) return { ok: false, reason: "DART_API_KEY 미설정" };
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
        if (d.status !== "000") return { ok: false, reason: `DART status ${d.status}: ${d.message}` };
        const raw = String(d.bizr_no || "").replace(/\D/g, "");
        if (raw.length !== 10) return { ok: false, reason: "DART 기업개황에 사업자등록번호가 없습니다" };
        return {
          ok: true,
          bizNo: raw,
          corpName: d.corp_name,
          jurirNo: String(d.jurir_no || "").replace(/\D/g, "") || null,
          stockCode: (d.stock_code || "").trim(),
        };
      }
    } catch (e) {
      lastErr = e.message;
    }
    if (attempt < retries) await sleep(600 * attempt);
  }
  return { ok: false, reason: `DART 호출 실패(${retries}회 재시도): ${lastErr}` };
}

/**
 * 회사명 하나로 사업자등록번호 10자리를 해석한다.
 *
 * 반환값은 성공·실패 모두 같은 모양이다. 호출하는 쪽은 ok만 보고 분기하고, 실패해도
 * 예외를 던지지 않으므로 "해석 실패 시 회사명 부분검색으로 폴백" 같은 처리를 각 도구가
 * 자유롭게 할 수 있다. 어느 경로를 탔는지는 resolvedVia에 남겨 답변에 그대로 옮긴다.
 *
 * ★ 인덱스에 없는 회사(DART 미등록 비상장사)는 여기서 해석이 불가능하다. 실패 사유를
 *   reason에 담아 돌려주되, "그 회사가 존재하지 않는다"는 뜻이 아님을 호출부가 알아야 한다.
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
  const hit = lookupCorpCode(companyName);
  if (!hit) {
    const idx = loadCorpIndex();
    out.indexGeneratedAt = idx.generatedAt;
    out.reason =
      "DART 고유번호 인덱스에서 회사를 찾지 못했습니다. DART 미등록 비상장사이거나, " +
      "사명이 변경됐거나, 인덱스 스냅샷 이후 신규 등록된 법인일 수 있습니다.";
    return out;
  }
  out.indexGeneratedAt = hit.indexGeneratedAt;
  out.matchedCorpName = hit.corpName;
  const dart = await dartBizNo(hit.corpCode);
  if (!dart.ok) {
    out.reason = dart.reason;
    return out;
  }
  out.ok = true;
  out.bizNo = dart.bizNo;
  out.jurirNo = dart.jurirNo;
  out.matchedCorpName = dart.corpName || hit.corpName;
  out.resolvedVia = "companyName → DART 인덱스 → 기업개황(bizr_no)";
  return out;
}
