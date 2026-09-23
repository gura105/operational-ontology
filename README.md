**English** | [日本語](./docs/README.ja.md) | [简体中文](./docs/README.zh-CN.md)

# Operational Ontology

[![CI](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml/badge.svg)](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **An operational ontology is a shared domain model over other systems' data: objects and links for reading the business, and actions that enforce business rules, audit attempts, and write changes back to the systems of record.**
>
> A semantic layer lets you *read* your business. An operational ontology lets you *run* it.

<img src="./docs/assets/hero-diagram.svg" alt="Reads travel from a shared model to agents, apps, and people. Writes enter through an audited action gate and write back to the systems of record that own the state.">

This repository makes that definition runnable in a small TypeScript reference implementation. Palantir Foundry's Ontology is the pattern's starting point; this example isolates the ideas so you can read, fork, and adapt them. It is a learning resource, not a framework or an npm dependency.

## Quickstart

Requires Node.js 24 or later and pnpm.

```sh
pnpm install
pnpm demo    # physical data → integrate → index → read → write → refusal → write-back
pnpm test    # verify the behavior
```

The demo follows the [accompanying article](https://www.dataengineeringweekly.com/p/building-an-operational-ontology): a company acquires a competitor and inherits **two legacy order systems with different schemas and status encodings**. SQL and a small mapping integrate their data into one model. Run it to see:

- links and aggregates answer questions across both systems;
- `cancelOrder` refuse a shipped order and write an allowed cancellation back to the original ERP;
- `assignOrder` and `addOrderNote` store state owned by the ontology, which survives re-indexing while source data refreshes;
- applied and rejected action attempts appear in the audit log.

https://github.com/user-attachments/assets/02bb8ca0-a476-4e33-b0ea-25c46c6e9dda

## Why define Operational Ontology?

Answering “How many unshipped orders does this customer have?” consistently requires a model for reading data in business terms. When an application or AI agent goes on to cancel an order, it also needs to check the operation's conditions, record the attempt, and deliver the change to the ERP that owns the record. Treating these responsibilities as part of a shared model is this repository's starting point.

The terms “semantic layer” and “ontology” alone do not tell us how much of that responsibility is included. Comparing nearby concepts by what they model and how they handle business operations makes the distinction clearer.

| Concept or arrangement | What it primarily models | Relationship to business operations |
| --- | --- | --- |
| Semantic layer | The meaning of metrics, attributes, and aggregates | Answers data questions consistently. Operation conditions and write-back require additional design. |
| Formal ontology / knowledge graph | Conceptual meaning, entities, and relationships | Represents meaning and relationships. Business rules and audit need to be designed alongside data updates. |
| AI context layer | Meaning and background for answers and decisions | Supports an agent's understanding. Governance of the operations it executes requires additional design. |
| CRUD API / API wrapper | Data access or individual operations | Where rules, audit, and write-back are enforced depends on each API's design. |
| **Operational ontology** | **Shared objects and links, plus actions carrying business rules** | **Makes operation conditions, audit, and write-back to authoritative sources part of the shared model's contract.** |

These technologies can be combined. The arrangement we want to name is one where **every consumer changes state through the same model, under the same business rules**. We draw this arrangement from Foundry's Ontology and define it as Operational Ontology through the four properties below, so it can be discussed and implemented independently of a particular product.

## The four properties

This repository uses *operational ontology* for a system with all four properties. They describe the pattern; storage engines, integration tools, and consistency mechanisms are implementation choices.

1. **Semantic objects and links.** Business entities and relationships are modeled explicitly over existing data owned by other systems.
2. **Action-gated writes.** Business decisions change state only through named actions. Every consumer uses that same API. Source re-indexing is a separate infrastructure operation.
3. **Business rules at the action.** Preconditions enforce domain invariants such as “a shipped order cannot be cancelled.” Violations produce machine-readable refusals, and both applied and rejected attempts are audited. Preconditions express business validity; access policies decide who may act.
4. **Write-back to systems of record.** Every piece of state has a declared owner, and changes to source-owned state propagate back to its owner through governed side effects. The pattern includes actual writes to source-owned state.

Ownership has three forms in the example:

- **source-backed:** the ERP owns `Order.status`; cancellation writes back to it.
- **ontology-owned:** the ontology owns the assignee and notes, which have no source columns.
- **derived:** totals and counts are computed at query time and are never written.

<img src="./docs/assets/authority-map.svg" alt="An authority map for an Order object. Status and total are source-backed by the upstream order system and use a governed write-back path. Assignee and Note are ontology-owned, making the ontology datastore their single source of truth. Aggregates and counts are derived, computed only, and never written. State with no declared owner is forbidden.">

## The pattern in code

The model is a plain value containing object types, link types, and action types. These three kinds of definition have corresponding instances at runtime.

| Definition (type) | Runtime instance |
| --- | --- |
| Object type: `Order` | An individual order and its properties |
| Link type: `customerOrders` | A connection between a particular customer and order |
| Action type: `cancelOrder` | One call attempting to cancel a particular order |

Edits describe the changes an action proposes to objects and links. The audit log records action execution attempts and their outcomes, including application and refusal. Definitions live in code; instance state and execution records live in the store.

A model can also define read-only **Functions** for business questions such as finding equipment eligible for a job. Consumers get results based on shared business rules without implementing the search conditions themselves.

The model is data rather than classes so the information needed to describe an operation can be enumerated. The method signature in `class Order { cancel() {} }` alone does not expose parameter validation rules or preconditions. This implementation keeps that information in the definition value, so applications can share the model, inspect it at runtime, and generate MCP tools from it.

In this extract, the cancellation rule lives alongside the action's parameters and the edits it describes. The imports and complete model are in [`examples/orders/ontology.ts`](./examples/orders/ontology.ts).

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
      total: z.number().int(), // minor units — money is not a float
      assignee: z.string().nullable(),
    },
    owned: { assignee: null },                       // the ontology's own state, declared
    source: 'north.tbl_order ∪ south.SALES_ORDER',   // physical data comes first
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

Calling `execute('cancelOrder', …)` loads the target and checks the rule. For an allowed write, the runtime validates the edit plan, writes it back, then commits the local edits and audit entry. The effects function only describes changes; the adapter performs the external write.

<img src="./docs/assets/action-gate.svg" alt="Every caller — human or AI agent — invokes the named action cancelOrder through the same governed gate. The precondition refuses shipped orders with a machine-readable error; an applied call transitions the status. Every attempt, applied or refused, lands in the audit log. A generic UPDATE path is absent by design.">

## Use cases: data-driven operations

An equipment anomaly, a patient admission request, a transaction alert. Operational teams respond by bringing information together, deciding who or what to act on and on what evidence, and repeating those decisions and actions as conditions change. We call this workflow **data-driven operations**.

The three examples below use Operational Ontology to identify the objects to act on and the supporting evidence, then use an Action to recheck conditions and record a task, provisional allocation, or investigation case.

| Example | Business question and response | Run |
| --- | --- | --- |
| [Factory](./examples/factory/README.md) | Which customers received potentially affected lots? Create a contact/reinspection task. | `pnpm demo:factory` |
| [Hospital](./examples/hospital/README.md) | Which bed and nurse meet a patient's requirements? Record a provisional allocation. | `pnpm demo:hospital` |
| [Finance](./examples/finance/README.md) | Which recipients are shared by selected accounts? Record a case and its evidence transfers. | `pnpm demo:finance` |

These synthetic examples combine set exploration with domain rules in the model. Finding a candidate or common relationship does not itself establish a decision or change the business state.

## For AI agents (MCP)

```sh
pnpm mcp     # serve the same ontology over stdio
```

The server generates tools such as `search_order`, `traverse_customer_orders`, `cancel_order`, and `read_audit_log` from the model. An agent cancelling a shipped order receives `SHIPPED_ORDER_CANNOT_BE_CANCELLED`, just as a human caller does. Business rules live in the model, so the prompt does not have to enforce them.

The repository's [MCP configuration](./.mcp.json) connects the orders example. Agents filter returned data in their own code execution environment. The [implementation notes](./docs/IMPLEMENTATION.md#mcp-query-inputs) describe this flow and tool inputs; [caller identity](./docs/IMPLEMENTATION.md#visibility-and-caller-identity) is documented separately.

https://github.com/user-attachments/assets/28327062-e09f-4103-943e-434a0e55b327

## Reading the code

Start with the first three files; use the others to follow a particular part of the demo.

| File | What to look for |
| --- | --- |
| [`examples/orders/ontology.ts`](./examples/orders/ontology.ts) | The business model: objects, relationships, ownership, and action rules. |
| [`examples/orders/demo.ts`](./examples/orders/demo.ts) | A caller exercising reads, successful writes, refusals, and re-indexing. |
| [`src/core.ts`](./src/core.ts) | Model definitions and their runtime: follow `execute()` through validation, write-back, and the edit/audit commit. |
| [`src/query.ts`](./src/query.ts) | Evaluated sets, filtering, set algebra, and aggregation. |
| [`examples/orders/integrate.ts`](./examples/orders/integrate.ts) | How the two legacy schemas become one snapshot. |
| [`examples/orders/erp-adapter.ts`](./examples/orders/erp-adapter.ts) | How an accepted change reaches its source, including refusal of a stale cancellation. |
| [`src/mcp.ts`](./src/mcp.ts) | How the same model becomes the agent's tool surface. |

[`tests/`](./tests/) makes the shared behavior and typing expectations executable; scenario tests live alongside their examples as `scenario.test.ts`. `pnpm test` runs both. The [implementation notes](./docs/IMPLEMENTATION.md) explain API details, processing order, and edge cases.

## Scope and declared behavior

This repository implements the middle layer. The demo supplies the surrounding applications and data integration.

State absent from the sources, such as assignees and notes, and the record of action attempts need to be kept in this layer. This implementation therefore owns a store for action edits and the audit log alongside the indexed source snapshots.

<img src="./docs/assets/where-this-sits.svg" alt="Three layers — applications, the operational ontology, and the data layer — each mapped to its implementation in Foundry and in this repository. This repository implements the middle layer, which owns its own store. At the ontology–data seam sit the two contracts: integrated physical data is given, and write-back is a governed side effect.">

An implementation must declare choices that callers can observe. This one makes the following choices, also exposed as `Runtime.declarations`:

| Concern | This implementation |
| --- | --- |
| Ownership | Declared by `owned` and `writeback`; checked against each edit plan. |
| Write-back failure | Write-back runs first. If the source refuses, no local edit commits. If the source succeeds and the local commit fails, the systems diverge and need reconciliation. |
| Re-indexing | Source-backed state refreshes; ontology-owned state survives. A load that would orphan an owned edit is refused. |
| Visibility | An object with no policy is visible to everyone. The actor is self-declared; there is no authentication. Audit reads are an unscoped administrative view. |

The runtime demonstrates the pattern with synchronous action execution and SQLite. It includes no UI builder, pipeline framework, scalable indexing service, or general authorization system. The write gate is an API contract within the caller's process. These boundaries keep the implementation readable.

Actions can create ontology-owned objects or source-backed records through write-back, using IDs specified before execution. Deletes, link properties, and composite keys are unsupported. The [implementation notes](./docs/IMPLEMENTATION.md#current-limits) document the remaining limits and API details. Published versions are in the [release notes](https://github.com/gura105/operational-ontology/releases).

## FAQ

**Isn't this just CRUD with validation?**

The parts are familiar; the configuration is not. Typical CRUD validation lives inside one application, on tables that application owns. Here the model sits on data other systems own, is shared by every consumer (UIs, scripts, agents), routes every business write through actions, audits action attempts, and writes accepted changes back to the systems of record. The closest existing description is a CQRS command layer extracted from the application and placed over someone else's data.

**Isn't a knowledge graph writable too?**

Yes, including conditional updates. It also has both a schema and instances. Operational Ontology adds action types (business operation definitions) and their instances (individual execution attempts). It brings named business operations, machine-readable refusals, an audit trail of attempts, and write-back to the systems of record into the model as one unit. The difference is not capability — all of this can be built on a triple store — but what the model defines and governs as first-class elements.

**Why TypeScript definitions instead of YAML?**

Because business rules are code, and rule-expression languages embedded in YAML tend to grow into ad-hoc rule engines. TypeScript object literals keep the model enumerable while the rules stay ordinary typed code. Structure as data, rules as functions.

## Prior art

- **Palantir Foundry Ontology:** the pattern's starting point; see its [semantic/kinetic model](https://www.palantir.com/docs/foundry/ontology/overview), [action types](https://www.palantir.com/docs/foundry/action-types/overview), and [write-back webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks).
- **DDD, CQRS, and event sourcing:** related ideas for entities, commands, guarded changes, and logs. Here the domain model is shared across consumers and sits over other systems' data.
- **Earlier uses of the term:** Vladimir Kozlov's [definition essay](https://www.linkedin.com/pulse/operational-ontology-semantic-interface-between-data-action-kozlov-njnle) and [Foundry introduction](https://www.linkedin.com/pulse/understanding-palantirs-operational-ontology-beginners-kozlov-d0vse), and FSTech's [Operational Ontology Framework](https://github.com/fstech-digital/operational-ontology-framework). This repository states its own meaning through the four properties and runnable example above.

## Author

Written and maintained by [gura105](https://github.com/gura105) ([X](https://x.com/gura105)). Questions and counterexamples are welcome in [Discussions](https://github.com/gura105/operational-ontology/discussions).

MIT © gura105
