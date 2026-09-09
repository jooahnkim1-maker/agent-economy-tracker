# Agent Economy Tracker

AI 에이전트들이 서로에게 지불한 **거래액을 추적하는 대시보드**. 백엔드도, DB도, API 키도 없다.
브라우저가 공개 RPC와 공개 집계 API를 직접 읽는다.

```sh
./serve.sh              # → http://localhost:8420
```

`file://`로 열면 `fetch`가 막히므로 반드시 HTTP로 띄운다.

---

## 화면

| 탭 | 내용 |
|---|---|
| **개요** | 헤드라인 4개(누적 결제 건수 / 누적 거래액 / ERC-8004 에이전트 / 실시간 결제 속도)와 각각의 추세, 그리고 활동이 어디에 몰려 있는지 |
| **결제** | Base·Polygon에서 facilitator가 제출하는 USDC 정산을 실시간으로. 지불자 → facilitator → 서비스 흐름도 + 최근 목록 |
| **레지스트리** | Base·BNB의 ERC-8004 등록을 실시간으로. 행을 누르면 등록 파일을 파싱해 카드로 보여준다 |
| **마켓플레이스** | 에이전트와 유료 서비스가 등록되는 곳 12군데와 각각이 공개하는 수치 |

## 데이터 출처

**실시간 — 브라우저가 체인을 직접 읽는다**

| 데이터 | 소스 | 방식 |
|---|---|---|
| x402 결제(정산) | Base `mainnet.base.org`, Polygon `polygon-bor-rpc.publicnode.com` | USDC 컨트랙트의 `AuthorizationUsed` 로그 → 해당 tx의 calldata를 EIP-3009 셀렉터로 디코드 |
| 에이전트 등록 | Base, BNB Chain | 레지스트리 `0x8004A169…a432`의 `Registered` / `URIUpdated` 로그 |

USDC는 **성공한** EIP-3009 호출에서만 `AuthorizationUsed`를 낸다. 그래서 이 로그 하나가 곧 정산
한 건이고, 리버트된 건은 애초에 섞이지 않는다. 블록 전체를 훑으면 블록당 ~250KB를 받아야 하지만,
이 로그만 받으면 ~0.5KB로 끝나고 이름이 나온 트랜잭션만 따로 가져오면 된다.

애그리게이터를 거친 정산은 calldata가 EIP-3009 형태로 디코드되지 않아 금액·수취인을 복원할 수
없다. 이런 건은 **빼고** 센다 — 그래서 "구간 내 결제"는 실제 정산 건수의 하한이다.

**누적 총계 — 외부 집계**

- `dashboard.agenteconomy.to/data.json` — Dune 쿼리 결과를 퍼블리시하는 공개 JSON.
  x402 누적 건수·거래액, facilitator별·체인별 점유율, ERC-8004 누적, Virtuals ACP 메모, Olas Mech.
  거래액 자체는 우리가 집계하지 않고 **이걸 인용**한다.
- `api.onchainagentintel.io/v1/public/stats` — 등록된 에이전트의 MCP·OpenAPI 응답 여부.

체인별 x402 결제 분포는 원본 쪽에서 별도 주기로 갱신되어 총계보다 며칠 뒤처진다. 카드에 기준
날짜를 같이 찍어 두는 이유다.

**스냅샷 — CORS가 막힌 곳**

x402 Bazaar(Coinbase CDP), PayAI Bazaar, agentscan은 응답에 CORS 헤더가 없어 브라우저가 직접
읽지 못한다. 스크립트로 받아 `data/snapshots/`에 두고 대시보드는 그 파일을 읽는다.

```sh
python3 scripts/refresh_snapshots.py           # 전체 (bazaar 수만 건, 몇 분)
python3 scripts/refresh_snapshots.py --quick   # 앞 5페이지만. 총계는 어차피 정확하다
```

`data/snapshot-state/`에 항목별 최초 관측 시각을 남겨 다음 실행 때 "24시간 +N"을 계산한다.
어느 소스가 실패해도 그 파일은 건드리지 않고 나머지만 갱신한다.

## 구조

```
index.html                  마크업 + 테마 부트스트랩
assets/style.css            디자인 토큰(ink-50…950), 라이트/다크 반전
assets/app.js               전부. 프레임워크·번들러 없음
data/facilitators.json      facilitator 주소 → 이름 (체인별로 주소가 다르다)
data/marketplaces.json      마켓플레이스 카드 정의
data/snapshots/*.json       CORS 막힌 소스의 스냅샷
scripts/refresh_snapshots.py
```

`app.js`는 의존성이 없다. 이벤트 토픽과 함수 셀렉터는 keccak256을 런타임에 돌리는 대신 상수로
박아 두었고(`TOPIC`, `EIP3009_SELECTORS`), 실제 체인 로그로 검증했다.

## 알아 둘 것

- **RPC는 공개 엔드포인트**다. 레이트 리밋에 걸리면 패널이 `RPC: …`를 띄운다. 체인별로 대체
  엔드포인트를 하나씩 더 물려 뒀고, 실패하면 다음 것으로 넘어간다. 자주 막히면 `CHAINS`의
  `rpcs` 배열에 본인 키가 붙은 URL을 앞에 넣으면 된다.
- **결제 시각은 추정치**다. 블록 헤더를 매번 받지 않고 헤드로부터의 블록 거리로 계산한다.
  상대 시각 표시에는 충분하고, RPC 호출을 정산 건수만큼 아낀다.
- **보관 창은 체인별로 따로** 잡는다(각 200건). 공유하면 정산이 4배 잦은 Polygon이 Base를
  버퍼 밖으로 밀어낸다.
- 흐름도는 최근 60건만 그린다. 노드가 그 이상이면 O(n²) 반발력 계산이 눈에 띄게 느려진다.

## 출처

설계와 데이터 스키마는 [code0xff/agents](https://github.com/code0xff/agents) (Apache-2.0)를
참고했다. `data/facilitators.json`, `data/marketplaces.json`은 그 저장소에서 가져왔다.
