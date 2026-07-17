**English** | [日本語](./README.ja.md)

# Operational Ontology

> **An operational ontology is a shared domain model built on top of the data of systems you don't own — objects, links, and actions — where reads traverse the model and writes are gated by actions that carry business rules, are audited, and propagate back to the systems of record.**
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

A system implements the pattern when all four hold:

1. **Semantic objects and links.** Business entities and their relationships are modeled explicitly, on top of physical data that existed first.
2. **Action-gated writes.** State changes only through named actions. There is no generic update path.
3. **Business rules at the action.** Preconditions are domain invariants ("a shipped order cannot be cancelled"), refused with machine-readable errors — not access control, and not UI validation.
4. **Write-back to systems of record.** Changes propagate to the source systems as governed, ordered side effects. Truth stays where it always was.

The litmus question: **"Can you cancel an order from your semantic layer?"** If the answer is no, you have a read layer — useful, but a different thing.

## Quickstart

```sh
pnpm install
pnpm demo    # physical data → integrate → index → read → write → refusal → write-back
pnpm test    # the specification, as executable tests
```

The demo takes the scenario from the article this repository accompanies: a company acquires a competitor and inherits **two legacy order systems with different schemas and status encodings**. A few dozen lines of plain SQL integrate them; the ontology models `Customer`, `Order`, `Product` on top; and then:

- a link traversal answers "which orders contain this product?" across both systems
- `assignOrder` writes state that exists in *no* legacy system — edits live above the sources
- `cancelOrder` on a shipped order is **refused** with `SHIPPED_ORDER_CANNOT_BE_CANCELLED`
- `cancelOrder` on an open order succeeds and the row in the legacy ERP **actually changes**
- every attempt — applied and rejected — is in the audit log

## For AI agents (MCP)

```sh
pnpm mcp     # serve the same ontology to agents over stdio
```

The MCP tool surface is *generated from the model*: `search_order`, `traverse_customer_orders`, `cancel_order`, `read_audit_log`, … one tool per query shape and per action. Two things are worth noticing:

- **There is intentionally no raw SQL tool.** The operation space an agent gets is exactly the operation space the model defines. The absence is the point.
- **The same precondition that gates a human gates the agent.** When the agent tries to cancel a shipped order it receives `{ "code": "SHIPPED_ORDER_CANNOT_BE_CANCELLED", ... }` — a machine-readable refusal it can read, recover from, and explain to its user.

Reads are scoped the same way: every query runs *as* an actor, and model-attached visibility policies decide which objects that actor's world contains — the agent session included.

**The business rule lives in the ontology, not in the prompt.**

| approach | reads | writes | rules enforced by |
| --- | --- | --- | --- |
| raw DB access (SQL tool / DB MCP) | tables | unrestricted `UPDATE` | hope, and the prompt |
| semantic layer / metrics MCP | governed metrics | — | n/a (read-only) |
| API wrapper tools | endpoints | per-endpoint | each backend, inconsistently |
| **operational ontology** | objects, links, aggregates | **named actions only** | **preconditions in the model, audited** |

## The pattern

Five concepts, defined as data and interpreted by a runtime (`src/core.ts`):

```ts
const ontology = defineOntology({
  objects: {
    Order: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), status: z.enum(['pending', 'shipped', 'cancelled']), total: z.number() },
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

The definition is a plain value — enumerable, serializable, diffable. That is what makes the MCP surface derivable and the write path closed: `Runtime.execute()` is the only public method that mutates state, and it always runs *validate → preconditions → effects → write-back → atomic commit of edits + audit entry*.

Reads carry identity too: every `search` / `get` / `traverse` / `aggregate` runs as an `actor`, and an object type may attach a `visibility` predicate — row-level security in its minimal form, living in the model like everything else. A hidden object is indistinguishable from a nonexistent one, for reads and for action targets alike.

Edits are data too: `modify`, `create`, `delete` — and `link` / `unlink`, so actions can rewire the instance graph, not just node properties. The link *types* are part of the model and don't change here; which links exist between which objects is state, and state only changes through actions — cardinality included: the runtime refuses a `link` that would give an order two customers. "Reassign this order to another customer" is an unlink, a link, and a modify, applied atomically under the same preconditions as everything else. (Changing the model itself — new object types, new link types — is schema evolution; see the FAQ.)

The model being data rather than classes is not an aesthetic choice. `class Order { cancel() {} }` cannot be enumerated into agent tools, shared across applications, or inspected at runtime — it is an application's private domain layer. The whole point here is that the domain layer stops being private.

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

One consequence is worth stating because it separates this pattern from query-side layers: **a layer that only answers queries can stay virtual; a layer that accepts writes must own state.** Edits exist here before — or instead of — the systems of record (`assignOrder` writes state no legacy system has a column for), so the ontology keeps its own store and its own audit log. What this repo does *not* own: the indexing machinery that makes reads fast at enterprise scale (incremental indexing, adjacency indexes, search backends). That is how Foundry serves billions of objects; it is an implementation of the layer, not part of the pattern.

## Failure semantics

**At the pattern level.** Operational Ontology does not prescribe a consistency *mechanism* between the ontology and the systems of record — a distributed transaction, an ordering contract, an outbox, a reconciliation job are all implementation choices, the same way an inverted index is an implementation choice for link traversal. One asymmetry, though: an index is invisible to the contract, while failure semantics are observable — users can watch systems diverge. So the pattern does require one thing here: **an implementation must declare its failure semantics.** Divergence you can reason about is an engineering problem; divergence you discover in production is an incident. If someone tells you their ontology product does distributed transactions against SAP, ask to see the declaration.

**What this implementation declares.** It adopts the ordering of Foundry's write-back webhooks (one of Foundry's two modes — the other runs side effects *after* the edit): the `WritebackAdapter` runs before the local commit, so if the system of record refuses, nothing changes in the ontology. The reverse failure — adapter succeeded, local commit failed — remains possible, and Palantir's own documentation acknowledges the same gap. When it happens, the systems have diverged and reconciliation is on you.

Within its own store, the runtime is honestly transactional: an action's edits and its audit entry commit atomically (single SQLite transaction), and rejected attempts are logged too.

**Re-indexing vs edits.** The ontology store holds two kinds of state: the base indexed from the sources, and the edits actions have made on top. Source systems keep running, so every implementation of this pattern must decide what happens when re-indexing meets edits. Foundry keeps edits in their own layer and reapplies them over the freshly indexed base; this implementation materializes a single row per object, so re-running `load()` overwrites edits — a v0 simplification, stated rather than hidden. If `assignOrder` state survives a re-index in your system, someone built that reconciliation on purpose.

## Non-goals

Scope is frozen by design. This is a reference implementation — the companion code to a definition — and it stays readable by refusing to grow:

- **No UI builder.** Applications are consumers of the ontology, not part of it.
- **No pipeline framework.** Integration is a prerequisite; the demo uses plain SQL.
- **No indexing infrastructure.** Naive queries are fine at demo scale; scale is a property of implementations, not of the pattern.
- **No OWL/RDF.** Academic ontologies are semantic-only — no actions, no kinetics. Different tool for a different job.
- **No general authorization system.** The pattern-level part is here — identity flows through every call, and visibility attaches to the model. The mechanism (groups, attributes, policy languages, cell-level security, propagation) is a policy engine's job.
- **No npm package.** Fork it; don't depend on it.
- **Not a Foundry alternative.** Foundry is one implementation of this pattern, vertically integrated across all three layers. This repo names and demonstrates the middle layer.

## Prior art

- **Palantir Foundry Ontology** — the implementation this pattern was reverse-engineered from, including its [semantic/kinetic vocabulary](https://www.palantir.com/docs/foundry/ontology/overview), [action types](https://www.palantir.com/docs/foundry/action-types/overview), [write-back webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks), and Ontology MCP. That Palantir ships an agent-facing ontology surface is evidence the category is real, not proof it is theirs alone.
- **DDD, CQRS, event sourcing** — the parts are old, deliberately. Entities, aggregates, commands, guarded state transitions, append-only logs. What is new is the placement: the domain layer lifted out of a single application and put on top of *other systems'* data, shared by many applications and agents.
- **Semantic layers** (dbt, Cube, AtScale, …) and **knowledge graphs / OWL / RDF** — governed reads, no governed writes. The adjacent categories this pattern is defined against.
- **"Operational ontology"** has scattered prior use in academic ontology engineering with different meanings; this repository uses it strictly in the sense defined at the top.

## FAQ

**Isn't this just CRUD with validation?** The parts are familiar; the configuration isn't. CRUD validation lives inside one application, on tables that application owns. Here the model sits on data *other systems* own, is shared by every consumer (UIs, scripts, agents), closes all write paths except actions, audits every attempt, and pushes accepted changes back to the systems of record. It is closer to "a CQRS command layer extracted from the application and placed over someone else's data."

**Isn't a knowledge graph writable too?** Yes — SPARQL UPDATE will happily set `status = 'cancelled'`. What it cannot do is *refuse* to, because the order already shipped. An update is a data edit; an operation carries preconditions, an audit trail, and write-back. The difference between this pattern and a knowledge graph is not whether the graph can change — it is whether changes are business operations or raw edits.

**Why not OWL/RDF?** Those model what things *are* (semantic). This pattern's distinguishing half is what you can *do* (kinetic): actions, preconditions, audit, write-back. A reasoner cannot cancel an order.

**Why TypeScript definitions instead of YAML?** Business rules are code — a YAML rules-expression-language is how toy rule engines are born. TS object literals keep the model enumerable *and* the rules type-checked. Structure as data, rules as functions — the same split Foundry makes between Ontology Manager and Functions.

**What about transactions and rollback?** Three different domains, three different answers: dataset versioning/rollback is the data layer's job (in Foundry: catalog transactions and branching); atomic application of an action's edits is this layer's job (implemented here as a real SQLite transaction); and the consistency mechanism for cross-system write-back is implementation-defined — the pattern requires it to be *declared*, not assumed. This implementation declares write-back-first ordering; see [Failure semantics](#failure-semantics).

**What about permissions and security?** Three different things hide in that question, and they split along the same line as everything else in this repository. *Authentication* is outside the pattern: an identity arrives already established. (Here, `actor` is a self-declared string — this implementation demonstrates *placement*, not protection.) *Authorization*'s **placement** is part of the pattern — Foundry counts dynamic security among the Ontology's kinetic elements, and policies attach to object types and actions, binding every consumer's reads and writes alike — while its **mechanism** (groups, attributes, policy languages, cell-level security, propagation from the data layer) is implementation-defined. And *preconditions* are neither: they are validity, not permission. The vocabulary worth keeping: **visibility** (you can't see it), **permission** (you can't do it — *not you*), **precondition** (nobody can — *not ever*). Agents recover differently from each, which is why this implementation keeps them distinct; Foundry blends permission and validity in its action submission criteria and conforms all the same — the separation is a recommendation, not a requirement.

Two declared design choices follow. First, the slots: `preconditions` is a required key where an empty list is a stated decision, because gated writes are pattern core; `visibility` is an optional key, because authorization's *existence* is implementation-defined. Second, the polarity — defaults must be declared, like failure semantics: this implementation is **fail-open** (no `visibility` means visible to everyone). A reference implementation without authentication cannot be meaningfully fail-closed; pretending otherwise would be security theater. Foundry's baseline is the opposite — discretionary grants expand access from zero, and mandatory markings deny conjunctively on top. A fail-closed deployment of this pattern is a one-knob change: make the `visibility` slot required instead of optional, on top of an authenticated identity layer.

**How does the ontology itself change?** Schema evolution — new object types, changed properties, retired links — is real and out of scope here, like bounded contexts: Foundry has versioning and proposal machinery for it, and the academic field studies it as *ontology evolution*. What this repository contributes is the precondition for evolving safely: the model is a plain value, so it can be diffed, versioned, and reviewed like any other code. Reverse domain modeling is not a one-shot step; the model keeps being re-fit to the business.

**Bring your own frontend?** Yes. The application contract is two verbs — query (`search`/`get`/`traverse`/`aggregate`) and `execute(action)` — for humans and agents alike, and every call is made *as* an actor. A dashboard is the first verb; the "cancel" button is the second. Rules follow the model, not the frontend.

## Status

v0.1 — reference implementation, scope frozen. Built and verified with Node 24, better-sqlite3, zod 4, MCP SDK 1.29.

MIT © gura105
