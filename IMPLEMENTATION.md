**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](./README.md) introduces the pattern, demo, and scope. This document describes this implementation's API and runtime behavior. The executable checks are in [`tests/`](./tests/), including runtime, type-level, and MCP tests.

An action refusal returns `{ ok: false, error: { code, message } }` and is audited. Programming and storage errors may throw; the write path records them as described below. Query errors are exceptions rather than action refusals.

## Instances and traversal

`model.ts` contains definitions and model-derived types; `core.ts` interprets them. Runtime object values are read snapshots shaped as `{ type, pk, properties }`. Identity is `(type, pk)`; `pk` comes from the declared primary key, even when that property is not named `id`. Business properties named `type`, `pk`, or `properties` remain nested without collisions. Mutating a snapshot does not write the store.

`get`, `search`, and `traverse` return instances. Visibility, predicate filters, aggregation callbacks, action contexts, and `meta.target` receive instances too. Equality filters, `modify` changes, `create` data, and indexing rows still use business properties directly. `defineAction(objects, …)` derives `ctx.object` from its `object` name and `ctx.params` from the parameter schema. `modify(instance, changes)` produces the existing edit data; it performs no write itself. `create`, `link`, and `unlink` retain their runtime-checked payloads.

With the orders example, either end of a link can be the source:

```ts
const hq = { actor: 'user:hq' }
const customer = rt.get('Customer', 'N-C01', hq)!
const orders = rt.traverse(customer, 'customerOrders', hq) // Order instances
const customers = rt.traverse(orders[0], 'customerOrders', hq) // Customer instances
console.log(orders[0].properties.status)
```

TypeScript derives object and action names, instance properties, action params, and `modify` changes from the model. Keep the inferred definition type: an explicit `OntologyDef` annotation erases its specific names and schemas. Runtime validation still applies.

`traverse(source, linkName, { actor, direction? })` accepts a full instance, with no primary-key-only or reference-only overload. The link definition determines direction.

In the editor, entering the source instance narrows link-name completions to links connected to its type. Choosing a link then narrows the available `direction` values. A single possible direction can be omitted; a same-type link requires a choice at type-checking time.

| Source type matches | Direction | Result type |
| --- | --- | --- |
| `from` only | `forward`, optional | `to` |
| `to` only | `reverse`, optional | `from` |
| Both ends | `forward` or `reverse`, required | The same object type |
| Neither end | Invalid link for this source | — |

For an `Employee → Employee` link defined from manager to subordinate, `forward` gets subordinates and `reverse` gets managers. Only the existing link name is needed; there are no directional aliases.

The rule depends on the declared types, not the stored edges. Results are always arrays, including for one-to-many reverse traversal. Return types depend on source and link; optional direction does not widen them. Narrow a union of source types using `type` before traversing when its ends differ. The instance is a snapshot, so traversal re-reads `(type, pk)` with the caller's actor, checks visibility at both ends, and returns an empty array for a missing or hidden source. It ignores the supplied properties for these checks. Invalid source shape, link, or direction throws.

MCP reads serialize the same shape. Traversal tools take `{ source: { type, pk, properties }, direction? }`, with direction required in the schema for same-type links. The generated schemas and runtime validate dynamic inputs; the MCP adapter contains the type assertion for this boundary. Typed application calls have no permissive overload for arbitrary strings. Stored rows and audit edit payloads keep their existing format.

## Visibility and caller identity

Every `get`, `search`, `traverse`, and `aggregate` call carries an `actor`. An object type's optional `visibility` predicate filters reads and action targets. A hidden object behaves like a missing one: `get` returns `undefined`, traversal returns no hidden rows, and `execute` refuses a hidden target with `TARGET_NOT_FOUND`.

Authentication establishes the actor's identity outside the runtime. When an implementation provides authorization, policies belong on object types and actions so every consumer is subject to the same constraints. That placement is a separate design choice from the mechanism used to implement it, such as groups, attributes, or a policy language. Preconditions check business validity. Separating permission from validity is recommended; implementing them as separate mechanisms is not a condition of the pattern.

This reference implementation demonstrates where model-attached policies live and how they act. How much authorization to provide is an implementation choice; here, `visibility` is optional and declared to default to fail-open: visible to everyone. The actor is a self-declared string; the runtime provides neither authentication nor a general action-permission system. Making visibility declarations mandatory alone cannot protect access based on verified user identities. Audit reads remain an unscoped administrative view, without visibility filtering.

Over MCP stdio, callers share one actor. `OO_AGENT=<name> pnpm mcp` labels it as `agent:<name>`; this is not authentication. The server generates read tools and action tools from the model and passes calls through the runtime. Action refusals become MCP errors containing `{ error: { code, message } }`; caught runtime exceptions use the `INTERNAL` code. For local store access, see [Transaction ownership](#transaction-ownership).

## Executing actions

An action definition must include `preconditions`, using `[]` when there are none. Because business rules at the action govern the write path, having no conditions must also be an explicit decision by the model's author.

`execute(actionName, params, { actor })` follows this order:

1. Validate params and load the target under the actor's visibility policy.
2. Evaluate preconditions.
3. Run the effects function to obtain an edit plan.
4. Dry-run the whole plan through the commit's own code, then roll it back.
5. Check the plan against the ownership declarations.
6. Write back a nonempty source-backed plan through the adapter.
7. Commit the local edits and audit entry in one transaction.

Effects describe changes as data and must be pure. `modify` changes properties, `create` creates an ontology-owned object, and `link` / `unlink` change relationships. The gate checks schemas, object existence, and cardinality before the adapter runs. A create-and-link action such as `addOrderNote` commits its local plan atomically. These edits change instances; model definitions are code reviewed and versioned in git.

## The authority line, checked

The model declares ownership in two places: `owned` on object types and links marks ontology-owned state, and `writeback: true` on an action marks its changes source-backed. The runtime classifies every edit plan against the `owned` declarations and refuses any plan that contradicts its action's declaration:

| the plan | action declares `writeback` | result |
| --- | --- | --- |
| changes source-backed state | no | refused: **`UNDECLARED_SOURCE_WRITE`** |
| changes only ontology-owned state | yes | refused: **`MISDECLARED_WRITEBACK`** |
| changes both kinds, within one edit or across edits | either | refused: **`MIXED_AUTHORITY`** |
| creates an object of a source-backed type | either | refused: **`SOURCE_CREATE_UNSUPPORTED`** |

The reasoning, row by row. An undeclared source write would be a local change to source-owned data that never reaches the source — exactly what property 4 forbids. A misdeclared write-back contains nothing that belongs to a source. A mixed plan is refused because this implementation routes plans whole, so an action must sit on one side of the line; split the action if it needs both. Per-edit routing is unsupported. Creating a row at the source is real — write-back could carry it — but this implementation does not demonstrate it, so it refuses rather than half-supports; creation is limited to ontology-owned types.

An empty plan touches neither side of the line: no adapter call, only the audit entry is committed. An action that declares write-back but has no adapter configured is refused with **`NO_WRITEBACK_ADAPTER`**.

Validity is checked before authority. The whole plan is dry-run through the commit's own code first, so a plan the store would refuse is **`INVALID_EDITS`** even if it also crosses the authority line.

The four declared answers themselves are enumerable at runtime as `Runtime.declarations`, pinned by a test.

## Failure semantics in detail

The declared ordering is write-back first: the adapter runs before the local commit. If the system of record refuses, nothing changes in the ontology. The remaining risk is the reverse failure — the adapter succeeded and the local commit failed — and when it happens, the systems have diverged. Three mechanisms bound that risk.

**Nothing invalid crosses the boundary.** Before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back: a dry run using the commit's own code, not a second validator that could drift out of sync. Every violation the store can detect — schema, cardinality, link endpoints — is refused before anything reaches a system of record. The adapter also receives its inputs up front, as its own copies: the validated plan, and the target object as the runtime loaded it (`meta.target`). It never needs to read the ontology store.

**The audit log records both failure directions.** A **`WRITEBACK_FAILED`** refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing, since source-side atomicity is the adapter's contract, not this runtime's. The reverse failure is audited as **`COMMIT_FAILED`**, plan included: after a write-back-first action, those edits are what already reached the source. Both entries are raw material for reconciliation.

**"Every attempt is audited" has a stated limit.** It covers every attempt this runtime observed to completion. If the process dies between the source update and the local commit, both the edit and its audit entry are lost. Closing that window would take a persisted pending-invocation record, which this implementation does not have.

A crash inside the write path is audited as **`EXECUTION_CRASHED`** — a storage fault, or model code (a visibility predicate, a precondition, an effects function) that threw. The error then propagates to the caller.

The audit write itself must not be a failure point. Params whose values would change when serialized to JSON and back are refused as **`INVALID_PARAMS`** before the model runs. Anything the log still cannot encode is recorded as a `$unserializable` placeholder: a lossy audit entry is better than a missing one.

The audit log sits outside the object graph because its contract differs from that of ordinary business objects. It records refusals and crashes that commit no business edits, retains a record using placeholders for values it cannot encode, and is appended to by the runtime without going through an action. Treating entries as ordinary objects would require exceptions to schema-based refusal and action-gated writes, so this implementation exposes them through a separate administrative view.

**Preconditions and freshness.** Rules see the indexed snapshot plus applied local edits. The source may have changed since indexing; the runtime does not re-check source invariants itself. The adapter must handle that boundary. The demo's [ERP adapter](./examples/orders/erp-adapter.ts) uses a guarded `UPDATE`, allowing the ERP to refuse a cancellation after an order has shipped.

**Concurrency.** Calls and the adapter interface are synchronous. The example assumes a single writer, so no other action interleaves between preflight and commit. An asynchronous adapter or multiple writers would require an explicit concurrency mechanism; neither is implemented here.

**Retries.** There are no idempotency keys or deduplication. `cancelOrder` refuses an already-cancelled order through its own precondition, but that does not guarantee every action or external side effect is safe to retry. A caller-supplied note ID can prevent duplicate local creation; it is not a general retry protocol.

An action instance is identified by its occurrence, not its arguments. Two calls with the same params are separate attempts, each subject to auditing. Adding an invocation ID to params can correlate attempts, but deduplication also requires deciding how checking and recording that ID coordinates with executing side effects. Recording the ID in the log alone does not prevent duplicate execution.

## Transaction ownership

Rollback has three areas of responsibility. Source dataset versioning and rollback belong to the data platform. This runtime applies an action's local edits and audit entry in one SQLite transaction. Consistency across write-back to external systems is a separate design concern: a local rollback cannot undo changes already delivered to a source. This implementation declares its ordering and failure behavior in the [preceding section](#failure-semantics-in-detail).

One rule is enforced: callers cannot wrap the runtime. `execute()` and `load()` refuse to run inside a caller-opened transaction, because inside one, "committed" would really mean "until the caller rolls the savepoint back" — an applied-and-audited action could be undone after the runtime reported success. This is an atomicity guarantee, not an intrusion defense.

The rest of the boundary is declared, not defended. The runtime is an in-process library: any code that holds the database handle — the caller, a rule, the write-back adapter — can bypass the action gate with a direct `UPDATE`, and no in-process check can prevent that. The contract is therefore: rules and the adapter must not touch the ontology store. The adapter has no reason to — it receives its own copies of the edit plan and the target object, and speaks only to the systems of record.

An earlier version detected one observable slice of violations — a transaction left open on the store — and v0.2 removed the detector: a check that catches one intrusion shape but misses the simplest one (a direct autocommit `UPDATE`) looks like a defense without being one. A deployment that needs an enforced boundary should put the runtime behind a process boundary, with no direct database access for consumers. The bundled MCP server is exactly that shape.

## The storable boundary

The store keeps JSON, so every stored value must survive JSON serialization and deserialization unchanged. A row containing a value that would come back changed or dropped — a class instance, a `Date`, `NaN`, a `Map`, `undefined` at any depth — is refused at every write, whether it arrives through an action or through `load()`. The same check applies to a declared default for an `owned` property (at definition time) and to action params (at the entry point; see the audit note above).

One obligation is declared rather than checked: property schemas must validate, not transform. The runtime feeds stored values back through the same schema on later writes, so a transforming schema (`z.coerce.date()`, `.transform(…)`) would refuse or silently rewrite its own output on the next pass. An earlier version enforced this with a per-write fixed-point check (validate, re-validate the output, require identity); v0.2 states it as the model author's contract instead.

## Re-indexing vs edits

Snapshot semantics, per loaded type: replace the base, reapply the edit layer. The rules, each stated as its outcome:

- **Refused: a snapshot row that supplies ontology-owned state.** Rows that set ontology-owned properties, rows of ontology-owned types, and instances of ontology-owned links are all refused — the source owns none of them.
- **Kept: edits to ontology-owned properties.** They live in an overlay keyed by (type, pk); after a re-index, the overlay's current patch is reapplied over the fresh base. An edit set back to its declared default is removed from the overlay — clearing an edit also clears the obligation to preserve it. (The comparison is structural, so key order cannot fake or hide "back at default".)
- **Kept in place: ontology-owned types and links.** `load()` refuses to touch them, so they need no overlay.
- **Refused whole: a load that would orphan an edit.** If a base row disappears while it still carries ontology-owned edits, the entire load is refused and the previous state stands. What happens to that state is a reconciliation decision, and the runtime does not make reconciliation decisions silently: clear the edit or restore the row, then re-load. Clearing the edit is itself an action, so even reconciliation stays inside the write gate.
- **Refused: an overlay key the model no longer owns.** If the model stops declaring a property ontology-owned while an overlay patch still carries it, the load is refused — that state's fate belongs to explicit schema evolution, not to a refresh.
- **Refused: a partial snapshot that breaks constraints.** If surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.

## Current limits

These limits describe the current implementation:

- An edit plan cannot mix source-backed and ontology-owned changes; creation is limited to ontology-owned types, as shown in the [authority checks](#the-authority-line-checked).
- There are no deletes, link properties, or composite keys. The demo leaves order-line quantities in the data layer.
- `create`, `link`, and `unlink` payloads are checked at runtime; their TypeScript types are not derived from the model. Nested properties follow their Zod schemas and are not made strict by the runtime.
- Queries use the local SQLite snapshot, with no pagination or result cap. Object sets, pivot, federation, and runtime schema evolution are outside the implemented API. The audit log is a separate administrative view rather than an object in the graph.

The API has changed since v0.3: object reads and `meta.target` use `{ type, pk, properties }`; traversal takes an instance first; actions use `defineAction(objects, definition)`; modifications use `modify(instance, changes)`. Stored rows and audit edit payloads retain their earlier format. Published versions are in the [release notes](https://github.com/gura105/operational-ontology/releases).
