// public-data-portal-mcp / lib/gw_call.js
//
// 공공데이터포털(apis.data.go.kr) 게이트웨이 공통 호출기. 2026-10-08 추가.
// 국민연금 사업장(nps_client.js)·과기정통부/중기부 사업공고(gov_announce_client.js)·
// 온비드 공고 단위(onbid_notice_client.js) 세 파일이 함께 쓴다.
//
// 기존 파일(comwel_client.js·onbid_mfds_client.js)은 각자 callApi를 갖고 있는데, 이 파일은
// 그 패턴을 그대로 따르되 아래 두 가지를 더 엄격하게 처리한다.
//
//  1) ★ 요청한도 초과는 재시도하지 않는다(sys-mcp-server-dev 1-13).
//     HTTP 429로 오고 본문은 OpenAPI_ServiceResponse XML이다. returnReasonCode 22는 일일 한도,
//     23은 초당 한도다. 실측(2026-10-08, 중기부 사업공고): 날짜별 6건씩 병렬로 부르자 곧바로
//     23(LIMITED_NUMBER_OF_SERVICE_REQUESTS_PER_SECOND_EXCEEDS_ERROR)이 났고, 20초 뒤에도 풀리지
//     않다가 약 80초 뒤에 풀렸다. 재시도는 한도만 더 쓰므로 그대로 실패로 올린다.
//  2) ★ 빈 본문·파싱 실패를 0건으로 읽지 않는다(1-11·1-14). 오류로 올리고 재시도한다.
//
// 인증 관련 코드는 "키가 틀렸다"가 아니라 "그 API를 활용신청하지 않았다"인 경우가 대부분이라
// 안내 문구를 따로 단다. 키 값은 어떤 경로로도 응답에 싣지 않는다.

import { SERVICE_KEY, qs, rawFetch, parseResponse } from "./pdp_client.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** returnReasonCode(게이트웨이 인증·한도 오류) → 사람이 읽을 안내. */
const GW_REASON_GUIDE = {
  "12": "오퍼레이션명이 없거나 폐기되었습니다(NO_OPENAPI_SERVICE_ERROR). 인증키 문제가 아닙니다 — 경로 철자를 확인하세요.",
  "20": "이 API에 대한 접근 권한이 없습니다(SERVICE_ACCESS_DENIED). 활용신청 상태를 확인하세요.",
  "22": "일일 요청한도를 초과했습니다. 재시도하지 말고 익일에 다시 조회하세요(한도는 오퍼레이션 단위·계정 공유).",
  "23": "초당 요청한도를 초과했습니다. 1~2분 뒤에 다시 조회하세요(실측상 20초로는 풀리지 않고 약 80초 뒤 풀림).",
  "30": "이 인증키로 해당 API가 활용신청·승인되지 않았습니다(SERVICE_KEY_IS_NOT_REGISTERED). 키가 틀린 것이 아니라 미신청 API입니다.",
  "31": "인증키 활용기간이 만료되었습니다.",
};

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * 결과 헤더를 찾는다. 이 서버에서 관측된 형태는 다섯 가지다.
 *   국민연금      : { response: { header, body } }
 *   과기정통부    : { response: [ { header }, { body } ] }   ← 배열이다
 *   중기부(XML)   : <response><header/><body/></response>
 *   온비드        : { header, body }  /  필수 누락 시 { result: { resultCode } }
 *   게이트웨이    : { OpenAPI_ServiceResponse: { cmmMsgHeader } }
 */
export function readGwHeader(d) {
  if (!d || typeof d !== "object") return { code: undefined, msg: undefined, gw: false };
  const svc = d.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (svc) {
    return {
      code: String(svc.returnReasonCode ?? "ERR"),
      msg: `${svc.errMsg ?? ""} ${svc.returnAuthMsg ?? ""}`.trim(),
      gw: true,
    };
  }
  let h;
  if (Array.isArray(d.response)) h = d.response.find((x) => x && x.header)?.header;
  else h = d.response?.header ?? d.header ?? d.result;
  if (h) {
    return {
      code: h.resultCode === undefined || h.resultCode === null ? undefined : String(h.resultCode).padStart(2, "0"),
      msg: h.resultMsg ?? "",
      gw: false,
    };
  }
  return { code: undefined, msg: undefined, gw: false };
}

/** body를 찾는다(과기정통부의 배열 응답 포함). */
export function readGwBody(d) {
  if (!d || typeof d !== "object") return {};
  if (Array.isArray(d.response)) return d.response.find((x) => x && x.body)?.body ?? {};
  return d.response?.body ?? d.body ?? {};
}

/** body.items를 평평한 배열로. items.item / items:[{item}] / items:[...] 모두 지원. */
export function readGwItems(body) {
  const it = body?.items;
  if (!it) return [];
  if (Array.isArray(it)) {
    return it.map((x) => (x && typeof x === "object" && x.item && Object.keys(x).length === 1 ? x.item : x));
  }
  if (typeof it === "object" && it.item !== undefined) return asArray(it.item);
  return [];
}

/**
 * GET 호출 + 재시도 + 정규화. 예외를 던지지 않는다.
 * 반환: { ok, noData, httpStatus, resultCode, resultMsg, rateLimited, guide, totalCount,
 *        items, body, ms, endpoint }
 */
export async function callGw({ url, params = {}, timeoutMs = 15000, retries = 3, nodataCodes = ["03"], deadline = null }) {
  const full = `${url}?serviceKey=${encodeURIComponent(SERVICE_KEY)}&${qs(params)}`;
  const endpoint = url.replace(/^https?:\/\//, "");
  let status = 0;
  let text = "";
  let lastErr = null;
  let parsed = null;
  const t0 = Date.now();
  for (let attempt = 1; attempt <= retries; attempt++) {
    parsed = null;
    // deadline(서버 예산)을 넘겼으면 재시도하지 않고, 남은 시간보다 오래 기다리지도 않는다.
    // 한 호출이 재시도 3회 × 타임아웃으로 Vercel maxDuration(60초)을 혼자 넘기는 것을 막는다.
    let budget = timeoutMs;
    if (deadline) {
      const left = deadline - Date.now();
      if (left <= 0) {
        lastErr = lastErr ? `${lastErr} → 시간상한으로 재시도 중단` : "시간상한으로 호출 생략";
        break;
      }
      budget = Math.max(1000, Math.min(timeoutMs, left));
    }
    try {
      ({ status, text } = await rawFetch(full, {}, budget));
      if (status === 429) {
        // ★ 한도 초과 — 재시도하지 않는다.
        const p = parseResponse(text);
        const h = p.format !== "error" ? readGwHeader(p.data) : { code: undefined, msg: "" };
        const code = h.code && h.code !== "ERR" ? h.code : "22";
        return {
          ok: false,
          noData: false,
          httpStatus: 429,
          resultCode: code,
          resultMsg: h.msg || "요청한도 초과",
          rateLimited: true,
          guide: GW_REASON_GUIDE[code] || GW_REASON_GUIDE["22"],
          totalCount: 0,
          items: [],
          body: {},
          ms: Date.now() - t0,
          endpoint,
        };
      }
      if (status >= 500) lastErr = `HTTP ${status}`;
      else if (!text || !text.trim()) lastErr = "빈 응답(본문 0바이트 — 응답 크기 상한이거나 게이트웨이 타임아웃)";
      else {
        const p = parseResponse(text);
        if (p.format !== "error" && readGwHeader(p.data).code !== undefined) {
          parsed = p;
          break;
        }
        // 결과코드가 아예 없는 응답(WAF HTML 등)도 파싱 실패와 같게 본다 — 그대로 두면 0건이 된다.
        lastErr = p.format === "error" ? "응답 파싱 실패" : `결과코드 없는 응답: ${String(text).slice(0, 80)}`;
      }
    } catch (e) {
      lastErr = e.message;
    }
    if (attempt < retries) await sleep(500 * attempt);
  }
  if (!parsed) {
    return {
      ok: false,
      noData: false,
      httpStatus: status,
      resultCode: undefined,
      resultMsg: `조회 실패(${retries}회 시도): ${lastErr}`,
      rateLimited: false,
      totalCount: 0,
      items: [],
      body: {},
      ms: Date.now() - t0,
      endpoint,
    };
  }
  const h = readGwHeader(parsed.data);
  const body = readGwBody(parsed.data);
  const items = readGwItems(body);
  const noData = nodataCodes.includes(h.code);
  const ok = h.code === "00" || noData;
  const out = {
    ok,
    noData,
    httpStatus: status,
    resultCode: h.code,
    resultMsg: h.msg,
    rateLimited: false,
    totalCount: noData ? 0 : Number(body.totalCount ?? items.length) || 0,
    items: noData ? [] : items,
    body,
    ms: Date.now() - t0,
    endpoint,
  };
  if (!ok && h.gw) out.guide = GW_REASON_GUIDE[h.code] || null;
  return out;
}

/** 동시성 제한 병렬 실행. 순서를 보존한다. */
export async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 실패 응답을 도구 응답용 요약으로. 키·URL 쿼리는 싣지 않는다. */
export function failSummary(r) {
  return {
    조회됨: false,
    endpoint: r.endpoint,
    httpStatus: r.httpStatus,
    resultCode: r.resultCode ?? null,
    resultMsg: r.resultMsg ?? null,
    ...(r.rateLimited ? { 요청한도초과: true } : {}),
    ...(r.guide ? { 안내: r.guide } : {}),
  };
}

export { sleep };
