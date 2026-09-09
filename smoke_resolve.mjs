// smoke_resolve.mjs — resolve_bizno(=resolveCompanyIdentifiers) 실호출 검증.
//   node smoke_resolve.mjs
// 환경변수: DART_API_KEY (1단계 검증용), DATA_PORTAL_KEY는 불필요(색인 파일만 읽는다)

import {
  resolveCompanyIdentifiers,
  resolveBizNo,
  loadKisconIndex,
  loadCorpIndex,
  kisconByBizNo,
} from "./lib/bizno_resolver.js";

const kis = loadKisconIndex();
const dart = loadCorpIndex();
console.log(
  `색인 — 키스콘 ${(kis.count || 0).toLocaleString()}개사(${kis.generatedAt || "?"}, loadError=${kis.loadError || "none"}) / ` +
    `DART ${(dart.count || 0).toLocaleString()}건(${dart.generatedAt || "?"})`
);

const CASES = [
  { label: "① 상장사(회사명)", args: { companyName: "삼성전자" } },
  { label: "② 상장사·건설(회사명)", args: { companyName: "지에스건설" } },
  { label: "③ 건설 비상장사(회사명)", args: { companyName: "에어테크엔지니어링" } },
  { label: "④ 사업자번호 역방향", args: { bizNo: "126-86-54535" } },
  { label: "⑤ 미등록 회사명", args: { companyName: "존재하지않는회사이름입니다" } },
  { label: "⑥ 잘못된 번호 형식", args: { bizNo: "12345" } },
  { label: "⑦ 인자 없음", args: {} },
];

for (const c of CASES) {
  const t0 = Date.now();
  let r;
  try {
    r = await resolveCompanyIdentifiers(c.args);
  } catch (e) {
    console.log(`\n===== ${c.label} — 예외: ${e.message}`);
    continue;
  }
  console.log(`\n===== ${c.label} (${Date.now() - t0}ms)`);
  console.log(JSON.stringify(r, null, 1));
}

// 기존 호출부 호환 확인 — 반환 모양이 바뀌면 4대보험·식약처·낙찰 도구가 조용히 깨진다.
console.log("\n===== ⑧ 기존 resolveBizNo 호환");
for (const n of ["삼성전자", "에어테크엔지니어링", "없는회사"]) {
  const r = await resolveBizNo(n);
  console.log(`  ${n} → ok=${r.ok} bizNo=${r.bizNo} via=${r.resolvedVia} cand=${r.candidates?.length ?? 0}`);
}

// 동명 업체 후보 처리 확인 — 색인에서 상호가 겹치는 사례를 실제로 찾아 본다.
const names = new Map();
for (const [b, v] of Object.entries(kis.byBizNo || {})) {
  for (const n of v.n || []) {
    const k = n.normalize("NFKC").replace(/\(주\)|\(유\)|주식회사|유한회사|㈜|㈲/g, "").replace(/\s+/g, "").toLowerCase();
    if (!k) continue;
    const a = names.get(k) || [];
    if (!a.includes(b)) a.push(b);
    names.set(k, a);
  }
}
const dupes = [...names.entries()].filter(([, v]) => v.length > 1);
console.log(`\n===== ⑨ 동명 업체 — 정규화 상호 ${names.size.toLocaleString()}개 중 중복 ${dupes.length.toLocaleString()}개`);
if (dupes.length) {
  const [k, v] = dupes.sort((a, b) => b[1].length - a[1].length)[0];
  console.log(`  최다 중복: "${k}" ${v.length}곳 → ${v.slice(0, 3).join(", ")}`);
  const sample = kisconByBizNo(v[0]);
  const r = await resolveCompanyIdentifiers({ companyName: sample.상호 });
  console.log(`  resolveCompanyIdentifiers("${sample.상호}") ok=${r.ok} 후보=${r.후보?.length ?? 0}`);
}
