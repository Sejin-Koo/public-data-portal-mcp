// 신규등록 통계 도구 스모크테스트
//   DATA_PORTAL_KEY=xxx node smoke_vehicle.mjs
//
// 검증 항목
//   1) 월별 합계만 (breakdown=none) — 다개월
//   2) 연료별 분포 + 합계검증 일치 여부
//   3) 국산수입 분포 + 고정조건(연료=전기) 동시 적용
//   4) 연령대 분포 — 문서에 없는 90대(코드 9)까지 포함해야 합계가 맞는지
//   5) 안내 경로: 수록 시작 이전 / 호출 예산 초과 / 잘못된 코드값

import {
  getNewVehicleRegistrations,
  DATA_START_YM,
} from "./lib/vehicle_regist_client.js";

function show(title, v) {
  console.log(`\n===== ${title} =====`);
  console.log(JSON.stringify(v, null, 1));
}

async function expectThrow(title, fn) {
  try {
    const r = await fn();
    if (r && r.오류) {
      console.log(`\n===== ${title} (거절됨 — 정상) =====`);
      console.log(JSON.stringify(r, null, 1));
      return;
    }
    console.log(`\n!!!!! ${title} — 거절돼야 하는데 통과했다`);
  } catch (e) {
    console.log(`\n===== ${title} (예외 — 정상) =====\n  ${e.message}`);
  }
}

const r1 = await getNewVehicleRegistrations({ from: "202501", to: "202503" });
show("1) 2025년 1~3월 월별 합계", r1);

const r2 = await getNewVehicleRegistrations({ from: "202501", breakdown: "fuel" });
show("2) 2025-01 연료별 분포", r2);

const r3 = await getNewVehicleRegistrations({
  from: "202501",
  breakdown: "origin",
  filters: { fuel: "5" },
});
show("3) 2025-01 전기차의 국산/외산", r3);

const r4 = await getNewVehicleRegistrations({ from: "202501", breakdown: "ageGroup" });
show("4) 2025-01 연령대별 분포", r4);

await expectThrow("5a) 수록 시작 이전 조회", () =>
  getNewVehicleRegistrations({ from: "201401" })
);
await expectThrow("5b) 호출 예산 초과(지역 17 × 24개월)", () =>
  getNewVehicleRegistrations({ from: "202401", to: "202512", breakdown: "region" })
);
await expectThrow("5c) 코드표에 없는 필터값", () =>
  getNewVehicleRegistrations({ from: "202501", filters: { fuel: "99" } })
);
await expectThrow("5d) breakdown과 filters 축 중복", () =>
  getNewVehicleRegistrations({ from: "202501", breakdown: "fuel", filters: { fuel: "5" } })
);

console.log(`\n(수록 시작: ${DATA_START_YM})`);
