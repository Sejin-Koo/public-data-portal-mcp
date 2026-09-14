/**
 * 통계누리 자동차 등록자료 엑셀 클라이언트 스모크 테스트
 *
 *   node smoke_molit.mjs               → 네트워크 경로까지 전부 (통계누리 접속 필요)
 *   node smoke_molit.mjs <파일경로>    → 오프라인: 내려받은 xlsx로 파서만 검증
 *
 * ★ stat.molit.go.kr 은 일부 에이전트 컨테이너에서 프록시 릴레이가 끊깁니다
 *   (ws_closed_mid_exchange). 그 환경에서는 오프라인 모드로만 검증되고,
 *   네트워크 경로는 Vercel 배포본에서 확인해야 합니다.
 */
import fs from "node:fs";
import { getMolitVehicleStat, __test__ } from "./lib/molit_stat_client.js";

const ok = (c, m) => console.log(`${c ? "  PASS" : "  FAIL"}  ${m}`);
let fails = 0;
const check = (c, m) => {
  ok(c, m);
  if (!c) fails++;
};

const local = process.argv[2];

if (local) {
  console.log("== 오프라인 파서 검증 ==", local);
  const buf = fs.readFileSync(local);
  const wb = __test__.openWorkbook(buf);
  const names = wb.sheets.map((s) => s.name);
  check(names.length > 20, `시트 ${names.length}장`);
  check(
    names.some((n) => n.includes("연료별")),
    "연료별 시트 존재"
  );

  const read = (pfx) => {
    const s = wb.sheets.find((x) => x.name.startsWith(pfx));
    return __test__.parseSheet(wb.zip.read(s.path).toString("utf8"), wb.shared, 2000);
  };

  const r10 = read("10.");
  const header = r10[2] || [];
  check(header[3] === "서울", `헤더 3행 4열이 '서울' (실제: ${header[3]})`);
  check(header[header.length - 1] === "계", "헤더 마지막이 '계'");

  const tot = {};
  for (const r of r10) {
    if (!r || r[0] == null) continue;
    if (String(r[1] ?? "").trim() === "소계" && String(r[2] ?? "").trim() === "계") {
      const n = Number(r[19]);
      if (Number.isFinite(n)) tot[String(r[0]).trim()] = n;
    }
  }
  const fuels = Object.keys(tot).filter((k) => k !== "총계");
  const sum = fuels.reduce((a, k) => a + tot[k], 0);
  check(fuels.length > 5, `연료 구분 ${fuels.length}종`);
  check(sum === tot["총계"], `연료 합 ${sum} == 총계행 ${tot["총계"]}`);

  const h01 = read("01.").find((r) => r && String(r[0]).trim() === "합계");
  check(Number(h01[21]) === tot["총계"], "01.통계표 합계 == 10.연료별 총계");

  const t21 = read("21.").find((r) => r && String(r[0]).trim() === "총계");
  check(Number.isFinite(Number(t21[21])), "21.신규등록(누계) 총계행 숫자");

  console.log(fails ? `\n실패 ${fails}건` : "\n오프라인 전부 통과");
  process.exit(fails ? 1 : 0);
}

console.log("== A) mode=list ==");
const list = await getMolitVehicleStat({ mode: "list" });
if (list.오류) {
  console.log("  오류:", list.오류, list.상세 || "");
  console.log("  → 이 환경에서 통계누리에 도달하지 못했습니다. diagnose 결과를 확인하세요.");
  const d = await getMolitVehicleStat({ mode: "diagnose" });
  console.log(JSON.stringify(d, null, 2).slice(0, 1500));
  process.exit(1);
}
check(list.건수 > 0, `목록 ${list.건수}건, 최신 ${list.최신월}`);
check(
  list.목록.every((e) => /^\d{6}$/.test(e.기준월)),
  "기준월 형식"
);
check(
  list.목록.some((e) => e.다운로드가능),
  "다운로드 파라미터 파싱됨"
);

const ym = list.최신월;
console.log("\n== B) mode=sheets", ym, "==");
const sh = await getMolitVehicleStat({ mode: "sheets", yearMonth: ym });
if (sh.오류) {
  console.log("  오류:", JSON.stringify(sh, null, 2).slice(0, 1200));
  fails++;
} else {
  check(sh.시트.length > 20, `시트 ${sh.시트.length}장`);
  check(
    sh.시트.some((n) => n.includes("연료별")),
    "연료별 시트 존재"
  );
}

console.log("\n== C) mode=data 연료별 ==");
const d10 = await getMolitVehicleStat({
  mode: "data",
  yearMonth: ym,
  sheet: "10",
  maxRows: 2000,
});
if (d10.오류) {
  console.log("  오류:", JSON.stringify(d10, null, 2).slice(0, 1200));
  fails++;
} else {
  const tot = {};
  for (const r of d10.행) {
    if (!r || r[0] == null) continue;
    if (String(r[1] ?? "").trim() === "소계" && String(r[2] ?? "").trim() === "계") {
      const n = Number(r[19]);
      if (Number.isFinite(n)) tot[String(r[0]).trim()] = n;
    }
  }
  const fuels = Object.keys(tot).filter((k) => k !== "총계");
  const sum = fuels.reduce((a, k) => a + tot[k], 0);
  check(sum === tot["총계"], `연료 합 ${sum} == 총계행 ${tot["총계"]}`);
  console.log("   전기:", tot["전기"]);
}

console.log("\n== D) 거절 경로 ==");
const bad1 = await getMolitVehicleStat({ mode: "sheets", yearMonth: "20xx" });
check(!!bad1.오류, "잘못된 yearMonth 거절");
const bad2 = await getMolitVehicleStat({ mode: "sheets", yearMonth: "190001" });
check(!!bad2.오류, "없는 월 거절");
const bad3 = await getMolitVehicleStat({ mode: "data", yearMonth: ym, sheet: "없는시트" });
check(!!bad3.오류 && Array.isArray(bad3.가능한시트), "없는 시트 거절 + 후보 안내");

console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
