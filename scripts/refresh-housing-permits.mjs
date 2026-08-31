// scripts/refresh-housing-permits.mjs
// ────────────────────────────────────────────────────────────────────────────
// 국토교통부 건축HUB "대용량 제공 서비스"에서 주택인허가 **기본개요**와
// **관리공동형별개요** 최신월 파일을 받아 data/housing_permits.json.gz를 재생성한다.
// GitHub Actions가 월 1회 실행한다 — 사용자 PC도, Claude 예약작업도 필요 없다.
//
// ★ 왜 API가 아니라 대용량 파일인가
//   주택인허가 OpenAPI(HsPmsHubService)는 조회 단위가 법정동이고 일일 트래픽이
//   10,000건이라, 전국 20,560개 법정동을 하루에 순회하는 것이 불가능하다.
//   대용량 파일은 전국 한 덩어리라 이 제약이 없다.
//
// ★ 갱신 주기
//   건축HUB는 "전월까지의 갱신데이터를 익월 20일에" 제공한다. 그래서 워크플로가
//   그 이후에 돈다. 예정일이 휴일이면 익일 갱신이라 며칠 여유를 두는 편이 안전하다.
//
// ★ 인증
//   로그인이 필요 없다. 목록 페이지에서 세션 쿠키와 CSRF 토큰을 받아
//   ①이용목적 로그 POST ②파일 다운로드 POST 두 번만 치면 된다(실측 2026-08-31,
//   기본개요 7.46MB를 6.2초에 수신).
//
// ★ 파일 포맷
//   zip 안에 mart_jty_NN.txt 하나. 파이프(|) 구분, **UTF-8**(cp949 아님), 헤더 없음.
//   기본개요 29필드 / 관리공동형별개요 44필드.
// ────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdtempSync, readFileSync, existsSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "data", "housing_permits.json.gz");

const B = "https://www.hub.go.kr";
const LIST = `${B}/portal/opn/lps/idx-lgcpt-pvsn-srvc-list.do`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 대용량 서비스 코드 (실측 2026-08-31). 목록에서 이름으로 다시 찾으므로 참고용이다.
const WANT = [
  { key: "기본개요", taskSe: "02", taskCd: "0201" },
  { key: "관리공동형별개요", taskSe: "02", taskCd: "0212" },
];

let COOKIE = "";
function mergeCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = new Map();
  for (const c of COOKIE.split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = c.indexOf("=");
    jar.set(c.slice(0, i), c.slice(i + 1));
  }
  for (const line of raw) {
    const kv = line.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  COOKIE = Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 연결 단계 실패(fetch failed)만 재시도한다. HTTP 4xx/5xx는 그대로 던진다 —
// 재시도해도 같은 결과이고, 원인 판별을 흐리기만 한다.
async function withRetry(label, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.cause) throw e;
      last = e;
      const code = e.cause.code || e.cause.message || "unknown";
      console.warn(`  ${label} 연결 실패 (${i}/${tries}): ${code}`);
      if (i < tries) await sleep(3000 * i);
    }
  }
  throw last;
}

async function get(url) {
  const res = await withRetry("GET", () =>
    fetch(url, { headers: { "User-Agent": UA, Cookie: COOKIE }, signal: AbortSignal.timeout(120000) })
  );
  mergeCookies(res);
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.text();
}

async function post(url, body, { binary = false } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Cookie: COOKIE,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: LIST,
    },
    body: new URLSearchParams(body).toString(),
  });
  mergeCookies(res);
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** 목록 페이지에서 CSRF 토큰과 다운로드 대상 행을 뽑는다. */
async function fetchCatalog() {
  const now = new Date();
  const from = new Date(now.getTime() - 120 * 86400000); // 최근 4개월
  const ymd = (d) => d.toISOString().slice(0, 10);
  const q = new URLSearchParams({
    startDay: ymd(from),
    endDay: ymd(now),
    pageIndex: "1",
    pageCountPerPage: "200",
  });
  const html = await get(`${LIST}?${q}`);
  const tok =
    (html.match(/name="_csrf"[^>]*content="([^"]+)"/) || [])[1] ||
    (html.match(/name="_csrf"[^>]*value="([^"]+)"/) || [])[1];
  if (!tok) throw new Error("CSRF 토큰을 찾지 못했습니다 — 페이지 구조가 바뀌었을 수 있습니다.");

  // 각 다운로드 버튼 앞쪽 텍스트에 "주택인허가 / 기본개요 (2026년 07월)"이 들어 있다.
  const rows = [];
  const re = /fnDownloadPop\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'(OPN[^']*)'\s*\)/g;
  let m;
  while ((m = re.exec(html))) {
    const ctx = html.slice(Math.max(0, m.index - 1400), m.index);
    const cells = ctx
      .replace(/<[^>]+>/g, "|")
      .split("|")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const tail = cells.slice(-6, -3).join(" / ");
    const ym = (tail.match(/(\d{4})년\s*(\d{2})월/) || []).slice(1);
    rows.push({
      taskSe: m[1],
      taskCd: m[2],
      fileId: m[3],
      라벨: tail,
      기준월: ym.length === 2 ? `${ym[0]}${ym[1]}` : null,
    });
  }
  return { tok, rows };
}

/** 라벨로 최신월 행을 고른다. 코드가 바뀌어도 이름으로 찾히도록 이중 조건을 쓴다. */
function pick(rows, key, taskSe, taskCd) {
  const byName = rows.filter((r) => r.라벨.includes("주택인허가") && r.라벨.includes(key));
  const byCode = rows.filter((r) => r.taskSe === taskSe && r.taskCd === taskCd);
  const cand = byName.length ? byName : byCode;
  if (!cand.length) return null;
  return cand.sort((a, b) => String(b.기준월 || "").localeCompare(String(a.기준월 || "")))[0];
}

async function download(row, tok, dir) {
  // 이용목적 로그를 먼저 남겨야 다운로드가 열린다(참고자료=3).
  await post(`${B}/portal/opn/lps/idx-srvc-hstry-insert.do`, {
    opnLgcptTaskSeCd: row.taskSe,
    opnTaskCd: row.taskCd,
    opnPrcusePrpsCd: "3",
    _csrf: tok,
  });
  const buf = await post(`${B}/cmm/fms/fileOpnDown.do`, { srvrFileNm: row.fileId, _csrf: tok }, { binary: true });
  if (buf.slice(0, 2).toString() !== "PK") {
    throw new Error(`${row.라벨}: zip이 아닌 응답을 받았습니다(${buf.length} bytes). 세션·CSRF를 확인하세요.`);
  }
  const zp = join(dir, `${row.fileId}.zip`);
  writeFileSync(zp, buf);
  const entries = new AdmZip(zp).getEntries().filter((e) => !e.isDirectory && /\.txt$/i.test(e.entryName));
  if (!entries.length) throw new Error(`${row.라벨}: zip 안에 txt가 없습니다.`);
  // ★ UTF-8이다. cp949로 읽으면 한글이 전부 깨진다(실측).
  return entries[0].getData().toString("utf-8");
}

const pad4 = (v) => String(v ?? "").padStart(4, "0");
const jibun = (sg, bj, pg, bun, ji) => `${sg}-${bj}-${pg}-${pad4(bun)}-${pad4(ji)}`;

function main() {
  return (async () => {
    const dir = mkdtempSync(join(tmpdir(), "hp-"));
    const { tok, rows } = await fetchCatalog();
    console.log(`목록 ${rows.length}행 확보`);

    const picks = {};
    for (const w of WANT) {
      const r = pick(rows, w.key, w.taskSe, w.taskCd);
      if (!r) throw new Error(`'주택인허가 ${w.key}'를 목록에서 찾지 못했습니다.`);
      picks[w.key] = r;
      console.log(`  ${w.key} → ${r.라벨} (${r.fileId}, 기준월 ${r.기준월})`);
    }
    const 기준월 = picks["기본개요"].기준월;

    // 기존 스냅샷과 같은 달이면 받지 않는다.
    if (existsSync(OUT)) {
      try {
        const prev = JSON.parse(gunzipSync(readFileSync(OUT)).toString("utf-8"));
        if (prev.기준월 === 기준월) {
          console.log(`기존 스냅샷과 같은 기준월(${기준월}) — 갱신 생략`);
          return;
        }
        console.log(`기존 기준월 ${prev.기준월} → 새 기준월 ${기준월}`);
      } catch (e) {
        console.log("기존 스냅샷을 읽지 못해 새로 만듭니다:", e.message);
      }
    }

    const basisTxt = await download(picks["기본개요"], tok, dir);
    console.log(`  기본개요 ${basisTxt.length.toLocaleString()}자`);
    const mgmTxt = await download(picks["관리공동형별개요"], tok, dir);
    console.log(`  관리공동형별개요 ${mgmTxt.length.toLocaleString()}자`);

    // ── 관리공동형별개요: 지번키별로 접는다.
    //    ★ PK 필드명이 mgmCoophsrgstPk라 기본개요의 mgmHsrgstPk와 결합되지 않는다.
    //      지번이 유일하게 통하는 키다. 형별(84A·84B·상가)마다 행이 나뉘므로 합친다.
    const mgm = new Map();
    for (const line of mgmTxt.split("\n")) {
      const p = line.replace(/\r$/, "").split("|");
      if (p.length !== 44) continue;
      const k = jibun(p[2], p[3], p[4], p[5], p[6]);
      const hh = Number(p[18] || 0) || 0;
      const cur = mgm.get(k);
      if (!cur) {
        mgm.set(k, {
          단지명: p[20], 사업주체명: p[13], 난방방식: p[36], 사용연료: p[37],
          분양구분: p[39], 주택유형: p[41], 최고층수: p[17], 형별세대합: hh,
        });
      } else {
        cur.형별세대합 += hh;
        for (const [f, i] of [["단지명", 20], ["사업주체명", 13], ["난방방식", 36], ["사용연료", 37], ["분양구분", 39], ["주택유형", 41]]) {
          if (!cur[f] && p[i]) cur[f] = p[i];
        }
      }
    }
    console.log(`  형별 지번키 ${mgm.size.toLocaleString()}개`);

    // ── 기본개요 필터 + 결합
    const 행 = [];
    let 전체 = 0;
    for (const line of basisTxt.split("\n")) {
      const p = line.replace(/\r$/, "").split("|");
      if (p.length !== 29) continue;
      전체++;
      const hh = Number(p[17] || 0) || 0;
      if (hh < 30 && p[12] !== "공동주택") continue;
      const m = mgm.get(jibun(p[3], p[4], p[5], p[6], p[7])) || {};
      행.push([
        p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[12],
        p[15], p[16], String(hh), p[23], p[24], p[25], p[26], p[27], p[28],
        m.단지명 || "", m.사업주체명 || "", m.난방방식 || "", m.사용연료 || "",
        m.분양구분 || "", m.주택유형 || "", String(m.최고층수 ?? ""), String(m.형별세대합 ?? ""),
      ]);
    }
    console.log(`  기본개요 ${전체.toLocaleString()}행 → 채택 ${행.length.toLocaleString()}단지`);

    // ★ 컬럼 순서는 lib/housing_client.js가 이름으로 인덱싱하므로 바꿔도 되지만,
    //   기존 스냅샷과 맞춰 두면 diff가 읽기 쉽다.
    const 컬럼 = [
      "PK", "대지위치", "건물명", "시군구코드", "법정동코드", "대지구분", "번", "지", "특수지명", "블록", "주용도",
      "주건축물수", "연면적", "총세대수", "사업계획승인일", "착공예정일", "착공일", "사용검사예정일", "사용검사일", "생성일",
      "단지명", "사업주체명", "난방방식", "사용연료", "분양구분", "주택유형", "최고층수", "형별세대합",
    ];
    const payload = {
      기준월,
      출처: "국토교통부 건축HUB 대용량 데이터(주택인허가 기본개요+관리공동형별개요)",
      필터: "총세대수 30 이상 또는 주용도=공동주택",
      건수: 행.length,
      컬럼,
      행,
    };
    writeFileSync(OUT, gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"), { level: 9 }));
    console.log(`저장 완료: ${OUT} (${(readFileSync(OUT).length / 1048576).toFixed(2)} MB)`);
  })();
}

main().catch((e) => {
  console.error("실패:", e.message);
  // ★ Node의 fetch는 연결 단계 실패를 전부 "fetch failed" 한 줄로 뭉갠다.
  //   실제 원인(ETIMEDOUT·ECONNRESET·ENOTFOUND·인증서 오류)은 cause에만 있으므로
  //   반드시 함께 출력한다. 이게 없으면 원격 러너에서 원인 판별이 불가능하다.
  let c = e.cause;
  for (let i = 0; c && i < 4; i++) {
    const parts = [c.code, c.errno, c.syscall, c.hostname, c.address, c.port, c.message]
      .filter((x) => x !== undefined && x !== null && x !== "");
    console.error(`  cause[${i}]:`, parts.join(" | "));
    c = c.cause;
  }
  process.exit(1);
});
