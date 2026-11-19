[English](../README.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md) | **한국어**

# Operational Ontology

[![CI](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml/badge.svg)](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

> **Operational Ontology(운영 온톨로지)는 다른 시스템이 보유한 데이터 위에 구축하는 공유 도메인 모델입니다. 객체와 링크로 비즈니스를 읽고, 액션으로 비즈니스 규칙을 강제하며, 실행 시도를 감사(audit)하고 변경 사항을 기록 시스템(System of Record)에 다시 기록합니다.**
>
> 시맨틱 레이어는 비즈니스를 ‘읽게’ 해 줍니다. Operational Ontology는 비즈니스를 ‘운영하게’ 해 줍니다.

<img src="./assets/hero-diagram.svg" alt="읽기는 공유 모델에서 에이전트, 앱, 사람에게 전달됩니다. 쓰기는 감사가 이루어지는 액션 게이트를 통해 들어와, 해당 상태를 소유한 기록 시스템에 라이트백됩니다.">

이 저장소는 그 정의를 직접 실행해 볼 수 있도록 만든 작은 TypeScript 레퍼런스 구현입니다. 이 패턴의 출발점은 Palantir Foundry의 Ontology이며, 이 예제는 핵심 아이디어만 떼어 내어 직접 읽고, 포크하여, 자신의 프로젝트에 맞게 고쳐 쓸 수 있도록 구성했습니다. 이는 학습용 자료이며, 프레임워크나 npm 의존성으로 사용하기 위한 것이 아닙니다.

## 빠른 시작

Node.js 24 이상과 pnpm이 필요합니다.

```sh
pnpm install
pnpm demo    # 물리 데이터 → 통합 → 인덱싱 → 읽기 → 쓰기 → 거부 → 라이트백
pnpm test    # 동작 검증
```

데모는 [함께 읽을 글(영문)](https://www.dataengineeringweekly.com/p/building-an-operational-ontology)의 시나리오를 따릅니다. 한 회사가 경쟁사를 인수하면서 **스키마와 상태 코드 체계가 서로 다른 두 개의 레거시 주문 시스템**을 넘겨받습니다. SQL과 간단한 매핑으로 두 시스템의 데이터를 하나의 모델로 통합합니다. 실행하면 다음과 같이 동작합니다.

- 링크와 집계를 활용해 두 시스템에 걸친 질문에 답합니다.
- `cancelOrder`가 출고된 주문의 취소를 거부하고, 허용된 취소는 원래 ERP에 라이트백(write-back)합니다.
- `assignOrder`와 `addOrderNote`가 온톨로지가 소유한 상태를 저장하며, 이 상태는 재인덱싱으로 원천 데이터가 갱신되더라도 유지됩니다.
- 적용된 액션 시도와 거부된 액션 시도가 모두 감사 로그에 기록됩니다.

https://github.com/user-attachments/assets/02bb8ca0-a476-4e33-b0ea-25c46c6e9dda

## 왜 Operational Ontology를 정의하는가?

“이 고객의 미출고 주문은 몇 건인가?”라는 질문에 일관되게 답하려면 데이터를 비즈니스 용어로 읽는 모델이 필요합니다. 애플리케이션이나 AI 에이전트가 여기서 더 나아가 주문을 취소하려면, 작업 조건을 확인하고, 시도를 기록하며, 해당 레코드를 소유한 ERP에 변경 사항을 전달해야 합니다. 이러한 책임을 공유 모델의 일부로 다루는 것이 이 저장소의 출발점입니다.

“시맨틱 레이어”나 “온톨로지”라는 용어만으로는 그 책임의 범위가 어디까지인지 명확히 알 수 없습니다. 인접한 개념들이 각각 무엇을 모델링하고 비즈니스 작업을 어떻게 다루는지 비교해 보면 차이가 더 분명해집니다.

| 개념 또는 구성 | 주로 모델링하는 것 | 비즈니스 작업과의 관계 |
| --- | --- | --- |
| 시맨틱 레이어 | 지표, 속성, 집계의 의미 | 데이터에 대한 질문에 일관되게 답합니다. 작업 조건과 라이트백은 별도로 설계해야 합니다. |
| 형식 온톨로지 / 지식 그래프 | 개념의 의미, 엔티티와 관계 | 의미와 관계를 표현합니다. 데이터 갱신뿐만 아니라 비즈니스 규칙과 감사도 별도로 설계해야 합니다. |
| AI 컨텍스트 레이어 | 답변과 판단에 필요한 의미와 배경 | 에이전트의 이해를 돕습니다. 에이전트가 실행하는 작업에 대한 통제는 별도로 설계해야 합니다. |
| CRUD API / API 래퍼 | 데이터 접근 또는 개별 작업 | 규칙, 감사, 라이트백을 어디에서 강제할지는 각 API의 설계에 달려 있습니다. |
| **Operational Ontology** | **공유 객체와 링크, 그리고 비즈니스 규칙을 담은 액션** | **작업 조건, 감사, 권위 있는 원천(authoritative source)으로의 라이트백을 공유 모델의 계약에 포함합니다.** |

이 기술들은 서로 조합해 함께 사용할 수 있습니다. 여기서 이름 붙이려는 것은 **모든 사용 주체가 같은 모델을 통해, 같은 비즈니스 규칙 아래에서 상태를 변경하는 구조**입니다. Foundry의 Ontology에서 이 구성을 가져와 아래 네 가지 특성으로 Operational Ontology를 정의함으로써, 특정 제품과 무관하게 논의하고 구현할 수 있게 합니다.

## 네 가지 특성

이 저장소에서는 아래 네 가지 특성을 모두 갖춘 시스템을 Operational Ontology라고 부릅니다. 네 가지 특성은 패턴 자체를 기술한 것이며, 스토리지 엔진, 통합 도구, 일관성 메커니즘은 구현 시 선택할 사항입니다.

1. **시맨틱 객체와 링크.** 다른 시스템이 소유한 기존 데이터 위에 비즈니스 엔티티와 관계를 명시적으로 모델링합니다.
2. **액션을 통한 쓰기.** 비즈니스 결정에 따른 상태 변경은 명명된 액션(named action)을 통해서만 이루어집니다. 모든 사용 주체가 동일한 API를 사용합니다. 원천 데이터의 재인덱싱은 이와 별개의 인프라 작업입니다.
3. **액션에 담긴 비즈니스 규칙.** 사전 조건(precondition)이 “출고된 주문은 취소할 수 없다”와 같은 도메인 불변식(invariant)을 강제합니다. 규칙을 위반하면 기계가 읽을 수 있는 거부 응답이 반환되며, 적용된 시도와 거부된 시도 모두 감사 대상이 됩니다. 사전 조건은 비즈니스상의 유효성을 표현하고, 누가 실행할 수 있는지는 접근 정책이 결정합니다.
4. **기록 시스템으로의 라이트백.** 모든 상태에는 명시적으로 선언된 소유자가 있으며, 원천이 소유한 상태의 변경 사항은 통제된 부수 효과를 통해 해당 소유자에게 전파됩니다. 원천이 소유한 상태에 실제로 기록하는 것까지가 이 패턴에 포함됩니다.

예제에서 소유 형태는 세 가지입니다.

- **source-backed(원천 소유):** `Order.status`는 ERP가 소유하며, 취소는 ERP에 라이트백됩니다.
- **ontology-owned(온톨로지 소유):** 담당자와 메모는 원천에 대응하는 컬럼이 없으며 온톨로지가 직접 소유합니다.
- **derived(파생):** 합계와 건수는 쿼리 시점에 계산될 뿐 별도로 기록되지 않습니다.

<img src="./assets/authority-map.svg" alt="Order 객체의 소유권 맵(authority map). status와 total은 상위 주문 시스템이 소유하는 source-backed 상태로, 통제된 라이트백 경로를 사용합니다. assignee와 Note는 ontology-owned 상태로, 온톨로지 데이터 스토어가 단일 진실 공급원(SSoT)입니다. 집계와 건수는 derived로, 계산만 될 뿐 기록되지 않습니다. 소유자가 선언되지 않은 상태는 허용되지 않습니다.">

## 코드로 보는 패턴

모델은 객체 타입, 링크 타입, 액션 타입을 담은 평범한 데이터 값(plain value)입니다. 이 세 종류의 정의에는 각각 런타임에 대응하는 인스턴스가 있습니다.

| 정의(타입) | 런타임 인스턴스 |
| --- | --- |
| 객체 타입: `Order` | 개별 주문과 그 속성 |
| 링크 타입: `customerOrders` | 특정 고객과 주문 사이의 연결 |
| 액션 타입: `cancelOrder` | 특정 주문을 취소하려는 한 번의 호출 |

편집(edit)은 액션이 객체와 링크에 적용하려는 변경 사항을 기술합니다. 감사 로그는 적용과 거부를 포함해 액션 실행 시도와 그 결과를 모두 기록합니다. 정의는 코드에, 인스턴스 상태와 실행 기록은 스토어에 있습니다.

모델에는 “이 작업에 투입할 수 있는 설비는 무엇인가”와 같은 비즈니스 질문에 답하는 읽기 전용 **Function**도 정의할 수 있습니다. 사용 주체는 검색 조건을 직접 구현하지 않고도 공유된 비즈니스 규칙에 따른 결과를 얻을 수 있습니다.

모델을 클래스가 아닌 데이터로 표현하는 이유는 작업을 기술하는 데 필요한 정보를 열거할 수 있도록 하기 위해서입니다. `class Order { cancel() {} }`의 메서드 시그니처만으로는 파라미터 검증 규칙이나 사전 조건이 드러나지 않습니다. 이 구현에서는 해당 정보를 정의 값 안에 담아 두므로, 여러 애플리케이션이 모델을 공유하고 런타임에 검사하며 모델에서 MCP 도구를 생성할 수 있습니다.

아래 코드 발췌에서는 취소 규칙이 액션의 파라미터, 그리고 액션이 기술하는 편집과 나란히 놓여 있습니다. import 문과 전체 모델은 [`examples/orders/ontology.ts`](../examples/orders/ontology.ts)에 있습니다.

```ts
const objects = {
  Customer: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), name: z.string(), region: z.string() },
  }),
  Order: defineObject({
    primaryKey: 'id',
    properties: {
      id: z.string(),
      status: z.enum(['pending', 'shipped', 'cancelled']),
      total: z.number().int(), // 최소 화폐 단위 — 금액은 float로 다루지 않음
      assignee: z.string().nullable(),
    },
    owned: { assignee: null },                       // 온톨로지가 직접 소유하는 상태임을 선언
    source: 'north.tbl_order ∪ south.SALES_ORDER',   // 물리 데이터가 먼저 존재함
  }),
}

const ontology = defineOntology({
  name: 'orders',
  objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [
        ({ object }) => object.properties.status === 'shipped'
          ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.pk} has already shipped`)
          : undefined,
      ],
      effects: ({ object }) => [modify(object, { status: 'cancelled' })],
      writeback: true,
    }),
  },
})
```

`execute('cancelOrder', …)`를 호출하면 대상을 불러와 규칙을 검사합니다. 쓰기가 허용되면 런타임이 편집 계획을 검증하고 라이트백한 다음, 로컬 편집과 감사 항목을 커밋합니다. `effects` 함수는 변경 사항을 기술할 뿐이며, 외부 쓰기는 어댑터가 수행합니다.

<img src="./assets/action-gate.svg" alt="사람이든 AI 에이전트든 모든 호출자는 통제된 동일한 게이트를 통해 명명된 액션 cancelOrder를 호출합니다. 사전 조건은 출고된 주문을 기계가 읽을 수 있는 오류로 거부하고, 적용된 호출은 상태를 전이시킵니다. 적용되든 거부되든 모든 시도는 감사 로그에 남습니다. 범용 UPDATE 경로는 설계상 존재하지 않습니다.">

## 활용 사례: 데이터 기반 운영

제품 리콜, 설비 이상, 환자 입원 요청, 거래 경보. 운영 팀은 정보를 한데 모으고, 누구에게 또는 무엇에 대해 어떤 근거로 조치할지 결정하며, 상황이 바뀔 때마다 그 결정과 조치를 반복하는 방식으로 대응합니다. 이런 업무 흐름을 **데이터 기반 운영**이라고 부릅니다.

주문 데모(`pnpm demo`)는 Operational Ontology의 기본 구조를 보여 줍니다. 여러 시스템의 데이터를 하나의 공유 모델로 다루고, 여기에 비즈니스 규칙, 라이트백, 소유권, 감사를 결합합니다.

다음으로는 리콜 예제를 읽어 보기를 권합니다. 기존 주문 모델에 고객 지원 시스템을 추가하고, 출고된 주문이 있는 고객을 찾아 기존 티켓과 대조한 뒤 누락된 티켓을 생성합니다. 주문은 ERP에서, 티켓은 지원 시스템에서 관리되며, 이 예제는 데이터 탐색부터 비즈니스 액션 실행까지를 하나의 업무 흐름으로 연결합니다.

공장, 병원, 금융 예제는 각각 영향 범위 추적, 자원 평가와 배정, 집합과 집계를 통한 조사를 다루며 활용 범위를 넓힙니다.

| 예제 | 보여 주는 업무 흐름 | 실행 |
| --- | --- | --- |
| [리콜(영문)](../examples/recall/README.md) | ERP와 지원 시스템을 넘나들며 영향을 받은 고객을 찾아내고 교환 안내 티켓을 생성합니다. | `pnpm demo:recall` |
| [공장(영문)](../examples/factory/README.md) | 제조와 출하 관계를 따라가 영향 범위를 파악한 뒤, 근거와 함께 대응 작업을 기록합니다. | `pnpm demo:factory` |
| [병원(영문)](../examples/hospital/README.md) | 병상과 간호사 후보를 평가하고, 선택한 조합을 다시 검사한 뒤 임시 배정을 기록합니다. | `pnpm demo:hospital` |
| [금융(영문)](../examples/finance/README.md) | 여러 계좌가 공유하는 수취인과 그 이체 내역을 조사한 뒤, 근거와 함께 조사 케이스를 기록합니다. | `pnpm demo:finance` |

이 예제들은 가상의 데이터를 사용하며, 집합 탐색과 모델에 담긴 도메인 규칙을 결합합니다. 후보나 공통된 관계를 찾았다고 해서 그 자체로 결정이 확정되거나 비즈니스 상태가 바뀌지는 않습니다.

## AI 에이전트 연동(MCP)

```sh
pnpm mcp     # 같은 온톨로지를 stdio로 제공
```

서버는 모델에서 `search_order`, `traverse_customer_orders`, `cancel_order`, `read_audit_log` 같은 도구를 생성합니다. 에이전트가 출고된 주문을 취소하려고 하면 사람이 호출했을 때와 똑같이 `SHIPPED_ORDER_CANNOT_BE_CANCELLED`를 반환받습니다. 비즈니스 규칙이 모델 안에 있으므로 프롬프트로 규칙을 강제할 필요가 없습니다.

저장소의 [MCP 설정](../.mcp.json)은 주문 예제에 연결되어 있습니다. 에이전트는 반환된 데이터를 자체 코드 실행 환경에서 필터링합니다. 이 흐름과 도구 입력은 [구현 노트(영문)](./IMPLEMENTATION.md#mcp-query-inputs)에서 설명하며, [호출자 신원(영문)](./IMPLEMENTATION.md#visibility-and-caller-identity)은 별도로 문서화되어 있습니다.

https://github.com/user-attachments/assets/28327062-e09f-4103-943e-434a0e55b327

## 코드 읽는 법

먼저 처음 세 파일을 읽고, 나머지 파일은 데모의 특정 부분을 따라갈 때 참고하면 됩니다.

| 파일 | 살펴볼 내용 |
| --- | --- |
| [`examples/orders/ontology.ts`](../examples/orders/ontology.ts) | 비즈니스 모델: 객체, 관계, 소유권, 액션 규칙. |
| [`examples/orders/demo.ts`](../examples/orders/demo.ts) | 호출자가 읽기, 성공한 쓰기, 거부, 재인덱싱을 실행해 보는 과정. |
| [`src/core.ts`](../src/core.ts) | 모델 정의와 런타임: `execute()`를 따라가며 검증, 라이트백, 편집 및 감사 로그 커밋 과정을 살펴봅니다. |
| [`src/query.ts`](../src/query.ts) | 평가된 집합, 필터링, 집합 연산, 집계. |
| [`examples/orders/integrate.ts`](../examples/orders/integrate.ts) | 두 레거시 스키마가 하나의 스냅샷으로 통합되는 과정. |
| [`examples/orders/erp-adapter.ts`](../examples/orders/erp-adapter.ts) | 수락된 변경 사항이 원천에 반영되는 과정(오래된 상태에 기반한 취소 거부 포함). |
| [`src/mcp.ts`](../src/mcp.ts) | 동일한 모델이 에이전트의 도구 인터페이스가 되는 과정. |

[`tests/`](../tests/)는 공통 동작과 타입에 대한 기대 사양을 실행 가능한 테스트 형태로 담고 있으며, 시나리오 테스트는 각 예제 옆에 `scenario.test.ts`로 위치해 있습니다. `pnpm test`는 둘 다 실행합니다. API 세부 사항, 처리 순서, 엣지 케이스는 [구현 노트(영문)](./IMPLEMENTATION.md)에서 설명합니다.

## 범위와 선언된 동작

이 저장소는 중간 계층을 구현합니다. 주변 애플리케이션과 데이터 통합은 데모에서 제공합니다.

담당자와 메모처럼 원천에 없는 상태, 그리고 액션 시도의 기록은 이 계층에 보관해야 합니다. 따라서 이 구현은 인덱싱된 원천 스냅샷과 함께, 액션 편집과 감사 로그를 위한 스토어를 직접 소유합니다.

<img src="./assets/where-this-sits.svg" alt="애플리케이션, Operational Ontology, 데이터 계층이라는 세 계층을 각각 Foundry와 이 저장소의 구현에 대응시킨 그림. 이 저장소는 중간 계층을 구현하며, 이 계층은 자체 스토어를 소유합니다. 온톨로지와 데이터 계층의 경계에는 두 가지 계약이 있습니다. 통합된 물리 데이터는 외부에서 주어지는 입력이며, 라이트백은 통제된 부수 효과입니다.">

구현체는 호출자가 관찰할 수 있는 동작 선택을 선언해야 합니다. 이 구현의 선택은 다음과 같으며, `Runtime.declarations`로도 노출됩니다.

| 항목 | 이 구현의 선택 |
| --- | --- |
| 소유권 | `owned`와 `writeback`으로 선언하며, 각 편집 계획과 대조해 검증합니다. |
| 라이트백 실패 | 라이트백을 먼저 실행합니다. 원천이 거부하면 로컬 편집은 커밋되지 않습니다. 원천에서는 성공했는데 로컬 커밋이 실패하면 두 시스템의 상태가 어긋나므로 조정(reconciliation)이 필요합니다. |
| 재인덱싱 | 원천 소유 상태는 갱신되고, 온톨로지 소유 상태는 유지됩니다. 온톨로지 소유 편집을 고아 상태(orphan)로 만드는 데이터 적재(load)는 거부됩니다. |
| 가시성 | 정책이 없는 객체는 모두에게 보입니다. actor는 호출자가 직접 지정하는 값이며 별도 인증은 없습니다. 감사 로그 읽기는 범위 제한이 없는 관리자용 뷰입니다. |

런타임은 동기식 액션 실행과 SQLite로 패턴을 보여 줍니다. UI 빌더, 파이프라인 프레임워크, 확장 가능한 인덱싱 서비스, 범용 인가 시스템은 포함하지 않습니다. 쓰기 게이트는 호출자 프로세스 내부의 API 계약입니다. 이렇게 경계를 명확히 그어 둔 덕분에 구현을 읽기 쉽게 유지할 수 있습니다.

액션은 실행 전에 지정한 ID를 사용해 온톨로지 소유 객체를 생성하거나, 라이트백을 통해 원천 소유 레코드를 생성할 수 있습니다. 삭제, 링크 속성, 복합 키는 지원하지 않습니다. 그 밖의 제약과 API 세부 사항은 [구현 노트(영문)](./IMPLEMENTATION.md#current-limits)에 정리되어 있습니다. 공개된 버전은 [릴리스 노트(영문)](https://github.com/gura105/operational-ontology/releases)에서 확인할 수 있습니다.

## FAQ

**이건 그냥 검증이 붙은 CRUD 아닌가요?**

구성 요소는 익숙하지만, 그것을 엮는 방식은 그렇지 않습니다. 일반적인 CRUD 검증은 하나의 애플리케이션 안에서, 그 애플리케이션이 소유한 테이블을 대상으로 이루어집니다. 여기서는 모델이 다른 시스템이 소유한 데이터 위에 놓이고, 모든 사용 주체(UI, 스크립트, 에이전트)가 모델을 공유하며, 모든 비즈니스 쓰기가 액션을 거치고, 액션 시도가 감사되며, 수락된 변경 사항이 기록 시스템에 라이트백됩니다. 기존 개념으로 가장 가깝게 표현하면, 특정 애플리케이션에서 분리해 다른 시스템의 데이터 위에 올려 둔 CQRS 커맨드 계층입니다.

**지식 그래프도 쓰기가 가능하지 않나요?**

가능합니다. 조건부 갱신도 할 수 있고, 스키마와 인스턴스도 모두 갖추고 있습니다. Operational Ontology는 여기에 액션 타입(비즈니스 작업의 정의)과 그 인스턴스(개별 실행 시도)를 더합니다. 명명된 비즈니스 작업, 기계가 읽을 수 있는 거부 응답, 시도에 대한 감사 추적, 기록 시스템으로의 라이트백을 하나의 단위로 모델에 포함합니다. 차이는 구현 가능 여부에 있지 않습니다. 이 모든 것은 트리플 스토어 위에도 구축할 수 있습니다. 차이는 모델이 무엇을 일급 요소로 정의하고 통제하는가에 있습니다.

**왜 YAML이 아니라 TypeScript로 정의하나요?**

비즈니스 규칙은 코드이고, YAML에 끼워 넣은 규칙 표현 언어는 임시방편식 규칙 엔진으로 비대해지기 쉽기 때문입니다. TypeScript 객체 리터럴을 쓰면 모델은 열거 가능한 상태로 유지되고, 규칙은 타입이 지정된 일반 코드로 남습니다. 구조는 데이터로, 규칙은 함수로 표현합니다.

## 선행 사례

- **Palantir Foundry Ontology:** 이 패턴의 출발점입니다. [시맨틱/키네틱 모델(영문)](https://www.palantir.com/docs/foundry/ontology/overview), [액션 타입(영문)](https://www.palantir.com/docs/foundry/action-types/overview), [라이트백 웹훅(영문)](https://www.palantir.com/docs/foundry/action-types/webhooks) 문서에서 확인할 수 있습니다.
- **DDD, CQRS, 이벤트 소싱:** 엔티티, 커맨드, 조건 검사를 거치는 상태 변경, 로그를 다루는 관련 개념들입니다. 여기서는 도메인 모델이 여러 사용 주체에게 공유되고 다른 시스템의 데이터 위에 놓입니다.
- **이 용어의 선행 사용 사례:** Vladimir Kozlov의 [정의 에세이(영문)](https://www.linkedin.com/pulse/operational-ontology-semantic-interface-between-data-action-kozlov-njnle)와 [Foundry 입문(영문)](https://www.linkedin.com/pulse/understanding-palantirs-operational-ontology-beginners-kozlov-d0vse), 그리고 FSTech의 [Operational Ontology Framework(영문)](https://github.com/fstech-digital/operational-ontology-framework)가 있습니다. 이 저장소는 위의 네 가지 특성과 실행 가능한 예제를 통해 이 용어를 어떤 의미로 사용하는지 구체적으로 밝힙니다.

## 작성자

[gura105](https://github.com/gura105)([X](https://x.com/gura105))가 작성하고 유지 관리합니다. 질문이나 반례는 [Discussions](https://github.com/gura105/operational-ontology/discussions)에서 환영합니다.

MIT © gura105
