// 일회성 탐색 스크립트 — 낙찰·공고 공사 오퍼레이션의 응답 필드와 건수·소요시간을 찍는다.
// 키 값은 출력하지 않는다.
const KEY = process.env.DATA_PORTAL_KEY || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
async function call(url, params) {
  const q = new URLSearchParams({ ServiceKey: KEY, type: "json", ...params }).toString();
  const t0 = Date.now();
  const res = await fetch(`${url}?${q}`, { headers: { "User-Agent": UA } });
  const text = await res.text();
  const ms = Date.now() - t0;
  let j = null;
  try { j = JSON.parse(text); } catch {}
  const body = j?.response?.body;
  const items = body?.items;
  const arr = Array.isArray(items) ? items : Array.isArray(items?.item) ? items.item : items?.item ? [items.item] : [];
  return { status: res.status, ms, code: j?.response?.header?.resultCode, msg: j?.response?.header?.resultMsg, total: body?.totalCount, n: arr.length, arr, head: j ? null : text.slice(0, 200) };
}
function show(label, r) {
  console.log(`\n=== ${label}: HTTP ${r.status} code=${r.code} msg=${r.msg} total=${r.total} rows=${r.n} ${r.ms}ms`);
  if (r.head) console.log("non-json:", r.head);
  if (r.arr[0]) {
    console.log("keys:", Object.keys(r.arr[0]).join(","));
    const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => /rgn|Rgn|site|Site|Adrs|adrs|instt|Instt|area|Area|Nm$/.test(k) && v));
    for (const it of r.arr.slice(0, 3)) console.log(JSON.stringify(pick(it)));
  }
}
const S = "https://apis.data.go.kr/1230000/as/ScsbidInfoService";
const B = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const win = { inqryBgnDt: "202608010000", inqryEndDt: "202608312359" };
show("낙찰 공사 기본형 개찰일시", await call(`${S}/getScsbidListSttusCnstwk`, { inqryDiv: 3, pageNo: 1, numOfRows: 999, ...win }));
show("공고 공사 기본형 등록일시", await call(`${B}/getBidPblancListInfoCnstwk`, { inqryDiv: 1, pageNo: 1, numOfRows: 999, ...win }));
show("공고 참가가능지역 등록일시", await call(`${B}/getBidPblancListInfoPrtcptPsblRgn`, { inqryDiv: 1, pageNo: 1, numOfRows: 999, ...win }));
show("공고 공사 기본형 개찰일시?", await call(`${B}/getBidPblancListInfoCnstwk`, { inqryDiv: 2, pageNo: 1, numOfRows: 10, ...win }));
