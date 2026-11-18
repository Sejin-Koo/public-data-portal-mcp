// 낙찰정보 조회 창 분할 시험(키 없이 실행): node test/scsbid-windows.smoke.mjs
// 2026-11-17부터 원 API가 7일 이상 구간을 07로 거절한다 — 창마다 7일 미만, 빈틈·겹침 없이 전 구간을 덮는지 본다.
import assert from "node:assert/strict";
import { splitWindows, RANGE_LIMIT_DAYS } from "../lib/scsbid_client.js";

const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
const LIMIT = RANGE_LIMIT_DAYS * 86400000;
function check(from, to) {
  const w = splitWindows(from, to);
  for (const x of w) assert.ok(p(x.to) - p(x.from) < LIMIT, `7일 이상 창: ${x.from}~${x.to}`);
  const asc = [...w].reverse();
  assert.equal(asc[0].from, from);
  assert.equal(asc[asc.length - 1].to, to);
  for (let i = 1; i < asc.length; i++) assert.equal(p(asc[i].from) - p(asc[i - 1].to), 60000, "창 사이는 1분");
  return w;
}
assert.equal(RANGE_LIMIT_DAYS, 7);
// 실측 통과 구간(6일 23:59)은 한 창 그대로
assert.deepEqual(splitWindows("202611100000", "202611162359"), [{ from: "202611100000", to: "202611162359" }]);
// 실측 실패 구간(정확히 7일 · 11/01~11/17)은 나뉜다
assert.equal(check("202611100000", "202611170000").length, 2);
assert.equal(check("202611010000", "202611172359").length, 3);
// 2026-11-17 보고 재현 범위(1~17일), 1개월, 3개월, 한 해
check("202610010000", "202610312359");
check("202608010000", "202610312359");
assert.equal(check("202601010000", "202612312359").length, 53);
// 역순·같은 시각
assert.equal(splitWindows("202611170000", "202611100000").length, 1);
console.log("scsbid-windows: 통과");
