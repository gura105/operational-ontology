**English** | [日本語](./README.ja.md)

# Operational Ontology

[![CI](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml/badge.svg)](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **An operational ontology is a shared domain model built on top of the data of systems you don't own — objects, links, and actions — where reads traverse the model and writes are gated by actions that carry business rules, are audited, and propagate back to the systems of record that own the state they change.**
>
> A semantic layer lets you *read* your business. An operational ontology lets you *run* it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/hero-diagram-dark.svg">
  <img src="./assets/hero-diagram.svg" alt="Reads travel from a shared model to agents, apps, and people. Writes enter through an audited action gate and write back to the systems of record that own the state.">
</picture>

Palantir Foundry's Ontology is one implementation of this pattern. This repository is another: a minimal reference implementation, small enough to read in one sitting. It exists to make the definition precise and runnable; it is not a framework. Fork it and reuse the ideas.

## Quickstart

```sh
pnpm install
pnpm demo    # physical data → integrate → index → read → write → refusal → write-back
pnpm test    # the same behavior, as executable tests
```

The demo uses the scenario from the [article this repository accompanies](https://x.com/gura105/status/2077153028982133080) (in Japanese). A company acquires a competitor and inherits **two legacy order systems with different schemas and status encodings**. A few dozen lines of SQL and a small TypeScript mapping integrate them, and the ontology models `Customer`, `Order`, and `Product` on top — plus `Note`, a type that exists in no source system. The demo then shows:

- a link traversal answering "which orders contain this product?" across both systems
- `assignOrder` writing state that exists in no legacy system — edits can live in a layer above the sources
- `cancelOrder` on a shipped order refused with `SHIPPED_ORDER_CANNOT_BE_CANCELLED`
- `cancelOrder` on an open order succeeding, with the row in the legacy ERP actually changing
- a re-index of the live legacy systems, where order data refreshes from the ERP while the assignment and notes — state the ontology itself owns — survive
- every attempt, applied or refused, recorded in the audit log

![Terminal recording of pnpm demo: a shipped order's cancellation is refused, an allowed cancellation reaches the legacy ERP, ontology-owned state survives a re-index, and the audit log holds applied and rejected attempts alike.](./assets/demo.gif)

## The four properties

A system implements the pattern when all four properties hold. They constrain *what* must be true, not *how* to build it: outbox or webhook, SQL or search index, one store or many are all implementation choices. Treat them as shared vocabulary for discussing systems, not as a certification to pass.

1. **Semantic objects and links.** Business entities and their relationships are modeled explicitly, on top of physical data that existed first and that other systems own.

2. **Action-gated writes.** A business decision changes state only through a named action. There is no generic update path — not for a user, not for an application, not for an agent. State in this layer also changes for two other reasons, and neither is a loophole: re-indexing only replays what the sources already say, and schema evolution (under review) changes what can be said, not what is true. Any write that picks a business outcome is a decision, whatever the endpoint is named, and decisions go through actions.

3. **Business rules at the action.** Preconditions check domain invariants ("a shipped order cannot be cancelled") and refuse violations with machine-readable errors. They are not access control, and not UI validation. Every attempt, applied or refused, is recorded in the audit log.

4. **Write-back to systems of record.** The model declares, for every piece of state, which system owns it. There are three kinds:

   - **source-backed** — state owned by an upstream system, such as an order's status mastered in the ERP. A change to it propagates back to that source as a governed, ordered side effect; the source stays authoritative.
   - **ontology-owned** — state no source system has a column for, such as an assignee or a triage note. For this state the ontology's own store is the system of record, by declaration.
   - **derived** — computed state such as aggregates and counts. It is never written.

   What the property forbids is state with no declared owner: a local copy of source-owned data that is modified but never written back, or a write nobody can place. An implementation with no source-backed writes at all does not implement a smaller version of this pattern; it is an ordinary application with its own database.

A quick test: **"Can you cancel an order from your semantic layer?"**

- If the answer is no, you have a read layer — useful, but a different thing.
- If the answer is yes but no row in any system of record ever changes, you have a parallel database — also a different thing.
- If it also cancels already-shipped orders without complaint, you have a write API; property 3 is the whole difference.

## Why another word?

The pattern needs a name of its own because "ontology" already means too many things:

| called an "ontology" | what it is | governed writes? |
| --- | --- | --- |
| philosophical ontology | the study of what exists | — |
| formal ontology (OWL / RDF) | machine-reasonable semantics | no |
| knowledge graph | entities and relationships — writable as data, not as operations | no |
| AI context layer (the 2026 wave of "ontology"-branded platform features) | semantic grounding for AI answers | no |
| **operational ontology (Foundry-style)** | business domain schema **+ rule-carrying actions** | **yes** |

Each row is a legitimate tool, and the table is not a ranking. But the one property that changes what a layer can *do* — whether it accepts writes governed by business rules — cuts across the whole table and had no name of its own. This repository gives it one.

## What an implementation declares

The four properties leave the mechanisms open, but some choices differ between implementations in ways users can observe. Those choices must be declared, not left silent. There are four:

- **Authority** — which state is source-backed, which ontology-owned, which derived.
- **Failure semantics** — what happens when write-back and the local commit disagree.
- **Re-indexing vs edits** — whether ontology-owned state survives a refresh of the base.
- **Visibility default** — what an object with no policy falls back to.

This repository's answers, in the same order. Ownership is declared in the model — `owned` marks ontology-owned properties, link types, or whole object types, and `writeback: true` marks an action's changes source-backed — and the runtime checks every edit plan against those declarations instead of trusting them ([details](./IMPLEMENTATION.md#the-authority-line-checked)). Write-back runs before the local commit, so if the source refuses, nothing changes here (see [Failure semantics](#failure-semantics)). Ontology-owned state survives re-indexing: edits live in an overlay that `load()` reapplies over the fresh base, and a re-index that would orphan an edit is refused whole. Visibility defaults to fail-open: no policy means visible to everyone (see the [FAQ](#faq)).

All four answers are also collected in one enumerable value, `Runtime.declarations`, so they can be read at runtime rather than trusted as prose. An implementation may answer all four differently and still be inside the pattern. If a product calls itself an operational ontology, ask for its four answers, not for a certificate.

## For AI agents (MCP)

```sh
pnpm mcp     # serve the same ontology to agents over stdio
```

The MCP tool surface is generated from the model: `search_order`, `traverse_customer_orders`, `cancel_order`, `read_audit_log`, … — one tool per query shape and one per action. Two consequences:

- **There is no raw SQL tool.** Agents get exactly the operations the model defines, and nothing else.
- **The same preconditions that gate humans gate agents.** An agent that tries to cancel a shipped order receives `{ "error": { "code": "SHIPPED_ORDER_CANNOT_BE_CANCELLED", … } }` — a machine-readable refusal it can read, recover from, and explain to its user.

Reads are scoped the same way. Every query runs as an actor — the identity on whose behalf the call is made — and visibility policies attached to the model decide which objects that actor can see. Agent sessions are no exception; the audit log is the one declared exception, an unscoped administrative view. Over stdio all callers collapse into one actor. `OO_AGENT=<name> pnpm mcp` names that actor, which is labeling, not authentication.

![An agent (Claude Code) is asked to cancel every order of a customer. One cancellation is applied; the shipped order is refused with SHIPPED_ORDER_CANNOT_BE_CANCELLED, so the agent files a note on it instead — and the audit log records all three attempts under agent:claude-code.](./assets/demo-mcp.gif)

**Business rules live in the ontology, not in the prompt.**

| approach | reads | writes | rules enforced by |
| --- | --- | --- | --- |
| raw DB access (SQL tool / DB MCP) | tables | unrestricted `UPDATE` | nothing — the prompt, at best |
| semantic layer / metrics MCP | governed metrics | — | n/a (read-only) |
| API wrapper tools | endpoints | per-endpoint | each backend, inconsistently |
| **operational ontology** | objects, links, aggregates | **named actions only** | **preconditions in the model, audited** |

## The pattern

Five concepts — objects, links, actions, edits, and the audit log — are defined as data and interpreted by a runtime (`src/core.ts`):

```ts
const ontology = defineOntology({
  name: 'orders',
  objects: {
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
  },
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [
        ({ object }) => object.status === 'shipped'
          ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.id} has already shipped`)
          : undefined,
      ],
      effects: ({ object }) => [modify('Order', object.id, { status: 'cancelled' })],
      writeback: true,
    }),
  },
})
```

Because the definition is a plain value, it can be enumerated, diffed, and versioned; the MCP tool surface above is derived from it mechanically.

`Runtime.execute()` is the only operational write path the API exposes. It always runs these steps, in this order:

1. validate the parameters
2. evaluate the preconditions
3. run the effects function, which returns an edit plan and performs nothing itself
4. dry-run the whole plan through the same code the commit uses, then roll it back
5. check the plan against the authority declarations
6. write back to the systems of record
7. commit the edits and the audit entry in one transaction

This closure is a contract on the API, not a privilege boundary: the runtime lives in its caller's process, and code that holds the database handle itself can bypass the gate ([details](./IMPLEMENTATION.md#transaction-ownership)). `load()` is separate infrastructure: it re-indexes the sources — replay, not decision — and is not a user API.

Reads carry identity too. Every `search` / `get` / `traverse` / `aggregate` runs as an `actor`, and an object type may attach a `visibility` predicate — row-level security in its minimal form, stored in the model like everything else. A hidden object is indistinguishable from a nonexistent one, both for reads and as an action target.

Edits are data as well: `modify`, `create`, and `link` / `unlink`. Actions can therefore change link instances, not just properties. Link *types* are part of the model and do not change here; which links exist between which objects is state, and it changes only through actions — cardinality included: the runtime refuses a `link` that would give an order two customers. "Reassign this order to another customer" is an unlink plus a link, applied atomically under the same preconditions as everything else. Creation goes through the same gate: the demo's `addOrderNote` creates an ontology-owned note and links it to its order in one atomic plan. Deletes are out of scope in this version (see [Status](#status)); changing the model itself — new object types, new link types — is schema evolution (see the FAQ).

The model is data rather than classes for a practical reason. `class Order { cancel() {} }` cannot be enumerated into agent tools, shared across applications, or inspected at runtime without an added reflection layer, and its signature says nothing about preconditions. A class-based domain layer is private to one application; the point of this pattern is a domain layer that is shared.

## Where this sits

Three layers. This repository implements the middle one only.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/where-this-sits-dark.svg">
  <img src="./assets/where-this-sits.svg" alt="Three layers — applications, the operational ontology, and the data layer — each mapped to its implementation in Foundry and in this repository. This repository implements the middle layer, which owns its own store. At the ontology–data seam sit the two contracts: integrated physical data is given, and write-back is a governed side effect.">
</picture>

**Upstream contract (with the data platform):** integrated physical data is a given. Pipelines, dataset transactions, and rollback belong to the data platform.

**Downstream contract (with the systems of record):** write-back is a governed side effect, not a distributed transaction (see below).

One consequence separates this pattern from query-side layers: a layer that only answers queries can stay virtual, but a layer that accepts writes must own state. Edits exist here before — or instead of — the systems of record (`assignOrder` writes ontology-owned state no legacy system has a column for), so the ontology keeps its own store and its own audit log. What this repository does not own is the indexing machinery that makes reads fast at enterprise scale: incremental indexing, adjacency indexes, search backends. That is how Foundry serves billions of objects; it belongs to an implementation of the layer, not to the pattern.

## Failure semantics

**What the pattern requires.** The pattern does not prescribe a consistency mechanism between the ontology and the systems of record; distributed transactions, ordering contracts, outboxes, and reconciliation jobs are all implementation choices. It does require the failure behavior to be **declared**, because unlike an internal mechanism, failure behavior is observable: users can watch the systems diverge. Divergence you can reason about is an engineering problem; divergence discovered in production is an incident.

**What this implementation declares.** The `WritebackAdapter` runs before the local commit — the ordering of Foundry's write-back webhooks (one of Foundry's two modes; the other runs side effects after the edit). Two consequences:

- If the system of record refuses, nothing changes in the ontology.
- The reverse failure remains possible: the adapter succeeded and the local commit failed. When that happens the systems have diverged, and reconciliation is up to the operator. [Palantir's webhook documentation](https://www.palantir.com/docs/foundry/action-types/webhooks) acknowledges the same gap in Foundry's write-back mode.

Three details bound that risk ([full mechanics](./IMPLEMENTATION.md#failure-semantics-in-detail)): nothing invalid ever reaches a system of record, because the whole edit plan is dry-run through the commit's own code before the adapter runs; the audit log records the full plan for both failure directions, as reconciliation material; and "every attempt is audited" means every attempt this runtime observed to completion. Within its own store the runtime is transactional: an action's edits and its audit entry commit atomically in a single SQLite transaction, and rejected attempts are logged too.

**Preconditions and freshness.** Guaranteed: preconditions hold against the ontology store — the last indexed snapshot plus applied edits. Not guaranteed: the write-back step does not re-verify invariants at the source, so if a source changes behind the ontology's back, the invariant may no longer hold there. Narrowing that gap is the adapter's choice — conditional write-backs, compare-and-set, re-verification at the source. The demo adapter does this: a guarded `UPDATE` lets the ERP refuse a stale cancellation.

**Concurrent edits.** Guaranteed: this implementation is a synchronous single-writer — actions execute one at a time, serialized by the runtime — and the runtime refuses to run inside a caller-opened transaction, so a committed-and-audited action cannot be silently rolled back after success was reported. Not guaranteed: the `WritebackAdapter` interface is synchronous, and a real networked write-back breaks the serialization; an implementation that goes there must declare what replaces it. The rest of the store's boundary is a declared contract, not a defended one: rules and the adapter must not touch the ontology store, because no in-process check can stop code that holds the database handle ([details](./IMPLEMENTATION.md#transaction-ownership)).

**Re-indexing vs edits.** The store holds a base indexed from the sources plus the edits actions have made on top, and sources keep changing, so every implementation must decide what a re-index does to edits. Here — Foundry's shape, minimized — a snapshot may only supply source-backed state; edits to ontology-owned properties survive via an overlay reapplied over the fresh base; ontology-owned types and links are untouched by `load()` altogether. A re-index that would orphan an ontology-owned edit is refused whole, leaving the previous state standing: that is a reconciliation decision, and the runtime does not make reconciliation decisions silently. The full rules — including deletes meeting surviving edits, and partial snapshots — are in the [implementation notes](./IMPLEMENTATION.md#re-indexing-vs-edits).

## Non-goals

Scope is frozen for v0 so the reference implementation stays small enough to read in one sitting:

- **No UI builder.** Applications consume the ontology; they are not part of it.
- **No pipeline framework.** Integration is a prerequisite; the demo uses plain SQL.
- **No indexing infrastructure.** Naive queries are fine at demo scale; scale is a property of implementations, not of the pattern. Result sets are unbounded in v0.
- **No federation.** One ontology is one bounded context. Who owns the model when there are several is a real question, and unaddressed in v0, like schema evolution.
- **No link properties or composite keys (yet).** The demo's order-line quantities deliberately stay in the data layer; whether they become a first-class `OrderLine` or properties on the link is a decision for the next version.
- **No OWL/RDF.** Academic ontologies are semantic-only — no actions. A different tool for a different job.
- **No general authorization system.** The pattern-level part is here: identity flows through every call (the audit log's administrative view is the declared exception) and visibility attaches to the model. The mechanism — groups, attributes, policy languages, cell-level security, propagation — is a policy engine's job.
- **No npm package.** Fork it; don't depend on it.
- **Not a Foundry alternative.** Foundry implements all three layers, vertically integrated; this repository names and demonstrates the middle one.

## Prior art

- **Palantir Foundry Ontology** — the implementation this pattern was distilled from, including its [semantic/kinetic vocabulary](https://www.palantir.com/docs/foundry/ontology/overview), [action types](https://www.palantir.com/docs/foundry/action-types/overview), [write-back webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks), and Ontology MCP. This repository describes the pattern independently of any vendor.
- **DDD, CQRS, event sourcing** — the parts are deliberately old: entities, aggregates, commands, guarded state transitions, append-only logs. What is new is the placement: the domain layer lifted out of a single application, put on top of other systems' data, and shared by many applications and agents.
- **Semantic layers** (dbt, Cube, AtScale, …) and **knowledge graphs / OWL / RDF** — governed reads without governed writes; the adjacent categories this pattern is defined against.
- **"Operational ontology"** — the phrase itself has prior use. Academic ontology engineering has used it with unrelated meanings, and Vladimir Kozlov's 2025 LinkedIn essays ([a definition](https://www.linkedin.com/pulse/operational-ontology-semantic-interface-between-data-action-kozlov-njnle), [a Foundry walkthrough](https://www.linkedin.com/pulse/understanding-palantirs-operational-ontology-beginners-kozlov-d0vse)) applied it to the same lineage described here: Foundry-style models that carry actions, not just semantics. What this repository adds is a testable boundary — the four properties, write-back and audit included — and a reference implementation of it.

## FAQ

**Isn't this just CRUD with validation?** The parts are familiar; the configuration is not. CRUD validation lives inside one application, on tables that application owns. Here the model sits on data other systems own, is shared by every consumer (UIs, scripts, agents), closes every write path except actions, audits every attempt, and writes accepted changes back to the systems of record. The closest existing description is a CQRS command layer extracted from the application and placed over someone else's data.

**Isn't a knowledge graph writable too?** Yes. SPARQL UPDATE can set `status = 'cancelled'`, and a `WHERE` clause or a SHACL shape can make it conditional. What a triple store does not provide as one first-class unit is the rest of the contract: a named business operation, a machine-readable refusal, an audit trail of attempts, and write-back to the system of record. The difference is not capability — all of this can be built on a triple store — but what comes named, governed, and first-class out of the model.

**Why not OWL/RDF?** Those model what things *are* (semantic). Half of this pattern is what you can *do* (kinetic): actions, preconditions, audit, write-back. A reasoner cannot cancel an order.

**Why TypeScript definitions instead of YAML?** Because business rules are code, and rule-expression languages embedded in YAML tend to grow into ad-hoc rule engines. TypeScript object literals keep the model enumerable while the rules stay ordinary typed code. (The typing covers the language, not yet the model's own schema — see [Status](#status).) Structure as data, rules as functions — the same split Foundry makes between Ontology Manager and Functions.

**What about transactions and rollback?** Three domains, three answers. Dataset versioning and rollback belong to the data layer (in Foundry: catalog transactions and branching). Atomic application of an action's edits belongs to this layer (implemented here as a real SQLite transaction). The consistency mechanism for cross-system write-back is implementation-defined; the pattern requires it to be declared, and this implementation declares write-back-first ordering (see [Failure semantics](#failure-semantics)).

**What about permissions and security?** Three different things hide in that question:

- **Authentication** is outside the pattern: an identity arrives already established. Here `actor` is a self-declared string — this implementation demonstrates placement, not protection.
- **Authorization**: its *placement* is part of the pattern — policies attach to object types and actions and bind every consumer's reads and writes, the way Foundry counts dynamic security among the Ontology's kinetic elements. Its *mechanism* (groups, attributes, policy languages, cell-level security, propagation) is implementation-defined.
- **Preconditions** are neither: they are validity, not permission.

The distinction matters to agents, which recover differently from each:

- **visibility** — you can't see it
- **permission** — you can't do it
- **precondition** — nobody can

(Foundry blends permission and validity in its action submission criteria and still conforms; the separation is a recommendation, not a requirement.)

Two design choices follow. `preconditions` is a required key, and an empty list is an explicit decision: gated writes are the core of the pattern, so "no conditions" must be stated, not defaulted. `visibility` is an optional key, because whether authorization exists at all is implementation-defined; an object without a policy is visible to everyone (**fail-open**). A reference implementation without authentication cannot be meaningfully fail-closed, so it does not pretend to be. Foundry's baseline is the opposite — discretionary grants expand access from zero, and mandatory markings deny on top. A fail-closed deployment starts by making `visibility` required, and also needs real authentication, action permissions, and scoped audit access underneath. One more declared surface: the audit log read API is unscoped — an administrative view where visibility filtering does not apply.

**What about Foundry's Functions and derived properties?** Foundry counts three kinetic elements: actions, functions, dynamic security. Function-backed actions are already inside this pattern — preconditions and effects are ordinary code that describes changes; effects return an edit plan and perform nothing themselves, and side effects belong to the adapter. Read-time computation — derived properties, query functions — is deliberately outside: the pattern's distinguishing half is governed writes, not computed reads. Dynamic security is the permissions story above.

**What if an agent retries?** This implementation has no idempotency keys. A retried `cancelOrder` is refused by its own precondition (`ORDER_ALREADY_CANCELLED`) — natural idempotency via the rules, not a guarantee — and a retry that interleaves with write-back can double-apply the side effect at the source. If your actions are not naturally idempotent, an invocation id in the params (audited like everything else) is the minimal starting point: it buys correlation, and actual deduplication needs a uniqueness check on that id. Idempotency is implementation-defined, and worth declaring, because agents do retry.

**How does the ontology itself change?** Schema evolution — new object types, changed properties, retired links — is real and out of scope here, like federation. Foundry has versioning and proposal machinery for it, and the academic field studies it as *ontology evolution*. What this repository contributes is the precondition for evolving safely: the model is a plain value, so it can be diffed, versioned, and reviewed like any other code. Domain modeling is not a one-shot step; the model keeps being re-fit to the business.

**Bring your own frontend?** Yes. The application contract is two kinds of calls — queries (`search`/`get`/`traverse`/`aggregate`) and `execute(action)` — the same for humans and agents, and every call is made as an actor. A dashboard uses the first; a "cancel" button uses the second. Rules follow the model, not the frontend.

## Status

v0.2 — reference implementation. This version removed mechanisms that enforced vows beyond the four properties — canonical-form storage checks, foreign-transaction detection, targetless actions, property-mirrored links, deletes — and replaced them with declared contracts, keeping the runtime readable in one sitting. Nothing in the four properties was lost.

Current limitations, which are also the worklist for the next version:

- A plan that changes both source-backed and ontology-owned state is refused whole; per-edit routing is future work.
- Creation is limited to ontology-owned types; source-backed creation carried by write-back is not demonstrated yet.
- No deletes.
- No link properties or composite keys.
- Rule contexts are not fully typed.
- Nested properties are not validated strictly.

The mechanics behind this implementation's declarations are in the [implementation notes](./IMPLEMENTATION.md). Built and verified with Node 24, better-sqlite3, zod 4, MCP SDK 1.29.

MIT © gura105
