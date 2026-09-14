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
  const call = /\b([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  const calls = [];
  let m;
  while ((m = call.exec(anchorHtml))) {
    const args = m[2]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => s.length && s !== "this" && s !== "event");
    if (args.length) calls.push({ fn: m[1], args });
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
    out.push({
      라벨: label,
      기준월: ym ? `${ym[1]}${String(ym[2]).padStart(2, "0")}` : null,
      종류: /이륜/.test(label) ? "이륜자동차" : /자동차/.test(label) ? "자동차" : "기타",
      파라미터: params,
      스크립트호출: calls,
      앵커원문: a.length > 400 ? a.slice(0, 400) + "…" : a,
    });
  }
  return out;
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

function pickEntry(list, yearMonth, kind) {
  const want = kind === "이륜자동차" ? "이륜자동차" : "자동차";
  return list.find((e) => e.기준월 === yearMonth && e.종류 === want) || null;
}

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
    const rows = list
      .filter((e) => e.기준월)
      .map((e) => ({
        기준월: e.기준월,
        종류: e.종류,
        라벨: e.라벨,
        다운로드가능: !!buildDownloadUrl(e, null),
      }))
      .sort((a, b) => (a.기준월 < b.기준월 ? 1 : -1));
    return {
      출처: META_URL,
      안내: "'통계정보' 탭의 통계 관련파일 목록입니다. 그리드(통계표 보기)와는 다른 자료입니다.",
      건수: rows.length,
      최신월: rows.length ? rows[0].기준월 : null,
      목록: rows.slice(0, args.limit || 40),
    };
  }

  // ── 파일을 받아야 하는 모드 ──
  const ym = String(args.yearMonth || "").trim();
  if (!/^\d{6}$/.test(ym)) return { 오류: "yearMonth 를 YYYYMM 형식으로 주세요" };

  const entry = pickEntry(list, ym, kind);
  if (!entry)
    return {
      오류: `${ym} ${kind} 파일을 목록에서 찾지 못했습니다`,
      게시된최신월: list.filter((e) => e.기준월).map((e) => e.기준월).sort().pop() || null,
    };

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
