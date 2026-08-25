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
PUBLIC_DATA_PORTAL_KEY = <공공데이터포털 일반 인증키(디코딩 값)>
DART_API_KEY           = <OpenDART 인증키>
```

`PUBLIC_DATA_PORTAL_KEY`는 공공데이터포털 일반 인증키의 **디코딩 값**입니다. URL 인코딩은
서버 코드(`qs()`)가 자동으로 처리하므로 디코딩된 값 그대로 넣으면 됩니다.

`DART_API_KEY`는 `get_employment_insurance_workplace`가 회사명을 사업자등록번호 10자리로
해석할 때만 씁니다. 없어도 서버는 동작하며, 그 경우 회사명 대신 `bizNo`를 직접 넘겨야 합니다.

★ 실제 키 값은 이 저장소에 적지 마세요. 저장소가 공개이므로 커밋된 값은 즉시 노출되고,
파일을 고쳐도 git 히스토리에는 그대로 남습니다. 값은 Vercel 프로젝트 환경변수에만 둡니다.

## 제공 도구 6개

1. `scan_narajangteo_procurement(since, until?, keywords?)` — 나라장터 4종(조달요청→
   발주계획→사전규격→입찰공고) 조회 + 4종 교차 중복제거(가장 진전된 단계만 유지).
2. `scan_agency_bids(agency, since, until?, keywords?)` — 나라장터 외 8개 기관
   (kwater_bid, kwater_prespec, kra, dapa_overseas, dapa_bid, klid, kospo, kdhc) 중
   하나를 조회.
3. `scan_dapa_plan(keywords?)` — 방위사업청 D2B 조달계획(ID 기반, 날짜 필터 없음).
4. `scan_nia_board(pages?, keywords?)` — NIA 알림마당 게시판 HTML 파싱(ID 기반).
5. `get_holiday_info(year, month)` — 한국천문연구원 특일정보.
6. `list_agencies()` — 사용 가능한 agency 코드/기본 키워드/현재 KST 시각 확인.

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
