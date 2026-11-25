# public-data-portal-mcp

나라장터·방위사업청·수자원공사·한국마사회·한국지역정보개발원·한국남부발전·한국지역난방공사·
NIA 등 공공데이터포털/D2B 계열 입찰·조달 정보를 감싸는 MCP 서버입니다.

it-bid-daily-scan 예정작업이 매일 curl로 직접 처리하던 14개 소스의 인증 헤더 quirk,
JSON/XML 혼재, resultCode 불일치, 나라장터 4종 교차 중복제거 로직을 서버 쪽으로 옮겨서
제공합니다. 오탐 필터링과 "검토가치 있음" 판단처럼 주관적 판단이 필요한 부분은 서버가 하지
않고 원문 매칭 결과만 반환합니다 — 그 판단과 체크포인트/seen 파일 관리(상태 저장)는 호출하는
쪽(에이전트)의 몫입니다. 이 서버 자체는 상태를 갖지 않는 순수 조회 서버입니다.

## 배포

```
Endpoint: https://public-data-portal-mcp.vercel.app/api/mcp
연결 방식: Settings > Connectors > "+" > Add custom connector, URL 위와 동일, 인증 불필요
          (클라이언트는 별도 키를 넘길 필요 없음 — 서버가 환경변수로 자체 보유)
```

Vercel에 이 저장소를 Import한 뒤, 프로젝트 환경변수에 아래를 반드시 설정해야 합니다:

```
DATA_PORTAL_KEY = <공공데이터포털 일반 인증키>
DART_API_KEY    = <OpenDART 인증키>
NIMBLE_API_KEY  = <Nimble Web API 키>   # resolve_bizno 3단계(SWIT) 전용 — 없으면 그 단계만 실패
```

`DATA_PORTAL_KEY`는 공공데이터포털 일반 인증키입니다. 2026-08-26 재발급본부터는 64자리
16진수라 Encoding 값과 Decoding 값이 같아 구분할 필요가 없습니다. 그 이전 base64 형식 키를
쓰는 경우에는 **디코딩 값**을 넣으세요 — URL 인코딩은 서버 코드(`qs()`)가 자동 처리합니다.

★ **환경변수명이 `PUBLIC_DATA_PORTAL_KEY`에서 `DATA_PORTAL_KEY`로 바뀌었습니다(2026-08-26).**
종전 이름의 "PUBLIC"은 "공공데이터포털(Public Data Portal)"의 약자였지만, Vercel은 `PUBLIC_`
접두어를 "브라우저에 노출할 공개 변수"로 해석해 Secret 타입 저장을 거부합니다. 전환이
끝났으므로 **옛 이름은 더 이상 인식하지 않습니다.** 옛 이름으로 되돌리지 마세요.

키가 설정됐는지는 `list_agencies` 도구의 `keyConfigured`·`keySource`로 확인할 수 있습니다
(키 값 자체는 반환하지 않습니다). 조회가 전부 실패하는데 원인을 모르겠으면 여기부터 보세요.

`DART_API_KEY`는 회사명을 사업자등록번호 10자리로 해석하는 공통 해석기
(`lib/bizno_resolver.js`)가 씁니다 — `resolve_bizno` 도구와, 회사명을 받는 여러 도구가
내부에서 같은 해석기를 부릅니다. 없어도 서버는 동작하지만 DART 경로(상장·외감법인)가 막혀
키스콘 색인 경로만 남으므로, 그 경우 회사명 대신 `bizNo`를 직접 넘기는 편이 정확합니다.

★ 실제 키 값은 이 저장소에 적지 마세요. 저장소가 공개이므로 커밋된 값은 즉시 노출되고,
파일을 고쳐도 git 히스토리에는 그대로 남습니다. 값은 Vercel 프로젝트 환경변수에만 둡니다.

## 사업자등록번호 해석 (`resolve_bizno`)

회사명 ↔ 사업자등록번호를 양방향으로 풀어 식별자(사업자등록번호·법인등록번호·DART 고유번호·
종목코드·상호 이력·대표자·소재지·업종)를 한 묶음으로 돌려주고, **국세청 등록 상태**까지
덧붙입니다. 해석 경로는 3단계입니다.

| 단계 | 근거 | 덮는 범위 | 갱신 |
|---|---|---|---|
| 1 | `data/corp_name_index.json.gz` → OpenDART 기업개황 | 상장·외감법인 | 주 1회 **통째로 교체** |
| 2 | `data/kiscon_bizno_index.json.gz` | 건설업 등록업체(DART 미등록 비상장사 포함) | 월 1회 **누적 병합** |
| 3 | SWIT 소프트웨어사업자 신고 검색 | SW사업자 신고업체(DART 미등록 IT·SI 비상장사 포함) | **실시간 조회**(색인 없음) |

★ **1·2번 두 파일을 하나로 합치지 마세요.** 1번은 매주 갈아끼우는 스냅샷이라, 누적이 필요한
키스콘 색인을 거기에 넣으면 다음 주에 사라집니다.

키스콘 색인은 `scripts/refresh-kiscon-index.mjs`가 만듭니다. 사업자등록번호를 키로 두고
상호를 배열로 쌓아, 사명이 바뀌어도 옛 이름으로 찾힙니다. 워크플로
`.github/workflows/refresh-kiscon-index.yml`가 월 1회 증분 병합하며, 전량 재수집은
`workflow_dispatch`에서 mode=backfill로 수동 실행합니다(수십 분 소요).
**이 워크플로에는 저장소 시크릿 `DATA_PORTAL_KEY`가 필요합니다.**

### 3단계 SWIT는 Nimble 경유입니다 — `NIMBLE_API_KEY` 필요

SWIT(www.swit.or.kr)는 **클라우드/데이터센터 IP를 차단합니다.** Vercel에서 직접 호출하면
TCP 연결 후 곧바로 리셋됩니다(`ECONNRESET` — DNS 실패도 타임아웃도 아닙니다). 그래서 이
단계는 Nimble Web API를 국내 IP 경유 프록시로 거쳐 호출합니다(`country: "KR"`).

- 인증은 `Authorization: Bearer <키>`입니다. 공식 문서의 `Basic`(이메일:비밀번호 base64)
  방식은 현행 API키에 401 `No supported authentication method found`를 냅니다.
- `NIMBLE_API_KEY`가 없으면 직접 호출로 폴백하지만, 위 이유로 사실상 항상 실패합니다.
- 호출 1건당 Nimble 사용량이 소모됩니다. 앞의 두 단계가 모두 실패했을 때만 타므로 빈도는
  낮지만, 무료 구간(월 5,000 요청)을 넘기면 과금됩니다.

### 국세청 등록 상태 (`국세청상태`)

해석된 번호와 후보 번호의 **계속사업자·휴업자·폐업자** 여부를 폐업일·과세유형과 함께
돌려줍니다. `api.odcloud.kr/api/nts-businessman/v1/status`를 쓰고 **인증은 기존
`DATA_PORTAL_KEY`로 충분합니다**(별도 키 불필요). 여러 건을 한 번에 물으므로 후보가
여럿이어도 왕복은 1회입니다.

★ **이 값은 색인에 저장하지 않습니다.** 휴폐업은 수시로 바뀌는데 색인은 스냅샷이라, 굳혀
두면 갱신 주기 내내 낡은 값을 답하게 됩니다. 조회 시점에 실시간으로만 묻습니다.

★ **조회 실패를 폐업으로 읽지 마세요.** 실패는 `국세청상태조회오류`로 따로 오고, 국세청에
등록 이력이 없는 번호는 "국세청에 등록되지 않은 번호"로 표기됩니다 — 둘 다 폐업과 다릅니다.

★ 번호를 알아야 상태를 답하는 구조라 **회사명으로 번호를 찾는 용도로는 쓸 수 없습니다.**
이 해석기의 대체재가 아니라 그 뒤에 붙는 검증 단계입니다.

## 제공 도구

> **2026-10-08 건설 도구 분리** — 키스콘·건설CALS·건축HUB 건축인허가·주택인허가·청약홈 도구 17개와
> 주택인허가 전국 스냅샷(`data/housing_permits.json.gz`)·그 갱신 워크플로는 `construction-mcp` 저장소로
> 옮겼다. 사업자번호 색인 2종(`corp_name_index`·`kiscon_bizno_index`)은 `resolve_bizno`가 쓰므로 이
> 저장소에 남아 계속 갱신되고, `construction-mcp`가 주 1회 받아 간다. Qdrant keep-alive는
> `qdrant-keepalive.yml`로 떼어 이 저장소에 남겼다.

아래 목록은 서버 초기의 것으로, 이후 추가된 도구는 담고 있지 않습니다. 현행 목록은
`lib/server.js`의 `server.tool(` 등록부를 보세요.


1. `scan_narajangteo_procurement(since, until?, keywords?)` — 나라장터 4종(조달요청→
   발주계획→사전규격→입찰공고) 조회 + 4종 교차 중복제거(가장 진전된 단계만 유지).
2. `scan_agency_bids(agency, since, until?, keywords?)` — 나라장터 외 8개 기관
   (kwater_bid, kwater_prespec, kra, dapa_overseas, dapa_bid, klid, kospo, kdhc) 중
   하나를 조회.
3. `scan_dapa_plan(keywords?)` — 방위사업청 D2B 조달계획(ID 기반, 날짜 필터 없음).
4. `scan_nia_board(pages?, keywords?)` — NIA 알림마당 게시판 HTML 파싱(ID 기반).
5. `get_holiday_info(year, month)` — 한국천문연구원 특일정보.
6. `list_agencies()` — 사용 가능한 agency 코드/기본 키워드/현재 KST 시각 확인.

## 나라장터 공동계약 수집본 (`data/cntrct/`, 2026-11-25)

`get_narajangteo_contract`에 업체(`bizno`·`companyName`)와 기간을 함께 주면 원 API 대신 이 수집본에서 찾는다.
원 API에는 업체 조건이 없어 기간 안의 계약을 전부 받아 걸러야 하는데, 하루 7천 건이 넘어(실측 2026-11-18:
용역 2,642·공사 3,096·물품 1,489) 1년 조회는 시간 초과로 끝났다.

- 수집: `scripts/refresh-cntrct-cache.mjs` — `.github/workflows/refresh-cntrct-cache.yml`이 매일 05:23 KST에 실행.
  하루 × 업무구분 전량(999행 쪽)을 받아 **공동계약(`cmmnCntrctYn=Y` 또는 업체 2곳 이상)만** 월 파일에 둔다
  (같은 날 165건, 2.3%). 데이터는 릴리스 'data' 첨부파일, 저장소에는 `data-release.json`만.
- 다시 받기: 최근 7일(일요일 60일). 등록이 체결 뒤 늦게 올라온다 — 7일 안 93~95%, 60일 안 99.6%, 최대 71일.
- 채우기: 보관 기간(이번 달 + 24개월) 중 빈 날을 최신부터 호출 예산(`--budget`, 기본 2,400) 안에서 채운다.
  일일 한도는 업무구분(오퍼레이션)별이라 429가 오면 그 업무구분만 멈추고 다음 실행이 이어 간다.
- 조회: 수집본이 받은 날은 파일에서, 못 받은 날이 2일 이하면 실시간 보충(30초 한도), 그보다 많으면
  `수집본.미확인구간`으로 알린다. 단독 계약은 수집본에 없다.

## 이 서버가 하지 않는 것 (호출하는 쪽의 책임)

- **나라장터(1~4번) vs 다른 8개 기관 간 교차 중복제거**: `scan_narajangteo_procurement`와
  `scan_agency_bids` 결과의 title을 비교해서 같은 사업이면 나라장터 쪽만 남기는 판단은
  호출하는 쪽에서 수행해야 합니다.
- **오탐(false positive) 필터링**: "AIRPORT"의 "AI"처럼 키워드가 단어 일부로 우연히
  매칭된 경우를 걸러내는 판단.
- **검토가치 판단**: 예산 규모·사업 성격 기준으로 강조 여부를 정하는 판단.
- **체크포인트/seen 파일 관리**: `scan_dapa_plan`/`scan_nia_board`는 매번 전체 매칭분을
  반환하므로, "신규" 여부 판정과 seen 목록 갱신은 호출하는 쪽이 파일(또는 다른 저장소)에
  직접 저장해서 비교해야 합니다.
- **HTML 보고서 생성**: 표 형식·정렬·강조 스타일 등 출력 형식은 호출하는 쪽에서 구성합니다.

## 참고

- 원본 quirk 문서: `it-bid-daily-scan` 예정작업(SKILL.md)에 소스별 상세 이력이 남아있습니다.
- 코드 패턴은 `krx-regulation-mcp`와 동일(Node.js ESM + `@modelcontextprotocol/sdk` +
  Vercel `StreamableHTTPServerTransport`).
- NIA 게시판 HTML 파싱은 정규식 기반이라 사이트 마크업이 바뀌면 깨질 수 있습니다 — 매칭
  건수가 갑자기 0으로 떨어지면 가장 먼저 의심할 부분입니다.
