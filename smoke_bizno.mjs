import { resolveBizNo } from "./lib/bizno_resolver.js";
import { searchPillIdentification, searchDrugPermissionList, searchDrugIngredients } from "./lib/onbid_mfds_client.js";

const line = (s) => console.log("\n" + "=".repeat(70) + "\n" + s);
let fail = 0;
function chk(name, cond, got) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${got !== undefined ? "  → " + got : ""}`);
  if (!cond) fail++;
}

line("① resolveBizNo 단독");
const a = await resolveBizNo("대웅제약");
chk("대웅제약 해석", a.ok && a.bizNo === "1248601143", a.bizNo);
const b = await resolveBizNo("주식회사 한미약품");
chk("법인격·공백 정규화", b.ok && b.bizNo === "1248700613", b.bizNo);
const c = await resolveBizNo("링크아이");
chk("DART 미등록은 ok=false", c.ok === false, c.reason?.slice(0, 40));

line("② search_pill_identification");
const p1 = await searchPillIdentification({ companyName: "대웅제약", limit: 1 });
chk("companyName 해석 경로", p1.resolution?.bizNo === "1248601143", p1.resolution?.resolvedVia);
chk("법인 단위 건수 244", p1.totalCount === 244, p1.totalCount);
const p2 = await searchPillIdentification({ bizrno: "1248601143", limit: 1 });
chk("bizrno 직접 = 동일(회귀)", p2.totalCount === p1.totalCount, p2.totalCount);
chk("bizrno 직접 시 resolvedVia", p2.resolution?.resolvedVia === "bizrno 직접 지정", p2.resolution?.resolvedVia);
const p3 = await searchPillIdentification({ entpName: "대웅", limit: 1 });
chk("entpName 부분검색은 기존대로 567", p3.totalCount === 567, p3.totalCount);
const p4 = await searchPillIdentification({ companyName: "없는회사이름12345", limit: 1 });
chk("해석 실패 시 폴백 표기", p4.resolution?.resolvedVia === "업체명 부분검색(폴백)", p4.resolution?.resolvedVia);

line("③ search_drug_permission_list");
const l1 = await searchDrugPermissionList({ companyName: "대웅제약", limit: 1 });
const l2 = await searchDrugPermissionList({ bizrno: "1248601143", limit: 1 });
chk("companyName == bizrno 직접", l1.totalCount === l2.totalCount, `${l1.totalCount} vs ${l2.totalCount}`);
const l3 = await searchDrugPermissionList({ entpName: "대웅", limit: 1 });
chk("entpName 부분검색이 더 넓음", l3.totalCount > l1.totalCount, `${l3.totalCount} > ${l1.totalCount}`);

line("④ search_drug_ingredients");
const g1 = await searchDrugIngredients({ companyName: "대웅제약", limit: 1 });
const g2 = await searchDrugIngredients({ bizrno: "1248601143", limit: 1 });
chk("companyName == bizrno 직접", g1.totalCount === g2.totalCount, `${g1.totalCount} vs ${g2.totalCount}`);
const g3 = await searchDrugIngredients({ entpName: "안국약품", limit: 1 });
chk("entpName 개명 후 동작", g3.ok && g3.totalCount > 0, g3.totalCount);

line(fail === 0 ? "전체 통과" : `실패 ${fail}건`);
process.exit(fail === 0 ? 0 : 1);
