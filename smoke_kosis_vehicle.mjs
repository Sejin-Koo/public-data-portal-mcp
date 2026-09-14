// 누적 등록대수 도구 스모크테스트
//   KOSIS_API_KEY=xxx node smoke_kosis_vehicle.mjs
//
// 검증 항목
//   1) 최근 월 시도 전체 — 전국 합계가 국토교통부 발표치와 맞는지
//   2) 다개월 시계열 (셀 상한 때문에 구간이 쪼개지는지)
//   3) 시도 하나 + 차종·용도 필터
//   4) 시군구 단위 (region 필수)
//   5) 안내 경로: region 없는 sigungu / 잘못된 코드값 / 잘못된 기간

import {
  getVehicleRegistrationStock,
  getKosisVehicleCodeTables,
} from "./lib/kosis_vehicle_client.js";

function head(t) {
  console.log(`\n===== ${t} =====`);
}

async function expectFail(title, fn) {
  try {
    const r = await fn();
    if (r && r.오류) {
      console.log(`\n===== ${title} (거절됨 — 정상) =====\n  ${r.오류}`);
      return;
    }
    console.log(`\n!!!!! ${title} — 거절돼야 하는데 통과했다`);
  } catch (e) {
    console.log(`\n===== ${title} (예외 — 정상) =====\n  ${e.message}`);
  }
}

head("0) 코드표");
console.log(JSON.stringify(getKosisVehicleCodeTables(), null, 1));

head("1) 2026-06 시도 전체 (총계·계만)");
const r1 = await getVehicleRegistrationStock({
  from: "202606",
  vehicleType: "총계",
  usage: "계",
});
console.log("집계단위:", r1.집계단위, "| upstream:", r1.upstream호출수);
for (const m of r1.월별) {
  console.log(" 기준월", m.기준월, "| 행", m.건수, "| 전국합계", m.전국합계_총계_계?.toLocaleString());
  for (const v of m.값) console.log("   ", v.지역.padEnd(8), v.등록대수?.toLocaleString());
}
console.log("→ 국토교통부 발표(2026년 6월말 기준) 26,676천대와 대조할 것");

head("2) 2026-01 ~ 2026-07 전국 추이");
const r2 = await getVehicleRegistrationStock({
  from: "202601",
  to: "202607",
  vehicleType: "총계",
  usage: "계",
});
for (const m of r2.월별) {
  console.log(" ", m.기준월, m.전국합계_총계_계 ? m.전국합계_총계_계.toLocaleString() : "(없음)");
}
console.log("upstream:", r2.upstream호출수);

head("3) 서울 승용 자가용 (2026-07)");
const r3 = await getVehicleRegistrationStock({
  from: "202607",
  region: "서울",
  vehicleType: "승용",
  usage: "자가용",
});
console.log(JSON.stringify(r3.월별, null, 1));

head("4) 제주 시군구 단위 (2026-07, 총계·계)");
const r4 = await getVehicleRegistrationStock({
  from: "202607",
  level: "sigungu",
  region: "제주",
  vehicleType: "총계",
  usage: "계",
});
console.log(JSON.stringify(r4.월별, null, 1));

await expectFail("5a) region 없는 sigungu", () =>
  getVehicleRegistrationStock({ from: "202607", level: "sigungu" })
);
await expectFail("5b) 없는 시도명", () =>
  getVehicleRegistrationStock({ from: "202607", region: "경기도" })
);
// "2026-07"처럼 하이픈이 섞인 표기는 숫자만 뽑아 202607로 해석한다(의도된 관대함).
// 자릿수가 아예 맞지 않는 값만 거절한다.
await expectFail("5c) 자릿수가 틀린 기간", () =>
  getVehicleRegistrationStock({ from: "20267" })
);
await expectFail("5d) to가 from보다 앞", () =>
  getVehicleRegistrationStock({ from: "202607", to: "202601" })
);
