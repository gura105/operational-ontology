**English** | [日本語](./README.ja.md)

# Operational Ontology

[![CI](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml/badge.svg)](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **An operational ontology is a shared domain model built on top of the data of systems you don't own — objects, links, and actions — where reads traverse the model and writes are gated by actions that carry business rules, are audited, and propagate back to the systems of record that own the state they change.**
>
> A semantic layer lets you *read* your business. An operational ontology lets you *run* it.

Palantir Foundry's Ontology is one implementation of this pattern. This repository is another: a minimal, readable reference implementation — the concept, minimized. It is a working definition, not a framework. Read it, fork it, steal the ideas.

## Why another word?

Because "ontology" is doing too many jobs. Philosophy uses it for the study of what exists. OWL/RDF use it for formal, machine-reasonable semantics. Knowledge graphs borrowed it for entity-relationship graphs. And in 2026 the major data platforms arrived, shipping "ontology"-branded context layers that ground AI answers in business meaning — genuinely useful, and read-side all the way. Five meanings, one word, and conversations about "the ontology" quietly fail.

| called an "ontology" | what it is | governed writes? |
| --- | --- | --- |
| philosophical ontology | the study of what exists | — |
| formal ontology (OWL / RDF) | machine-reasonable semantics | no |
| knowledge graph | entities and relationships — writable as data, not as operations | no |
| AI context layer (the 2026 wave of "ontology"-branded platform features) | semantic grounding for AI answers | no |
| **operational ontology (Foundry-style)** | business domain schema **+ rule-carrying actions** | **yes** |

Every row is a legitimate tool, and this table is not a ranking. But the one property that changes what a layer can *do* — whether it accepts writes, governed by business rules — cuts across the whole table and had no name. This repository gives it one.

## The four properties

A system implements the pattern when all four hold. They say *what* must be true, never *how* — outbox or webhook, SQL or search index, one store or many: mechanisms are implementation choices. This is a shared vocabulary for arguing about systems, not a certification to pass.

1. **Semantic objects and links.** Business entities and their relationships are modeled explicitly, on top of physical data that existed first — data other systems own.

2. **Action-gated writes.** State in this layer moves for three reasons: the sources changed and re-indexing reflects it; the model evolved under review; the business decided something. This property governs the third: a business decision changes state only through a named action, with no generic update path for a user, an application, or an agent. The other two are not loopholes — re-indexing is the sources speaking, schema evolution changes what can be said — and neither may smuggle a decision past the actions: a write that picks a business outcome is a decision, whatever the endpoint is named.

3. **Business rules at the action.** Preconditions are domain invariants ("a shipped order cannot be cancelled"), refused with machine-readable errors — not access control, and not UI validation. Every attempt, applied or refused, lands in the audit log.

4. **Write-back to systems of record.** Every write has a declared home, and the model says which. A **source-backed** change touches state an upstream system owns — an order's status, mastered in the ERP — and propagates back to that source as a governed, ordered side effect: truth stays where it always was. An **ontology-owned** change records what no source system has a column for — an assignee, a triage note — and for that state the ontology's own store *is* the system of record, declared rather than accidental. (**Derived** state — aggregates, counts — is computed and never written.) What the property forbids is the unlabeled middle: a shadow copy of another system's truth that never makes it home, a write whose home nobody can name. An implementation with no source-backed writes at all is not a smaller version of this pattern — it is an application with its own database, wearing the vocabulary.

The litmus question: **"Can you cancel an order from your semantic layer?"** If the answer is no, you have a read layer — useful, but a different thing. If the answer is yes but no row in any system of record ever changes, you have a parallel database — also a different thing. And if it cancels already-shipped orders without complaint, you have a write API — the third property is the whole difference.

### What an implementation declares

The pattern is agnostic about mechanisms; it is not agnostic about silence. These choices vary between implementations in ways users can observe, so an implementation states its answers — this repository's are one worked example. (The [Failure semantics](#failure-semantics) section unpacks the second: freshness, concurrency, and the audit surface are its sub-answers.)

- **Authority** — which changes are source-backed, which ontology-owned, which state is derived. *Here the model answers twice, and the runtime holds the answers together: `owned` declarations mark state the ontology itself owns — a property (`Order.assignee`), a link type, or a whole object type (`Note`) — and `writeback: true` on an action declares its changes source-backed. The declaration is checked, not trusted: every edit plan is classified against the `owned` declarations, and a plan on the wrong side of its action's declaration — or straddling the line — is refused (`UNDECLARED_SOURCE_WRITE`, `MIXED_AUTHORITY`). Foundry answers with per-action write-back webhooks, edit-only properties, and a declared conflict-resolution strategy.*
- **Failure semantics** — what happens when write-back and the local commit disagree. *Here: write-back runs first; if the source refuses, nothing changes here — see [Failure semantics](#failure-semantics).*
- **Re-indexing vs edits** — whether ontology-owned state survives a refresh of the base. *Here: it does — Foundry's shape, minimized: edits to ontology-owned properties live in an overlay that `load()` reapplies over the fresh base, and ontology-owned types and links are simply out of a snapshot's reach. A re-index that would orphan an edit is refused whole — see [Failure semantics](#failure-semantics).*
- **Visibility default** — what an object with no policy falls back to. *Here: fail-open — see the [FAQ](#faq).*

Answer these differently from this repository and you are still inside the pattern — the answers are the argument worth having. If a product calls itself an operational ontology, don't ask for a certificate; ask for its answers.

## Quickstart

```sh
pnpm install
pnpm demo    # physical data → integrate → index → read → write → refusal → write-back
pnpm test    # the behavior, as executable tests
```

The demo takes the scenario from the [article this repository accompanies](https://x.com/gura105/status/2077153028982133080) (in Japanese): a company acquires a competitor and inherits **two legacy order systems with different schemas and status encodings**. A few dozen lines of SQL plus a small TypeScript mapping integrate them; the ontology models `Customer`, `Order`, `Product` — and `Note`, a type no source system has a table for — on top; and then:

- a link traversal answers "which orders contain this product?" across both systems
- `assignOrder` writes state that exists in *no* legacy system — edits live above the sources
- `cancelOrder` on a shipped order is **refused** with `SHIPPED_ORDER_CANNOT_BE_CANCELLED`
- `cancelOrder` on an open order succeeds and the row in the legacy ERP **actually changes**
- the pipeline **re-indexes** the live legacy systems: source-backed state refreshes from the ERP, and the assignment and notes — ontology-owned — **survive**
- every attempt — applied and rejected — is in the audit log

## For AI agents (MCP)

```sh
pnpm mcp     # serve the same ontology to agents over stdio
```

Over stdio every caller collapses to one identity; `OO_AGENT=<name> pnpm mcp` names the agent this server serves. That is labeling, not authentication.

The MCP tool surface is *generated from the model*: `search_order`, `traverse_customer_orders`, `cancel_order`, `read_audit_log`, … one tool per query shape and per action. Two things are worth noticing:

- **There is intentionally no raw SQL tool.** The operation space an agent gets is exactly the operation space the model defines. The absence is the point.
- **The same precondition that gates a human gates the agent.** When the agent tries to cancel a shipped order it receives `{ "error": { "code": "SHIPPED_ORDER_CANNOT_BE_CANCELLED", … } }` — a machine-readable refusal it can read, recover from, and explain to its user.

Reads are scoped the same way: every query — except the audit log, a declared unscoped administrative view — runs *as* an actor, and model-attached visibility policies decide which objects that actor's world contains, the agent session included.

**The business rule lives in the ontology, not in the prompt.**

| approach | reads | writes | rules enforced by |
| --- | --- | --- | --- |
| raw DB access (SQL tool / DB MCP) | tables | unrestricted `UPDATE` | hope, and the prompt |
| semantic layer / metrics MCP | governed metrics | — | n/a (read-only) |
| API wrapper tools | endpoints | per-endpoint | each backend, inconsistently |
| **operational ontology** | objects, links, aggregates | **named actions only** | **preconditions in the model, audited** |

## The pattern

Five concepts — objects, links, actions, edits, and the audit log — defined as data and interpreted by a runtime (`src/core.ts`):

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

The definition is a plain value — enumerable, diffable, versionable. That is what makes the MCP surface derivable and the write path closed: `Runtime.execute()` is the only public *operational* write path — `load()` re-indexes the sources: replay, not decision, an infrastructure boundary rather than a user API — and it always runs *validate → preconditions → effects → validate the edit plan (model checks, the authority line, and a dry run of the commit) → write-back → atomic commit of edits + audit entry*.

Reads carry identity too: every `search` / `get` / `traverse` / `aggregate` runs as an `actor`, and an object type may attach a `visibility` predicate — row-level security in its minimal form, living in the model like everything else. A hidden object is indistinguishable from a nonexistent one, for reads and for action targets alike.

Edits are data too: `modify`, `create`, `delete` — and `link` / `unlink`, so actions can rewire the instance graph, not just node properties. The link *types* are part of the model and don't change here; which links exist between which objects is state, and business state only changes through actions — cardinality included: the runtime refuses a `link` that would give an order two customers. "Reassign this order to another customer" is an unlink, a link, and a modify, applied atomically under the same preconditions as everything else. Deletes are restricted: an object with links still attached refuses to die — unlink first. Creation needs no pre-existing subject: an action may be *targetless* — no target object, hence no visibility gate (there is nothing whose existence could leak), with its params, preconditions, and edit plan validated like everyone else's. One declared v0 limit: creation is for ontology-owned types only — creating a row *at the source* is real (write-back can carry it) but undemonstrated here, so it is refused rather than half-supported. (Changing the model itself — new object types, new link types — is schema evolution; see the FAQ.)

The model being data rather than classes is not an aesthetic choice. `class Order { cancel() {} }` cannot be enumerated into agent tools, shared across applications, or inspected at runtime without bolting a reflection layer on top — and its signature tells you nothing about its preconditions. It is an application's private domain layer. The whole point here is that the domain layer stops being private.

## Where this sits

Three layers. This repository implements the middle one only.

```
┌───────────────────────────────────────────────────────────┐
│  applications         Workshop / OSDK in Foundry           │
│                       → here: the CLI demo + MCP agents    │
├───────────────────────────────────────────────────────────┤
│  OPERATIONAL ONTOLOGY objects · links · actions · audit    │  ← this repo
│                       owns its own store (edits live here) │
├───────────────────────────────────────────────────────────┤
│  data layer           pipelines, dataset versioning,       │
│                       indexing infra (Funnel/OSv2 in       │
│                       Foundry) → here: fixtures + raw SQL  │
└───────────────────────────────────────────────────────────┘
```

**Upstream contract:** integrated physical data is *given*. Pipelines, dataset transactions, and rollback belong to your data platform.

**Downstream contract:** write-back is a governed **side effect**, not a distributed transaction (see below).

One consequence is worth stating because it separates this pattern from query-side layers: **a layer that only answers queries can stay virtual; a layer that accepts writes must own state.** Edits exist here before — or instead of — the systems of record (`assignOrder` writes state no legacy system has a column for — ontology-owned state, in the vocabulary of the fourth property), so the ontology keeps its own store and its own audit log. What this repo does *not* own: the indexing machinery that makes reads fast at enterprise scale (incremental indexing, adjacency indexes, search backends). That is how Foundry serves billions of objects; it is an implementation of the layer, not part of the pattern.

## Failure semantics

**At the pattern level.** Operational Ontology does not prescribe a consistency *mechanism* between the ontology and the systems of record — a distributed transaction, an ordering contract, an outbox, a reconciliation job are all implementation choices, the same way an inverted index is an implementation choice for link traversal. One asymmetry, though: an index is invisible to the contract, while failure semantics are observable — users can watch systems diverge. So the pattern does require one thing here: **an implementation must declare its failure semantics.** Divergence you can reason about is an engineering problem; divergence you discover in production is an incident. If someone tells you their ontology product does distributed transactions against SAP, ask to see the declaration.

**What this implementation declares.** It adopts the ordering of Foundry's write-back webhooks (one of Foundry's two modes — the other runs side effects *after* the edit): the `WritebackAdapter` runs before the local commit, so if the system of record refuses, nothing changes in the ontology. The reverse failure — adapter succeeded, local commit failed — remains possible; [Palantir's webhook documentation](https://www.palantir.com/docs/foundry/action-types/webhooks) acknowledges the same gap in Foundry's write-back mode. When it happens, the systems have diverged and reconciliation is on you.

Three sub-declarations sharpen that boundary. First, nothing invalid crosses it: before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back — a dry run of the commit, by the commit's own code — so every violation the ontology store could raise (schemas, cardinality, delete restrictions, link endpoints) is refused *before* anything reaches a system of record, and the only divergence left is the declared reverse failure. Second, the audit log carries the reconciliation material: a `WRITEBACK_FAILED` refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing; source-side atomicity is the adapter's contract, not this runtime's — and the reverse failure is audited as `COMMIT_FAILED`, plan included. Third, the honest limit of "every attempt is audited": it means every attempt this runtime observed to completion. A process death between the source update and the local commit loses both the edit and its audit entry; closing that window takes a persisted pending-invocation record, which v0 does not have.

Within its own store, the runtime is honestly transactional: an action's edits and its audit entry commit atomically (single SQLite transaction), and rejected attempts are logged too.

**Preconditions and freshness.** Preconditions are evaluated against the ontology store — the last indexed snapshot plus applied edits. The runtime's write-back step does not itself re-verify invariants at the source: if a source system can change behind the ontology's back, the invariant holds against the ontology's view of the world. Narrowing that gap is the adapter's choice — conditional write-backs, compare-and-set, re-verification in the system of record — and the demo adapter makes it: a guarded `UPDATE` that lets the ERP refuse a stale cancellation.

**Concurrent edits.** How simultaneous actions compose is implementation-defined — locks, versions, optimistic concurrency — and must be declared like everything else here. This implementation is a synchronous single-writer: actions execute one at a time, serialized by the runtime. The `WritebackAdapter` interface is synchronous for the same reason; a real networked write-back breaks that serialization, and an implementation that goes there must say what replaces it.

**Re-indexing vs edits.** The ontology store holds two kinds of state: the base indexed from the sources, and the edits actions have made on top. Source systems keep running, so every implementation of this pattern must decide what happens when re-indexing meets edits. Foundry keeps edits in their own layer and reapplies them over the freshly indexed base; this implementation does the same, minimized, with the authority declarations driving it. A snapshot speaks only for source-backed state: a row that supplies an ontology-owned property is refused, as are rows of ontology-owned types and instances of ontology-owned links — the source has no authority over any of them. Ontology-owned properties are reapplied from the overlay onto the fresh base; ontology-owned types and links survive untouched, being out of a snapshot's reach entirely. Conflicts refuse the whole load and leave the previous state standing: a base row that disappears while still carrying ontology-owned edits is a reconciliation decision, and the runtime does not make reconciliation decisions silently — clear the edit or restore the row, then re-load. (Clearing the edit is itself an action, so even reconciliation stays inside the write gate.) A partial snapshot has the same outcome: if surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.

## Non-goals

Scope is frozen for v0 by design. This is a reference implementation — the companion code to a definition — and it stays readable by refusing to grow:

- **No UI builder.** Applications are consumers of the ontology, not part of it.
- **No pipeline framework.** Integration is a prerequisite; the demo uses plain SQL.
- **No indexing infrastructure.** Naive queries are fine at demo scale; scale is a property of implementations, not of the pattern. Result sets are unbounded in v0.
- **One ontology = one bounded context.** Federation — who owns the model when there are several — is real and unaddressed in v0, like schema evolution.
- **No link properties or composite keys (yet).** The demo's order-line quantities deliberately stay in the data layer; whether they become a first-class `OrderLine` or properties on the link is a v0.2 decision.
- **No OWL/RDF.** Academic ontologies are semantic-only — no actions, no kinetics. Different tool for a different job.
- **No general authorization system.** The pattern-level part is here — identity flows through every call (the audit log's administrative view is the declared exception), and visibility attaches to the model. The mechanism (groups, attributes, policy languages, cell-level security, propagation) is a policy engine's job.
- **No npm package.** Fork it; don't depend on it.
- **Not a Foundry alternative.** Foundry is one implementation of this pattern, vertically integrated across all three layers. This repo names and demonstrates the middle layer.

## Prior art

- **Palantir Foundry Ontology** — the implementation this pattern was reverse-engineered from, including its [semantic/kinetic vocabulary](https://www.palantir.com/docs/foundry/ontology/overview), [action types](https://www.palantir.com/docs/foundry/action-types/overview), [write-back webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks), and Ontology MCP. That Palantir ships an agent-facing ontology surface is evidence the category is real, not proof it is theirs alone.
- **DDD, CQRS, event sourcing** — the parts are old, deliberately. Entities, aggregates, commands, guarded state transitions, append-only logs. What is new is the placement: the domain layer lifted out of a single application and put on top of *other systems'* data, shared by many applications and agents.
- **Semantic layers** (dbt, Cube, AtScale, …) and **knowledge graphs / OWL / RDF** — governed reads, no governed writes. The adjacent categories this pattern is defined against.
- **"Operational ontology"** has scattered prior use in academic ontology engineering with different meanings; this repository uses it strictly in the sense defined at the top.

## FAQ

**Isn't this just CRUD with validation?** The parts are familiar; the configuration isn't. CRUD validation lives inside one application, on tables that application owns. Here the model sits on data *other systems* own, is shared by every consumer (UIs, scripts, agents), closes all write paths except actions, audits every attempt, and pushes accepted changes back to the systems of record. It is closer to "a CQRS command layer extracted from the application and placed over someone else's data."

**Isn't a knowledge graph writable too?** Yes — SPARQL UPDATE will happily set `status = 'cancelled'`, and with a `WHERE` clause or a SHACL shape you can even make it conditional. What the stack does not hand you is the rest of the contract as one first-class unit: a named business operation, a machine-readable refusal, an audit trail of attempts, write-back to the system of record. The difference is not capability — you can build all of this on a triple store — it is what comes named, governed, and first-class out of the model.

**Why not OWL/RDF?** Those model what things *are* (semantic). This pattern's distinguishing half is what you can *do* (kinetic): actions, preconditions, audit, write-back. A reasoner cannot cancel an order.

**Why TypeScript definitions instead of YAML?** Business rules are code — a YAML rules-expression-language is how toy rule engines are born. TS object literals keep the model enumerable *and* the rules in ordinary typed code — typed against the language, not yet against the model's own schema, a v0 limitation. Structure as data, rules as functions — the same split Foundry makes between Ontology Manager and Functions.

**What about transactions and rollback?** Three different domains, three different answers: dataset versioning/rollback is the data layer's job (in Foundry: catalog transactions and branching); atomic application of an action's edits is this layer's job (implemented here as a real SQLite transaction); and the consistency mechanism for cross-system write-back is implementation-defined — the pattern requires it to be *declared*, not assumed. This implementation declares write-back-first ordering; see [Failure semantics](#failure-semantics).

**What about permissions and security?** Three different things hide in that question, and they split along the same line as everything else in this repository. *Authentication* is outside the pattern: an identity arrives already established. (Here, `actor` is a self-declared string — this implementation demonstrates *placement*, not protection.) *Authorization*'s **placement** is part of the pattern — Foundry counts dynamic security among the Ontology's kinetic elements, and policies attach to object types and actions, binding every consumer's reads and writes alike — while its **mechanism** (groups, attributes, policy languages, cell-level security, propagation from the data layer) is implementation-defined. And *preconditions* are neither: they are validity, not permission. The vocabulary worth keeping:

- **visibility** — you can't see it
- **permission** — you can't do it (*not you*)
- **precondition** — nobody can (*not ever*)

Agents recover differently from each, which is why this implementation keeps them distinct; Foundry blends permission and validity in its action submission criteria and conforms all the same — the separation is a recommendation, not a requirement.

Two declared design choices follow. First, the slots: `preconditions` is a required key where an empty list is a stated decision, because gated writes are pattern core; `visibility` is an optional key, because authorization's *existence* is implementation-defined. Second, the polarity — defaults must be declared, like failure semantics: this implementation is **fail-open** (no `visibility` means visible to everyone). A reference implementation without authentication cannot be meaningfully fail-closed; pretending otherwise would be security theater. Foundry's baseline is the opposite — discretionary grants expand access from zero, and mandatory markings deny conjunctively on top. A fail-closed deployment starts — but does not end — with flipping the `visibility` slot from optional to required: it also needs real authentication, action permissions, and scoped audit access underneath. One more declared surface here: the audit log read API is unscoped — an administrative view where visibility filtering does not apply, fail-open like the rest.

**What about Foundry's Functions and derived properties?** Foundry counts three kinetic elements: actions, functions, dynamic security. Function-*backed* actions are already inside this pattern — preconditions and effects are ordinary code that *describes* changes: effects return an edit plan and perform nothing themselves, side effects belong to the adapter. The same split (structure as data, rules as functions). Read-time computation — derived properties, query functions — is deliberately outside: the pattern's distinguishing half is governed *writes*, not computed *reads*. Dynamic security is the permissions story above.

**What if an agent retries?** Idempotency is implementation-defined — and worth declaring, because agents do retry. This implementation has no idempotency keys: a retried `cancelOrder` is refused by its own precondition (`ORDER_ALREADY_CANCELLED`) — natural idempotency by way of the rules, not a guarantee — and a retry that interleaves with write-back can double-apply the side effect at the source. If your actions are not naturally idempotent, an invocation id in the params — audited like everything else — is the minimal starting point: it buys you correlation; actual deduplication needs a uniqueness check on that id.

**How does the ontology itself change?** Schema evolution — new object types, changed properties, retired links — is real and out of scope here, like bounded contexts: Foundry has versioning and proposal machinery for it, and the academic field studies it as *ontology evolution*. What this repository contributes is the precondition for evolving safely: the model is a plain value, so it can be diffed, versioned, and reviewed like any other code. Reverse domain modeling is not a one-shot step; the model keeps being re-fit to the business.

**Bring your own frontend?** Yes. The application contract is two verbs — query (`search`/`get`/`traverse`/`aggregate`) and `execute(action)` — for humans and agents alike, and every call is made *as* an actor. A dashboard is the first verb; the "cancel" button is the second. Rules follow the model, not the frontend.

## Status

v0.1 — reference implementation. Scope is frozen for v0; the declared v0 simplifications — mixed-authority plans (refused whole; per-edit routing), source-backed creation, link properties and composite keys, typed rule contexts, nested-property strictness — are the v0.2 worklist. Built and verified with Node 24, better-sqlite3, zod 4, MCP SDK 1.29.

MIT © gura105
