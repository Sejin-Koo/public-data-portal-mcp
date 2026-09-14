/**
 * 국토교통 통계누리 — 자동차 등록자료 월간 통계 엑셀 클라이언트
 *
 * stat.molit.go.kr 의 '자동차등록 통계 현황'(hRsId=58) 메타 화면에는
 * 그리드(통계표 보기)와 별개로 '통계정보' 탭의 첨부파일 목록이 붙어 있고,
 * 거기에 매월 `YYYY년 MM월 자동차 등록자료 통계.xlsx` 가 게시된다.
 *
 * 이 파일에만 있는 축: 연료별 누적, 말소등록(사유별), 성별·연령별, 차령별,
 * 최대적재량별, 배기량별, 승차정원별, 초소형 규모별, 수입차 시군구별.
 *
 * 외부 의존성 없음 — zip 해제와 xlsx 파싱을 node:zlib 로 직접 한다.
 */

import { inflateRawSync } from "node:zlib";

const HOST = "https://stat.molit.go.kr";
const META_URL = `${HOST}/portal/cate/statMetaView.do?hRsId=58`;
const DOWNLOAD_PATH = "/portal/common/downLoadFile.do";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const TIMEOUT_MS = 45000;
const MAX_ROWS_DEFAULT = 400;

/* ────────────────────────── HTTP ────────────────────────── */

async function httpGet(url, { binary = false, referer = META_URL } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: binary
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*"
          : "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "ko-KR,ko;q=0.9",
        Referer: referer,
      },
    });
    const status = res.status;
    if (binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status, buf, contentType: res.headers.get("content-type") || "" };
    }
    const text = await res.text();
    return { status, text, contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────── 첨부파일 목록 파싱 ───────────────── */

const A_TAG_RE = /<a\b[^>]*>[\s\S]*?<\/a>/gi;

/** 앵커 하나에서 다운로드 파라미터 후보를 뽑는다. */
function extractParams(anchorHtml) {
  const params = {};

  // 1) href 에 쿼리가 붙어 있는 경우
  const href = /href\s*=\s*["']([^"']+)["']/i.exec(anchorHtml);
  if (href && href[1].includes("?")) {
    for (const [k, v] of new URLSearchParams(href[1].split("?")[1])) params[k] = v;
  }
  // 2) onclick 등 스크립트 호출 인자: fn_xxx('a','b', ...)
  // ★ 인자를 정규식 `[^)]*` 로 잘라내면 안 된다. 파일명에 괄호가 들어간 첨부가
  //   실제로 있어서(예: `2015년 자동차등록현황(1월~12월).zip`) 파일명 안의 닫는
  //   괄호에서 인자가 끊긴다. 콤마 분해도 같은 이유로 위험하다.
  //   따옴표를 인식하며 앞에서부터 훑는다.
  const calls = [];
  const callHead = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = callHead.exec(anchorHtml))) {
    const args = [];
    let i = callHead.lastIndex;
    let quote = null;
    let buf = "";
    for (; i < anchorHtml.length; i++) {
      const ch = anchorHtml[i];
      if (quote) {
        if (ch === quote) {
          args.push(buf);
          buf = "";
          quote = null;
        } else buf += ch;
      } else if (ch === "'" || ch === '"') {
        quote = ch;
      } else if (ch === ")") {
        break;
      }
    }
    const kept = args.filter((s) => s.length && s !== "this" && s !== "event");
    if (kept.length) calls.push({ fn: m[1], args: kept });
    callHead.lastIndex = Math.max(i, callHead.lastIndex);
  }
  // 3) data-* 속성
  const dataAttr = /data-([\w-]+)\s*=\s*["']([^"']*)["']/gi;
  while ((m = dataAttr.exec(anchorHtml))) params[`data-${m[1]}`] = m[2];

  return { params, calls };
}

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const YM_RE = /(\d{4})\s*년\s*(\d{1,2})\s*월/;
// 연도묶음: `2015년 자동차등록현황(1월~12월).zip` 처럼 한 해치를 zip 하나로 묶어 올린 것.
// 월간 xlsx 계열보다 앞선 연도가 여기에만 있으므로 "없다"고 답하기 전에 반드시 본다.
const YEAR_RE = /(\d{4})\s*년/;

/** 메타 화면 HTML → 첨부파일 엔트리 목록 */
function parseFileList(html) {
  const out = [];
  const anchors = html.match(A_TAG_RE) || [];
  for (const a of anchors) {
    if (!/downLoadFile/i.test(a)) continue;
    const label = stripTags(a);
    if (!label) continue;
    const { params, calls } = extractParams(a);
    const ym = YM_RE.exec(label);
    const call = calls.find((c) => /^downFile2?$/.test(c.fn));
    const arg = call ? call.args : [];
    out.push({
      라벨: label,
      기준월: ym ? `${ym[1]}${String(ym[2]).padStart(2, "0")}` : null,
      종류: /이륜/.test(label) ? "이륜자동차" : /자동차/.test(label) ? "자동차" : "기타",
      유형: ym ? "월간" : YEAR_RE.test(label) ? "연도묶음" : "기타",
      수록연도: ym ? ym[1] : (YEAR_RE.exec(label) || [])[1] || null,
      표시파일명: arg[0] || null,
      저장파일명: arg[1] || null,
      경로: arg[2] || null,
      순번: 0, // parseFileList 반환 후 채운다(페이지 등장 순서)
      파라미터: params,
      스크립트호출: calls,
      앵커원문: a.length > 400 ? a.slice(0, 400) + "…" : a,
    });
  }
  out.forEach((e, i) => (e.순번 = i));
  return out;
}

/**
 * ★ 같은 기준월이 두 번 게시되는 경우가 있다(실측: 자동차 항목 일부 월).
 * 원인이 둘이고 고르는 기준이 다르다.
 *
 *  ① 경로가 다른 두 섹션에 같은 파일이 걸림 — `/stat_file/` 과 `/IN_FORM/`.
 *     `/IN_FORM/` 은 옛 경로이므로 `/stat_file/` 을 우선한다.
 *  ② 같은 경로에 재게시본이 얹힘 — 서버가 같은 이름을 피하려고 저장파일명 끝에
 *     일련번호를 붙인다(`…통계.xlsx` / `…통계1.xlsx`). 번호가 큰 쪽이 나중 판본이다.
 *
 * 아무 것도 하지 않고 목록 첫 항목을 집으면 옛 판본을 집을 수 있다.
 */
const STORE_SEQ_RE = /(\d+)\.[A-Za-z0-9]+$/;

function storeSeq(entry) {
  const s = entry.저장파일명 || "";
  const o = entry.표시파일명 || "";
  if (!s || s === o) return 0; // 표시명과 같으면 재게시본이 아니다
  const base = o.replace(/\.[A-Za-z0-9]+$/, "");
  if (!s.startsWith(base)) return 0; // 다른 파일이면 판단하지 않는다
  const m = STORE_SEQ_RE.exec(s);
  return m ? Number(m[1]) : 0;
}

function rankEntry(e) {
  return [e.경로 === "/stat_file/" ? 1 : 0, storeSeq(e)];
}

function pickEntry(list, yearMonth, kind) {
  const want = kind === "이륜자동차" ? "이륜자동차" : "자동차";
  const cands = list.filter(
    (e) => e.기준월 === yearMonth && e.종류 === want && e.유형 === "월간"
  );
  if (!cands.length) return { entry: null, cands: [] };
  const sorted = [...cands].sort((a, b) => {
    const [ap, as_] = rankEntry(a);
    const [bp, bs] = rankEntry(b);
    if (ap !== bp) return bp - ap;
    if (as_ !== bs) return bs - as_;
    return a.순번 - b.순번; // 같으면 페이지 등장 순서
  });
  return { entry: sorted[0], cands: sorted };
}

function pickNote(cands) {
  if (cands.length <= 1) return null;
  const [sel, ...rest] = cands;
  const why =
    storeSeq(sel) > 0
      ? `재게시본(저장파일명 일련번호 ${storeSeq(sel)})`
      : sel.경로 === "/stat_file/" && rest.some((r) => r.경로 !== "/stat_file/")
        ? "통계 관련파일 경로(/stat_file/)"
        : "페이지 등장 순서";
  return {
    게시본수: cands.length,
    선택근거: why,
    선택: { 경로: sel.경로, 저장파일명: sel.저장파일명 },
    나머지: rest.map((r) => ({ 경로: r.경로, 저장파일명: r.저장파일명 })),
  };
}

/** 엔트리 → 다운로드 URL. 파라미터를 못 찾으면 null. */
function buildDownloadUrl(entry, override) {
  if (override) {
    const q = override.startsWith("?") ? override.slice(1) : override;
    return `${HOST}${DOWNLOAD_PATH}?${q}`;
  }
  const p = { ...entry.파라미터 };
  // 통계누리 front-legacy/js/common.js 의 downFile / downFile2 가 폼에 채우는 이름 그대로다.
  //   downFile (oFileName, rFileName, midpath, frameName)
  //   downFile2(oFileName, rFileName, midpath, fileSeqNum, frameName)
  // 표시용 파일명(oFileName)과 서버 저장 파일명(rFileName)이 다를 수 있으므로
  // 둘 다 그대로 넘겨야 한다. 메서드는 GET.
  const call = entry.스크립트호출.find((c) => /^downFile2?$/.test(c.fn));
  if (call) {
    const a = call.args;
    if (a[0]) p.oFileName = a[0];
    if (a[1]) p.rFileName = a[1];
    if (a[2]) p.midpath = a[2];
    if (call.fn === "downFile2" && a[3]) p.fileSeqNum = a[3];
  }
  if (!Object.keys(p).length) return null;
  return `${HOST}${DOWNLOAD_PATH}?${new URLSearchParams(p)}`;
}

/* ───────────────── 최소 xlsx 리더 (zip + SpreadsheetML) ───────────────── */

function readZip(buf) {
  // End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: EOCD를 찾지 못했습니다 (xlsx가 아니거나 응답이 잘렸습니다)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    files.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...files.keys()],
    read(name) {
      const e = files.get(name);
      if (!e) return null;
      const lo = e.localOff;
      if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error("zip: 로컬 헤더 불일치");
      const nl = buf.readUInt16LE(lo + 26);
      const el = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + nl + el;
      const raw = buf.subarray(start, start + e.compSize);
      return e.method === 0 ? raw : inflateRawSync(raw);
    },
  };
}

const XML_ENT = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function unesc(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#x?[0-9A-Fa-f]+);/g, (m, g) => {
    if (XML_ENT[g] !== undefined) return XML_ENT[g];
    const n = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let s = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) s += unesc(t[1]);
    out.push(s);
  }
  return out;
}

function colToIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared, maxRows) {
  const rows = [];
  // ★ 비어 있는 행은 XML에 아예 없다. r 속성을 지켜 채워 넣지 않으면
  //    행 번호가 밀려서 "엑셀 몇 번째 줄"과 어긋난다.
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    if (rows.length >= maxRows) break;
    const rNumM = /\br="(\d+)"/.exec(rm[1] || "");
    if (rNumM) {
      const rNum = Number(rNumM[1]);
      while (rows.length < rNum - 1 && rows.length < maxRows) rows.push([]);
      if (rows.length >= maxRows) break;
    }
    const cells = [];
    // ★ 자기닫힘 셀(<c r="C3" s="16"/>)을 먼저 매칭해야 한다. 하나의
    //   `[^>]*` 로 두 형태를 함께 처리하면 빈 셀이 다음 셀의 값을 삼킨다.
    const cRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    while ((cm = cRe.exec(rm[2]))) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[2] || "";
      const body = cm[1] !== undefined ? "" : cm[3] || "";
      const refM = /r="([A-Z]+\d+)"/.exec(attrs);
      const idx = refM ? colToIndex(refM[1]) : cells.length;
      const tM = /t="([^"]+)"/.exec(attrs);
      const type = tM ? tM[1] : "n";
      let val = null;
      if (type === "inlineStr") {
        let s = "";
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(body))) s += unesc(t[1]);
        val = s;
      } else {
        const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        if (vM) {
          const raw = unesc(vM[1]);
          if (type === "s") val = shared[Number(raw)] ?? "";
          else if (type === "b") val = raw === "1";
          else if (type === "str" || type === "e") val = raw;
          else {
            const n = Number(raw);
            val = Number.isFinite(n) ? n : raw;
          }
        }
      }
      while (cells.length < idx) cells.push(null);
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

function openWorkbook(buf) {
  const zip = readZip(buf);
  const wb = zip.read("xl/workbook.xml");
  if (!wb) throw new Error("xlsx: xl/workbook.xml 이 없습니다");
  const wbXml = wb.toString("utf8");
  const relsXml = (zip.read("xl/_rels/workbook.xml.rels") || Buffer.from("")).toString("utf8");

  const rels = {};
  const relRe = /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let m;
  while ((m = relRe.exec(relsXml))) rels[m[1]] = m[2];

  const sheets = [];
  const shRe = /<sheet\b([^>]*)\/?>/g;
  while ((m = shRe.exec(wbXml))) {
    const a = m[1];
    const name = /name="([^"]*)"/.exec(a);
    const rid = /r:id="([^"]*)"/.exec(a);
    if (!name) continue;
    let target = rid ? rels[rid[1]] : null;
    if (target && !target.startsWith("/")) target = "xl/" + target.replace(/^\.\//, "");
    sheets.push({ name: unesc(name[1]), path: target });
  }
  const shared = parseSharedStrings(
    (zip.read("xl/sharedStrings.xml") || Buffer.from("")).toString("utf8")
  );
  return { zip, sheets, shared };
}

/* ───────────────── 공개 함수 ───────────────── */

function matchSheet(sheets, wanted) {
  if (!wanted) return null;
  const w = String(wanted).trim();
  let s = sheets.find((x) => x.name === w);
  if (s) return s;
  s = sheets.find((x) => x.name.replace(/\s/g, "").includes(w.replace(/\s/g, "")));
  if (s) return s;
  const n = /^\d+$/.test(w) ? String(Number(w)).padStart(2, "0") : null;
  if (n) {
    s = sheets.find((x) => x.name.startsWith(n + "."));
    if (s) return s;
  }
  return null;
}

export async function getMolitVehicleStat(args = {}) {
  const mode = args.mode || "list";
  const kind = args.kind || "자동차";

  // ── 목록/진단: 메타 화면 한 번만 읽는다 ──
  let listRes;
  try {
    listRes = await httpGet(META_URL);
  } catch (e) {
    return {
      오류: "통계누리 접속 실패",
      상세: String(e && e.message ? e.message : e),
      안내:
        "이 호스트는 일부 실행환경(에이전트 컨테이너 프록시)에서 릴레이가 끊깁니다. " +
        "서버 환경에서도 같은 증상이면 사용자에게 파일을 직접 받아달라고 요청해야 합니다.",
    };
  }
  if (listRes.status !== 200) {
    return { 오류: `통계누리 응답 HTTP ${listRes.status}`, 길이: listRes.text?.length ?? 0 };
  }
  const list = parseFileList(listRes.text);

  if (mode === "diagnose") {
    return {
      대상: META_URL,
      HTTP: listRes.status,
      본문바이트: Buffer.byteLength(listRes.text, "utf8"),
      다운로드앵커수: list.length,
      샘플앵커: list.slice(0, 3).map((e) => ({
        라벨: e.라벨,
        파라미터: e.파라미터,
        스크립트호출: e.스크립트호출,
        앵커원문: e.앵커원문,
      })),
      비고: "앵커원문을 보고 buildDownloadUrl 매핑을 확정하세요.",
    };
  }

  if (mode === "list") {
    // 같은 기준월이 여러 번 게시될 수 있으므로 월 단위로 묶어 보여준다.
    const seen = new Map();
    for (const e of list) {
      if (!e.기준월) continue;
      const key = `${e.기준월}|${e.종류}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(e);
    }
    const rows = [...seen.entries()]
      .map(([key, es]) => {
        const [기준월, 종류] = key.split("|");
        const { entry, cands } = pickEntry(es, 기준월, 종류);
        const note = pickNote(cands);
        return {
          기준월,
          종류,
          라벨: entry.라벨,
          다운로드가능: !!buildDownloadUrl(entry, null),
          ...(note ? { 게시본: note } : {}),
        };
      })
      .sort((a, b) => (a.기준월 < b.기준월 ? 1 : -1));
    const dup = rows.filter((r) => r.게시본).length;
    // ★ 월간 xlsx로 올라오지 않은 앞선 연도는 '연도묶음' zip에만 있다.
    //   월간 목록에 없다고 "자료 없음"으로 답하지 말 것.
    const bundles = [];
    const seenB = new Set();
    for (const e of list) {
      if (e.유형 !== "연도묶음" || !e.표시파일명) continue;
      if (seenB.has(e.표시파일명)) continue;
      seenB.add(e.표시파일명);
      bundles.push({ 수록연도: e.수록연도, 파일명: e.표시파일명 });
    }
    bundles.sort((a, b) => (a.수록연도 < b.수록연도 ? 1 : -1));
    const monthYears = new Set(rows.map((r) => r.기준월.slice(0, 4)));
    const onlyBundle = bundles
      .filter((b) => b.수록연도 && !monthYears.has(b.수록연도))
      .map((b) => b.수록연도);
    return {
      출처: META_URL,
      안내: "'통계정보' 탭의 통계 관련파일 목록입니다. 그리드(통계표 보기)와는 다른 자료입니다.",
      건수: rows.length,
      최신월: rows.length ? rows[0].기준월 : null,
      연도묶음: {
        안내:
          "한 해치를 zip으로 묶어 올린 첨부입니다. 월간 xlsx가 없는 앞선 연도는 여기에만 " +
          "있으므로, 월간 목록에 없다고 '자료 없음'으로 답하지 마세요. 다만 옛 판본은 시트 " +
          "이름 체계와 레이아웃이 달라(번호 접두어 없음 등) 최신판 파싱 로직이 그대로 듣지 " +
          "않습니다. 이 도구는 아직 zip 내부를 열지 않으므로 파일을 직접 받아 확인하세요.",
        건수: bundles.length,
        월간에_없는_연도: [...new Set(onlyBundle)].sort(),
        목록: bundles.slice(0, 40),
      },
      중복게시월수: dup,
      ...(dup
        ? { 중복안내: "같은 달이 두 번 게시된 경우입니다. 재게시본·/stat_file/ 경로를 우선해 고릅니다." }
        : {}),
      목록: rows.slice(0, args.limit || 40),
    };
  }

  // ── 파일을 받아야 하는 모드 ──
  const ym = String(args.yearMonth || "").trim();
  if (!/^\d{6}$/.test(ym)) return { 오류: "yearMonth 를 YYYYMM 형식으로 주세요" };

  const { entry, cands } = pickEntry(list, ym, kind);
  if (!entry)
    return {
      오류: `${ym} ${kind} 파일을 목록에서 찾지 못했습니다`,
      게시된최신월: list.filter((e) => e.기준월).map((e) => e.기준월).sort().pop() || null,
    };
  const 게시본 = pickNote(cands);

  const url = buildDownloadUrl(entry, args.downloadQuery);
  if (!url)
    return {
      오류: "다운로드 파라미터를 앵커에서 찾지 못했습니다",
      앵커원문: entry.앵커원문,
      안내: "mode='diagnose' 로 앵커 원문을 확인한 뒤 downloadQuery 로 직접 지정하세요.",
    };

  let dl;
  try {
    dl = await httpGet(url, { binary: true });
  } catch (e) {
    return { 오류: "파일 다운로드 실패", 상세: String(e && e.message ? e.message : e), URL: url };
  }
  if (dl.status !== 200 || dl.buf.length < 1000 || dl.buf.readUInt16LE(0) !== 0x4b50) {
    return {
      오류: "다운로드 응답이 xlsx가 아닙니다",
      HTTP: dl.status,
      contentType: dl.contentType,
      바이트: dl.buf.length,
      앞부분: dl.buf.subarray(0, 120).toString("utf8").replace(/\s+/g, " "),
      URL: url,
    };
  }

  let book;
  try {
    book = openWorkbook(dl.buf);
  } catch (e) {
    return { 오류: "xlsx 해석 실패", 상세: String(e && e.message ? e.message : e), 바이트: dl.buf.length };
  }

  if (mode === "sheets") {
    return {
      기준월: ym,
      종류: kind,
      파일: entry.라벨,
      바이트: dl.buf.length,
      ...(게시본 ? { 게시본 } : {}),
      시트: book.sheets.map((s) => s.name),
    };
  }

  if (mode === "data") {
    const sheet = matchSheet(book.sheets, args.sheet);
    if (!sheet)
      return {
        오류: `시트 '${args.sheet}' 를 찾지 못했습니다`,
        가능한시트: book.sheets.map((s) => s.name),
      };
    const xml = book.zip.read(sheet.path);
    if (!xml) return { 오류: `시트 본문(${sheet.path})을 읽지 못했습니다` };
    const maxRows = Math.min(Number(args.maxRows) || MAX_ROWS_DEFAULT, 2000);
    const rows = parseSheet(xml.toString("utf8"), book.shared, maxRows);
    return {
      기준월: ym,
      파일: entry.라벨,
      ...(게시본 ? { 게시본 } : {}),
      시트: sheet.name,
      행수: rows.length,
      잘림: rows.length >= maxRows,
      행: rows,
      주의:
        "스톡 시트와 신규등록 시트는 시도 축이 다를 수 있습니다(전남광주 통합 여부). " +
        "합계행·소계행이 데이터행과 섞여 있으므로 열 라벨을 보고 골라 쓰세요.",
    };
  }

  return { 오류: `알 수 없는 mode: ${mode}` };
}

export const __test__ = { readZip, openWorkbook, parseSheet, parseFileList, extractParams };
