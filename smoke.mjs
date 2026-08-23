// 로컬 스모크테스트: buildServer()에 등록된 도구를 실제 인증키로 직접 호출한다.
// 실행:  PUBLIC_DATA_PORTAL_KEY=... node smoke.mjs
import { buildServer } from "./lib/server.js";

const server = buildServer();
// McpServer 내부의 등록된 tool 핸들러를 꺼낸다.
const reg = server._registeredTools || server.server?._registeredTools;
const names = Object.keys(reg);
console.log(`등록된 도구 ${names.length}개:\n  ${names.join("\n  ")}\n`);

async function run(name, args) {
  const t = reg[name];
  if (!t) return console.log(`### ${name}: 등록 안 됨!`);
  const started = Date.now();
  try {
    const out = await t.handler(args, {});
    const text = out.content[0].text;
    const j = JSON.parse(text);
    const brief = {
      ok: j.ok,
      resultCode: j.resultCode,
      resultMsg: j.resultMsg,
      totalCount: j.totalCount,
      returned: Array.isArray(j.items) ? j.items.length : undefined,
      dongResolution: j.dongResolution,
      bytes: text.length,
      ms: Date.now() - started,
    };
    console.log(`### ${name}`, JSON.stringify(brief, null, 1));
    if (Array.isArray(j.items) && j.items.length) {
      const s = j.items[0];
      const keys = Object.keys(s).slice(0, 6);
      console.log(
        "   샘플:",
        keys.map((k) => `${k}=${String(s[k]).slice(0, 40)}`).join(" | ")
      );
    }
    if (j.attempts) console.log("   attempts:", JSON.stringify(j.attempts));
  } catch (e) {
    console.log(`### ${name} 예외:`, e.message);
  }
}

const today = "20260823";
const weekAgo = "20260816";

// 정상 경로
await run("search_onbid_realestate", { sido: "경기도", sigungu: "구리시", eupmyeondong: "교문동", limit: 5 });
// 안내 경로 1 — 행정동을 넣었을 때 법정동으로 자동 재시도되는지
await run("search_onbid_realestate", { sido: "경기도", sigungu: "구리시", eupmyeondong: "교문2동", limit: 5 });
// 최근 1주 등록·수정분
await run("search_onbid_realestate", { sido: "경기도", sigungu: "구리시", updatedFrom: weekAgo, updatedTo: today, limit: 10 });
// 안내 경로 2 — 결과가 아예 없는 지역 (NODATA 정규화 확인)
await run("search_onbid_realestate", { sido: "경기도", sigungu: "구리시", eupmyeondong: "없는동", limit: 5 });
await run("get_onbid_realestate_detail", { cltrMngNo: "2020-11444-007", pbctCdtnNo: "6160097" });
await run("get_onbid_bid_info", { cltrMngNo: "2020-11444-007", pbctCdtnNo: "6160097" });
await run("search_drug_permission", { mainIngredient: "콘드로이친", limit: 10 });
await run("search_health_functional_food", { productName: "콘드로이친", limit: 5 });
await run("search_drug_easy_info", { itemName: "타이레놀", limit: 3 });
// 안내 경로 3 — e약은요에 없는 성분어를 제품명으로 넣었을 때 0건이 정상 처리되는지
await run("search_drug_easy_info", { itemName: "콘드로이친", limit: 3 });
await run("search_pill_identification", { itemName: "타이레놀", limit: 3 });
