// 2026-10-08 추가 도구 5종 스모크테스트 (MCP SDK in-memory 클라이언트 → buildServer()).
//
// 실행: KEYS_ENV=<KEY=VALUE 형식 파일 경로> node smoke_new_tools.mjs
//   또는 DATA_PORTAL_KEY·DART_API_KEY를 환경에 둔 채 node smoke_new_tools.mjs
//   ★ 키 값을 명령줄에 직접 쓰지 말 것 — 파일 경로만 넘긴다.
//
// 확인하는 것: ①정상 경로 ②문자열로 직렬화된 인자(1-10) ③안내·오류 경로 ④기존 도구 불변(도구 수)
import fs from "node:fs";

if (process.env.KEYS_ENV) {
  for (const line of fs.readFileSync(process.env.KEYS_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// SERVICE_KEY는 모듈 로드 시점에 읽히므로 환경을 채운 뒤에 동적 import한다.
const { buildServer } = await import("./lib/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const server = buildServer();
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "smoke-new-tools", version: "0" });
await client.connect(ct);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = "") {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

async function call(label, name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.content?.[0]?.text ?? "";
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    /* 검증 오류는 평문 */
  }
  console.log(`\n### ${label}  (${ms}ms)${r.isError ? "  [isError]" : ""}`);
  console.log((j ? JSON.stringify(j, null, 1) : text).slice(0, 900));
  return { r, j, ms, text };
}

const KEY_RE = process.env.DATA_PORTAL_KEY ? new RegExp(process.env.DATA_PORTAL_KEY) : null;
const noKeyLeak = (label, text) => check(`${label}: 응답에 인증키 미포함`, !KEY_RE || !KEY_RE.test(text));

// ─── 0. 도구 목록 ───
const { tools } = await client.listTools();
const NEW = [
  "get_national_pension_workplace",
  "scan_gov_biz_announcements",
  "search_onbid_notices",
  "get_onbid_notice_detail",
  "search_onbid_bid_results",
];
console.log(`등록된 도구 ${tools.length}개`);
check("도구 수 = 44 + 5", tools.length === 49, `실제 ${tools.length}`);
for (const n of NEW) check(`등록: ${n}`, tools.some((t) => t.name === n));

// ─── 1. 국민연금 ───
{
  const { j, text } = await call("NPS-1 회사명(포니링크) → 앞6자리 자동 해석", "get_national_pension_workplace", { companyName: "포니링크" });
  check("NPS-1 ok", j?.ok === true);
  check("NPS-1 앞6자리 해석", j?.resolution?.사업자등록번호앞6자리 === "119813", JSON.stringify(j?.resolution));
  check("NPS-1 사업장 선택됨", !!j?.사업장 && !!j?.선택);
  check("NPS-1 월별 12개월", j?.월별?.length === 12, `월별 ${j?.월별?.length}`);
  check("NPS-1 요약(최소·최대·등락폭)", j?.요약 && typeof j.요약.등락폭 === "number");
  check("NPS-1 취득·상실 포함", j?.월별?.some((m) => m.신규취득 !== undefined && m.신규취득 !== null));
  check("NPS-1 caveats", Array.isArray(j?.caveats) && j.caveats.length >= 4);
  noKeyLeak("NPS-1", text);
}
{
  // 문자열 직렬화 인자(1-10): months "3", includeFlows "false"
  const { j } = await call("NPS-2 bizNo 10자리 + 문자열 인자", "get_national_pension_workplace", {
    bizNo: "119-81-37606",
    companyName: "포니링크",
    months: "3",
    includeFlows: "false",
  });
  check("NPS-2 ok", j?.ok === true);
  check("NPS-2 3개월", j?.월별?.length === 3, `월별 ${j?.월별?.length}`);
  check("NPS-2 취득·상실 생략", j?.월별?.every((m) => m.신규취득 === undefined));
  check("NPS-2 경로=bizNo 직접", j?.resolution?.경로 === "bizNo 직접 지정");
}
let samsungKey = null;
{
  const { j } = await call("NPS-3 다수 사업장(삼성전자)", "get_national_pension_workplace", { companyName: "삼성전자", months: 2, includeFlows: false });
  check("NPS-3 ok", j?.ok === true);
  check("NPS-3 사업장후보 여러 곳", (j?.사업장후보?.length ?? 0) > 1, `후보 ${j?.사업장후보?.length}`);
  samsungKey = j?.사업장후보?.find((g) => g.이름일치 === "정확")?.사업장키 || j?.사업장후보?.[0]?.사업장키;
  check("NPS-3 선택 or 안내", !!j?.사업장 || !!j?.안내);
}
if (samsungKey) {
  const { j } = await call("NPS-4 workplace 지정", "get_national_pension_workplace", { companyName: "삼성전자", workplace: samsungKey, months: 2, includeFlows: false });
  check("NPS-4 지정한 사업장", j?.사업장?.사업장키 === samsungKey);
  check("NPS-4 월별 2개월", j?.월별?.length === 2);
}
{
  const { j } = await call("NPS-5 인자 없음 → 안내", "get_national_pension_workplace", {});
  check("NPS-5 ok=false + 안내", j?.ok === false && !!j?.안내);
  const b = await call("NPS-6 bizNo 자릿수 오류 → 안내", "get_national_pension_workplace", { bizNo: "12345" });
  check("NPS-6 ok=false + 안내", b.j?.ok === false && /10자리/.test(b.j?.안내 || ""));
  const w = await call("NPS-7 없는 workplace → 안내", "get_national_pension_workplace", { companyName: "포니링크", workplace: "999999-0000000" });
  check("NPS-7 안내", /해당하는 사업장이 없습니다/.test(w.j?.안내 || ""));
  const z = await call("NPS-8 0건(없는 사업장명)", "get_national_pension_workplace", { workplaceName: "쿼크없는사업장명zq" });
  check("NPS-8 ok + 후보 0 + 안내(정상·0건)", z.j?.ok === true && z.j?.사업장후보?.length === 0 && !!z.j?.안내);
}

// ─── 2. 정부 사업공고 ───
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
{
  const { j, text } = await call("GOV-1 both·기본 키워드·최근 30일", "scan_gov_biz_announcements", {});
  check("GOV-1 ok", j?.ok === true);
  check("GOV-1 두 소스 모두", !!j?.소스별?.과기정통부 && !!j?.소스별?.중기부);
  check("GOV-1 수집>0", (j?.수집건수 ?? 0) > 0, `수집 ${j?.수집건수}`);
  check("GOV-1 매칭 항목 키워드 표시", (j?.items || []).every((x) => x.매칭키워드?.length));
  check("GOV-1 과기정통부 구간 도달(잘림 아님)", j?.소스별?.과기정통부?.잘림 !== true);
  noKeyLeak("GOV-1", text);
}
{
  const { j } = await call("GOV-2 msit matchAll·2026-09-01 이후", "scan_gov_biz_announcements", { sources: "msit", since: "20260901", matchAll: "true", limit: "200" });
  check("GOV-2 ok", j?.ok === true);
  check("GOV-2 전부 since 이후", (j?.items || []).every((x) => x.공고일 >= "2026-09-01"));
  check("GOV-2 최신순", (j?.items || []).every((x, i, a) => i === 0 || a[i - 1].공고일 >= x.공고일));
  check("GOV-2 첨부 구조", (j?.items || []).some((x) => x.첨부?.[0]?.URL));
  check("GOV-2 키워드 필터 없음", typeof j?.keywords === "string");
}
{
  const { j } = await call("GOV-3 mss·JSON 문자열 키워드·공고일 day 해석", "scan_gov_biz_announcements", {
    sources: "mss",
    since: "2026-09-01",
    until: "20260930",
    keywords: '["모집","공고"]',
    mssDateResolution: "day",
  });
  check("GOV-3 ok", j?.ok === true);
  check("GOV-3 키워드 배열 해석", Array.isArray(j?.keywords) && j.keywords.length === 2);
  // ★ 중기부 일일 한도는 개발계정 100회다. 소진된 날에는 정상 경로 대신 "한도 초과가 오류로 드러나는지"를 확인한다.
  const quota = (j?.소스별?.중기부?.errors || []).find((e) => e.요청한도초과);
  if (quota) {
    console.log("  SKIP GOV-3 공고일 해석 — 중기부 일일 한도 소진(코드 " + quota.resultCode + "). 한도 오류 경로를 대신 확인합니다.");
    check("GOV-3 한도초과가 0건으로 숨지 않고 유의사항으로 드러남", j?.수집건수 === 0 && (j?.유의사항 || []).length > 0 && !!quota.안내);
  } else {
    check("GOV-3 공고일 해석 메시지", /하루 단위/.test(j?.소스별?.중기부?.공고일해석 || ""));
    const its = j?.items || [];
    check("GOV-3 공고일이 구간 내", its.filter((x) => x.공고일).every((x) => x.공고일 >= "2026-09-01" && x.공고일 <= "2026-09-30"));
    check("GOV-3 공고일 대부분 채워짐", its.length === 0 || its.filter((x) => x.공고일).length / its.length >= 0.8, `${its.filter((x) => x.공고일).length}/${its.length}`);
  }
}
{
  const { j } = await call("GOV-4 msitMaxPages=1·오래된 since → 잘림", "scan_gov_biz_announcements", { sources: "msit", since: "20250101", matchAll: true, msitMaxPages: 1 });
  check("GOV-4 잘림 true", j?.잘림 === true && j?.소스별?.과기정통부?.잘림 === true);
  const b = await call("GOV-5 날짜 형식 오류 → 안내", "scan_gov_biz_announcements", { since: "2026-13-45" });
  check("GOV-5 ok=false + 안내", b.j?.ok === false && !!b.j?.안내);
  const c = await call("GOV-6 since > until → 안내", "scan_gov_biz_announcements", { since: "20261001", until: "20260901" });
  check("GOV-6 ok=false", c.j?.ok === false);
  const d = await call("GOV-7 sources enum 오류 → 검증 실패", "scan_gov_biz_announcements", { sources: "kisti" });
  check("GOV-7 isError", d.r.isError === true);
}

// ─── 3. 온비드 공고 단위 ───
let noticeNo = null;
{
  const { j, text } = await call("ONB-1 공고목록 기본(날짜 없음 → 기본구간)", "search_onbid_notices", { limit: 5 });
  check("ONB-1 ok", j?.ok === true);
  check("ONB-1 기본구간 안내", !!j?.기본구간);
  check("ONB-1 공고 반환", (j?.공고?.length ?? 0) > 0);
  check("ONB-1 회차 구조", !!j?.공고?.[0]?.회차?.[0]?.개찰일시);
  noKeyLeak("ONB-1", text);
}
{
  const { j } = await call("ONB-2 공고명 '송파' + 하이픈 날짜 + 문자열 limit", "search_onbid_notices", {
    noticeName: "송파",
    opbdFrom: "2026-10-01",
    opbdTo: "20261031",
    limit: "3",
  });
  check("ONB-2 ok", j?.ok === true);
  check("ONB-2 날짜 숫자화", j?.조건?.opbdDtStart === "20261001");
  check("ONB-2 공고명 필터 반영", (j?.공고 || []).every((x) => x.공고명.includes("송파")));
  noticeNo = j?.공고?.[0]?.공고관리번호 || null;
}
if (noticeNo) {
  const { j } = await call("ONB-3 공고상세(기본: 공고+물건)", "get_onbid_notice_detail", { pbancMngNo: noticeNo });
  check("ONB-3 공고명", !!j?.공고?.공고명);
  check("ONB-3 첨부 배열", Array.isArray(j?.공고?.첨부));
  check("ONB-3 물건 cltrMngNo·pbctCdtnNo", !!j?.물건?.물건?.[0]?.물건관리번호_cltrMngNo && !!j?.물건?.물건?.[0]?.최근회차_pbctCdtnNo);
  const b = await call("ONB-4 공고상세 sections='[\"입찰\"]'", "get_onbid_notice_detail", { pbancMngNo: noticeNo, sections: '["입찰"]' });
  check("ONB-4 입찰정보만", !!b.j?.입찰정보 && !b.j?.공고 && !b.j?.물건);
  check("ONB-4 회차일정", Array.isArray(b.j?.입찰정보?.회차일정));
}
{
  const { j } = await call("ONB-5 없는 공고번호 → 0건 안내", "get_onbid_notice_detail", { pbancMngNo: "199901-00000-00" });
  check("ONB-5 공고 0건 안내(오류 아님)", j?.ok === true && (j?.공고?.건수 === 0 || j?.공고?.조회됨 === false));
}
let rsltNo = null;
{
  const { j, text } = await call("ONB-6 입찰결과 압류재산 2026-09 + 낙찰가", "search_onbid_bid_results", {
    prptDivCd: "0007",
    opbdFrom: "20260901",
    opbdTo: "20260930",
    exctStatCd: "개찰완료",
    limit: 5,
    detailLimit: "3",
  });
  check("ONB-6 ok", j?.ok === true);
  check("ONB-6 낙찰가조회 3건", j?.낙찰가조회?.대상공고수 === 3);
  check("ONB-6 물건결과 회차 필터(제외회차 존재 가능)", (j?.공고 || []).slice(0, 3).every((x) => Array.isArray(x.물건결과) || x.결과상세));
  check("ONB-6 집계 일부분 경고", !!j?.낙찰가조회?.유의사항);
  rsltNo = j?.공고?.[0]?.공고관리번호 || null;
  noKeyLeak("ONB-6", text);
}
{
  const { j } = await call("ONB-7 공고 1건 전 회차 결과(+개찰일 필터)", "search_onbid_bid_results", {
    pbancMngNo: rsltNo || "202606-17411-00",
    opbdFrom: "20260901",
    opbdTo: "20260930",
  });
  check("ONB-7 ok", j?.ok === true);
  check("ONB-7 회차별 결과", Array.isArray(j?.회차별결과));
  check("ONB-7 개찰일이 구간 내", (j?.회차별결과 || []).flatMap((x) => x.물건결과).every((c) => (c.개찰일시 || "").slice(0, 7) === "2026-09"));
  check("ONB-7 집계", !!j?.집계 && typeof j.집계.물건행수 === "number");
}
{
  const { j } = await call("ONB-8 입찰결과 날짜 생략 → 최근 30일 채움", "search_onbid_bid_results", { orgName: "한국자산관리공사", limit: 2, includeAmounts: "false" });
  check("ONB-8 기본구간", !!j?.기본구간 && j?.조건?.opbdDtEnd === today);
  check("ONB-8 낙찰가 조회 생략", !j?.낙찰가조회);
  const b = await call("ONB-9 날짜 형식 오류 → 안내", "search_onbid_notices", { opbdFrom: "2026" });
  check("ONB-9 ok=false + 안내", b.j?.ok === false && /날짜 형식/.test(b.j?.안내 || ""));
  const c = await call("ONB-10 cltrType enum 오류 → 검증 실패", "search_onbid_notices", { cltrType: "선박" });
  check("ONB-10 isError", c.r.isError === true);
  const d = await call("ONB-11 pbancMngNo 누락 → 검증 실패", "get_onbid_notice_detail", {});
  check("ONB-11 isError", d.r.isError === true);
  const e = await call("ONB-12 0건(없는 공고명)", "search_onbid_notices", { noticeName: "zzzz없는공고명qq", opbdFrom: "20261001", opbdTo: "20261031" });
  check("ONB-12 ok + 0건 안내", e.j?.ok === true && e.j?.공고?.length === 0 && !!e.j?.안내);
}

await client.close();
console.log(`\n==== 결과: PASS ${pass} / FAIL ${fail} ====`);
if (fail) {
  console.log(failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}
