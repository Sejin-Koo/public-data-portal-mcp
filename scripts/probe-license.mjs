// 일회성 탐색 — 입찰공고 면허제한정보 오퍼레이션의 필드·건수. 키 값은 출력하지 않는다.
const KEY = process.env.DATA_PORTAL_KEY || "";
const UA = "Mozilla/5.0";
const B = "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
for (const op of ["getBidPblancListInfoLicenseLimit", "getBidPblancListInfoCnstwkBsisAmount"]) {
  const q = new URLSearchParams({ ServiceKey: KEY, type: "json", numOfRows: "999", pageNo: "1", inqryDiv: "1", inqryBgnDt: "202609010000", inqryEndDt: "202609302359" });
  const t0 = Date.now();
  const res = await fetch(`${B}/${op}?${q}`, { headers: { "User-Agent": UA } });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const it = j?.response?.body?.items; const arr = Array.isArray(it) ? it : it?.item ? [].concat(it.item) : [];
  console.log(`== ${op} HTTP ${res.status} code=${j?.response?.header?.resultCode} total=${j?.response?.body?.totalCount} rows=${arr.length} ${Date.now()-t0}ms`);
  if (!j) console.log(text.slice(0, 200));
  if (arr[0]) { console.log("keys:", Object.keys(arr[0]).join(",")); for (const r of arr.slice(0, 6)) console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k,v])=>v && !/Url|Tel|Email|Ofcl/.test(k))))); }
  const cnt = {}; for (const r of arr) { const k = r.lcnsLmtNm || r.indstrytyNm || ""; cnt[k] = (cnt[k]||0)+1; }
  console.log("top:", Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([k,v])=>`${k}:${v}`).join(" | "));
}
