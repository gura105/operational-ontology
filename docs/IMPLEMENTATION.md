**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](../README.md) introduces the pattern, demo, and scope. This document describes this implementation's API and runtime behavior. Shared runtime, type-level, and MCP checks are in [`tests/`](../tests/); scenario tests are in `examples/*/scenario.test.ts`. `pnpm test` runs both.

An action execution refusal returns `{ ok: false, error: { code, message } }` and is audited. Programming and storage errors may throw; the write path records them as described below. Query errors are exceptions rather than action refusals.

## Code organization

`core.ts` contains model definitions, the write-back contract, and `Runtime`, in that order. Inside `Runtime`, indexing comes first, followed by reads, Action execution, audit reads, and internal helpers. Pure operations on evaluated sets are in `query.ts`.

| File | Responsibility |
| --- | --- |
| `core.ts` | Definition helpers, instances, edit plans, and the Runtime that reads, executes, persists and audits them. |
| `query.ts` | Pure operations on evaluated sets and aggregations, using caller-supplied predicates. |
| `mcp.ts` | Generate tools from the model and adapt inputs to the same runtime operations. |

## Instances and traversal

Runtime object values are read snapshots shaped as `{ type, pk, properties }`. Identity is `(type, pk)`; `pk` comes from the declared primary key, even when that property is not named `id`. Business properties named `type`, `pk`, or `properties` remain nested without collisions. Mutating a snapshot does not write the store.

`get` returns an instance or `undefined`; `search`, `traverse` and `pivot` return an `ObjectSet`. Visibility, object-filter callbacks, action contexts and `meta.target` receive instances. `modify` changes, `create` data and indexing rows use business properties directly. `defineAction(objects, …)` derives `ctx.object` from its object name and `ctx.params` from its parameter schema. `modify(instance, changes)` describes an edit without applying it. All edit payloads are checked at runtime.

With the orders example, either end of a link can be the source:

```ts
const hq = { actor: 'user:hq' }
const customer = rt.get('Customer', 'N-C01', hq)!
const orders = rt.traverse(customer, 'customerOrders', hq) // ObjectSet, type === 'Order'
const customers = rt.traverse(orders.objects[0], 'customerOrders', hq) // ObjectSet, type === 'Customer'
console.log(orders.objects[0].properties.status)
```

Input names are strings, and operation params and edit properties are plain records. The runtime checks model-specific names, values and relationships.

A literal name in `get`, `search` or `call` determines its result type. Keep the inferred model definition; an explicit `OntologyDef` annotation erases its specific schemas. A dynamic object name returns common instances with `unknown` property values; a dynamic Function name returns `unknown`. `traverse`, `pivot` and set algebra return the common `ObjectSet` shape. Code that needs concrete properties after traversal must narrow or assert their types; an assertion does not validate a value.

`traverse(source, linkName, { actor, direction? })` accepts a full instance. The link definition determines direction.

`direction` is optional in the TypeScript interface. The runtime checks whether it can be omitted and rejects an impossible direction or a missing choice for a same-type link:

| Source type matches | Direction | Runtime destination |
| --- | --- | --- |
| `from` only | `forward`, optional | `to` |
| `to` only | `reverse`, optional | `from` |
| Both ends | `forward` or `reverse`, required | The same object type |
| Neither end | Invalid link for this source | — |

For an `Employee → Employee` link defined from manager to subordinate, `forward` gets subordinates and `reverse` gets managers.

The rule depends on the declared types, not the stored edges. Traversal always returns a set, including for one-to-many reverse traversal; its `type` tag records the destination. Traversal re-reads `(type, pk)` under the caller's actor and checks visibility at both ends. Supplied properties are ignored for these checks. Missing or hidden sources yield an empty set retaining the destination type. Invalid source shape, link or direction throws.

`pivot(set, linkName, { actor, direction? })` applies the same rules to each origin and deduplicates the destinations. It validates the link and direction even when the input set is empty. Returning to a previously visited type retrieves the related instances, not the original or complete set of that type.

## Object sets, filters and aggregation

An `ObjectSet<O>` is `{ type, objects }`: one object type and an array of its instances, already evaluated. Empty sets retain the type. Identity is `(type, pk)`; duplicates keep the first occurrence. `objectSet(type, objects)` constructs and validates this shape. Its tag and array are readonly in TypeScript; agreement between the tag and every member is checked at runtime. The optional element type `O` describes properties but does not prove this agreement. This is not a deep freeze: object properties remain read snapshots, and set operations may share those instance values.

`filter`, `union`, `intersect`, `subtract` and `aggregate` operate on those snapshots without an actor or store read. They return new containers, do not change the store and are not audited. Set algebra requires the same object type. Union preserves left members followed by unseen right members; intersection and subtraction preserve left order and values. No freshness comparison is attempted: when identities overlap, the left snapshot wins. Re-run the read or Function to obtain current state.

```ts
const orders = rt.search('Order', { actor: 'user:hq' })
const pending = rt.filter(orders, (order) => order.properties.status === 'pending')
const large = rt.filter(orders, (order) => order.properties.total >= 10000)
const either = rt.union(pending, large)       // OR
const both = rt.intersect(pending, large)   // AND between sets
const remaining = rt.subtract(orders, both)
```

`filter` accepts a synchronous TypeScript predicate; `search` accepts the same callback in its optional `filter` option. Predicates must not cause side effects; exceptions propagate without an action audit. The runtime checks the collection shape, while the callback controls comparisons, case sensitivity, OR/NOT, and null or missing values. It does not validate a callback's logic against property schemas or enforce purity.

For dates, the examples compare `Date.parse(...)` values so different UTC offsets compare as instants. Dates remain strings in stored properties.

`aggregate(set, { groupBy?, sum? })` always computes `count` and optionally sums one numeric property. Omit `groupBy` to aggregate the whole set; supply a scalar property to aggregate each group. Calling `aggregate(set)` counts the whole set. Its result has two parts:

- `set`: the input objects belonging to its groups.
- `values`: rows containing a group `key` (a scalar, or `null` for a whole-set total), member `pks`, and a `metrics` object such as `{ count: 2, sum: 5000 }`.

A whole-set aggregation returns exactly one row, even for an empty set: `count` is 0 and a requested `sum` is 0. Grouping an empty set by a property returns no rows. Counts and sums use unique object IDs, so reaching an object by several paths does not count it twice.

```ts
const total = rt.aggregate(pending, { sum: 'total' })
console.log(total.values[0].metrics) // Count and sum for all selected orders; key is null

const grouped = rt.aggregate(pending, { groupBy: 'status', sum: 'total' })
const selected = rt.filter(grouped, (row) => row.metrics.sum >= 10000)
console.log(selected.values) // Selected rows, with their original metrics
const targets = selected.set // Order objects belonging to those rows
```

Filtering an aggregation applies the predicate to its rows and retains the union of their corresponding objects; it does not recompute metrics. To filter object properties, use `.set`, then aggregate again explicitly if needed. Filtering to zero rows keeps an empty tagged set and an empty `values` array. Grouping by a property does not pivot to the type that property might refer to.

Model Functions can return the same `AggregationResult<O>` shape for link-based or custom metrics. For example, finance returns recipient **accounts** with `senderCount`, `transactionCount` and `totalAmount`, computed from **transfers**. `aggregationResult(set, values)` validates finite numeric metrics, unique group keys and member references, and forms the corresponding set. `metrics` is a `Readonly<Record<string, number>>`. Producers keep metric names consistent; typos and missing columns are not checked, and reading an absent metric yields `undefined` at runtime.

Each row's `pks` refer to its target set, not automatically to its evidence records. Evidence sets live alongside the aggregation in the Function result; callers select the evidence for the chosen target. Aggregation supports optional/nullable/default wrappers around scalar properties, but grouping by a null or missing property value or summing one throws. A total's `key: null` marks the absence of grouping, not a null-valued property group; it is also the only row kind that allows empty `pks`.

## MCP query inputs

The model generates `search_<type>`, `get_<type>`, `union_<type>`, `intersect_<type>`, `subtract_<type>`, `aggregate_<type>`, plus `traverse_<link>` and `pivot_<link>`.

| Tool | Input |
| --- | --- |
| `search_<type>` | `{}`; all objects visible to this session. |
| `get_<type>` | `{ <primaryKey>: value }` |
| `union/intersect/subtract_<type>` | `{ left: pks, right: pks }` |
| `aggregate_<type>` | `{ pks, group_by?, sum? }`; omit `group_by` for a whole-set total. |
| `traverse_<link>` | `{ source: { type, pk, properties }, direction? }` |
| `pivot_<link>` | `{ source: { type, pks }, direction? }` |

Generated schemas expose the model's types, links and aggregation properties. For same-type links, the traversal and pivot schemas require `direction`.

Object collections serialize as `{ type, objects }`. The server accepts no filter clauses, callback strings, arbitrary code or SQL. Agents filter results in their own code execution environment, then pass selected IDs to the next tool. This requires a client with code execution; the repository does not provide that environment. Objects must be transferred to the client before local filtering, which limits this approach for large sets.

For example, with a `call<T>` helper that calls an MCP tool and decodes its JSON result:

```ts
const orders = await call<ObjectSet>('search_order', {})
const pks = orders.objects
  .filter((order) => order.properties.status === 'pending')
  .map((order) => order.pk)
const customers = await call<ObjectSet>('pivot_customer_orders', {
  source: { type: 'Order', pks },
})
```

For aggregate results, filter `.values` locally and deduplicate the selected rows' `pks`. Pass those IDs to a pivot, set operation or aggregation; the server does not accept a whole aggregation for filtering. Metrics remain snapshots from the earlier analysis. Each tool reloads IDs under the session actor, so an earlier result cannot grant access to an object that has since become hidden or disappeared. Actions independently recheck current business conditions and evidence. Candidate eligibility remains in model Functions and Actions; local filtering expresses the caller's investigation choices.

The [finance MCP scenario test](../examples/finance/scenario.test.ts) demonstrates this client flow, including the `call<T>` helper, local date/metric filtering and an Action. A client's code may import the pure `filterObjects` / `filterAggregation` helpers from `query.ts` to retain the set envelope, but these helpers are not required to select IDs from returned JSON.

## Visibility and caller identity

`get`, `search`, `traverse` and `pivot` carry an `actor`. Pure operations on already obtained sets do not reapply visibility; sharing such values with another caller is the application’s responsibility. An object type's optional `visibility` predicate filters reads and action targets. A hidden object behaves like a missing one: `get` returns `undefined`, traversal returns no hidden rows, and running an action refuses a hidden target with `TARGET_NOT_FOUND`.

Authentication establishes the actor's identity outside the runtime. When an implementation provides authorization, policies belong on object types and actions so every consumer is subject to the same constraints. That placement is a separate design choice from the mechanism used to implement it, such as groups, attributes, or a policy language. Preconditions check business validity. Separating permission from validity is recommended; implementing them as separate mechanisms is not a condition of the pattern.

This reference implementation demonstrates where model-attached policies live and how they act. How much authorization to provide is an implementation choice; here, `visibility` is optional and declared to default to fail-open: visible to everyone. The actor is a self-declared string; the runtime provides neither authentication nor a general action-permission system. Making visibility declarations mandatory alone cannot protect access based on verified user identities. Audit reads remain an unscoped administrative view, without visibility filtering.

Over MCP stdio, callers share one actor. `OO_AGENT=<name> pnpm mcp` labels it as `agent:<name>`; this is not authentication. The server generates read tools and action tools from the model and passes calls through the runtime. Action refusals become MCP errors containing `{ error: { code, message } }`; caught runtime exceptions use the `INTERNAL` code. For local store access, see [Transaction ownership](#transaction-ownership).

## Running named operations

`execute(actionName, params, { actor })` applies an Action; `call(functionName, params, { actor })` invokes a Function. Both validate params against the model schema. `execute` returns success or refusal as `ActionResult`; unknown Action names are refused as `UNKNOWN_ACTION` and audited. `call` returns the Function's value, including a Promise for an asynchronous implementation, and throws for unknown Function names. Action and Function names must be distinct to keep generated MCP tool names unambiguous.

## Executing actions

An action definition must include `preconditions`, using `[]` when there are none. Because business rules at the action govern the write path, having no conditions must also be an explicit decision by the model's author.

`execute(actionName, params, { actor })` follows this order:

1. Validate params and load the target under the actor's visibility policy.
2. Evaluate preconditions in order, returning the first refusal.
3. Run the effects function to obtain an edit plan.
4. Dry-run the whole plan through the commit's own code, then roll it back.
5. Check the plan against the ownership declarations.
6. Write back a nonempty source-backed plan through the adapter.
7. Commit the local edits and audit entry in one transaction.

Effects describe changes as data and must be pure. `modify` changes properties, `create` creates an object, and `link` / `unlink` change relationships. Source-backed creation requires write-back, just like source-backed modification. The gate checks schemas, object existence, and cardinality before the adapter runs. One Action can accept array parameters and commit multiple edits atomically; separate Action calls are separate transactions and audit entries. These edits change instances; model definitions are code reviewed and versioned in git.

## Model-defined functions

Models register named reads in `functions` using `defineFunction({ description, params, run })`. `call` validates params and invokes `run({ params, actor })`; the callback receives schema-derived params. Invalid inputs and implementation errors throw; calls do not enter the action audit log. MCP generates a tool with the same input schema and session actor, marks it with `readOnlyHint`, awaits asynchronous results and reports caught exceptions as `INTERNAL` errors.

Function implementations must use the caller's actor for their reads and must not perform writes or other side effects. This is a model-author contract, like pure preconditions and effects, not an enforced sandbox. Functions can implement domain reads without an associated Action.

Candidate evaluation and Action preconditions can share ordinary model functions. A Function can return eligibility or proposed changes; the Action checks business conditions and the edit plan against current indexed state when it executes. Function results do not reserve resources or guarantee the validity of the complete edit plan.

The examples show [customer impact and contact tasks](../examples/factory/README.md), [candidate evaluation and allocation](../examples/hospital/README.md), and [recipient summaries and investigation cases](../examples/finance/README.md). They document how exploration supplies Action evidence, how Functions evaluate candidates or compare metrics, and how Actions recheck and save selections. Stored evidence links retain record identities, not immutable copies of source record contents.

## The authority line, checked

The model declares ownership in two places: `owned` on object types and links marks ontology-owned state, and `writeback: true` on an action marks its changes source-backed. The runtime classifies every edit plan against the `owned` declarations and refuses any plan that contradicts its action's declaration:

| the plan | action declares `writeback` | result |
| --- | --- | --- |
| changes source-backed state | no | refused: **`UNDECLARED_SOURCE_WRITE`** |
| changes only ontology-owned state | yes | refused: **`MISDECLARED_WRITEBACK`** |
| changes both kinds, within one edit or across edits | either | refused: **`MIXED_AUTHORITY`** |

The reasoning, row by row. An undeclared source write would be a local change to source-owned data that never reaches the source — exactly what property 4 forbids. A misdeclared write-back contains nothing that belongs to a source. A mixed plan is refused because this implementation routes plans whole, so an action must sit on one side of the line; split the action if it needs both. Per-edit routing is unsupported.

An empty plan touches neither side of the line: no adapter call, only the audit entry is committed. An action that declares write-back but has no adapter configured is refused with **`NO_WRITEBACK_ADAPTER`**.

Validity is checked before authority. The whole plan is dry-run through the commit's own code first, so a plan the store would refuse is **`INVALID_EDITS`** even if it also crosses the authority line.

The four declared answers themselves are enumerable at runtime as `Runtime.declarations`, pinned by a test.

### Creating source-backed objects

`create(type, pk, data)` follows the type's ownership: `owned: true` creates locally; otherwise creation requires `writeback: true` and an adapter. The adapter receives the existing `create` edit, persists the source record, and returns before the runtime commits it locally. Actions still target an existing visible object; for example, an action on a Customer can create a Ticket and then a source-backed link to it in the same plan.

Supply the ID in both `pk` and the primary-key property of `data`. The adapter must preserve that identity and the supplied source properties, and throw on source conflicts or rejected creation. It cannot return a source-generated ID or replacement values. Adapters implement the operations they support; the orders demo's existing adapter still only handles order cancellation. The [source-creation tests](../tests/source-create.test.ts) demonstrate an actual SQLite `INSERT`, link creation, source transaction rollback and re-indexing.

For a type with `owned: { property: default }`, omit those properties from `data`, just as with `load()`. The runtime supplies their defaults locally without sending them to the adapter. Explicitly supplying an owned property, even its default, is `MIXED_AUTHORITY`; change it in a separate Action. The created row remains source-backed: subsequent snapshots replace it normally, with any later owned edits preserved through the existing overlay.

## Failure semantics in detail

The declared ordering is write-back first: the adapter runs before the local commit. If the system of record refuses, nothing changes in the ontology. The remaining risk is the reverse failure — the adapter succeeded and the local commit failed — and when it happens, the systems have diverged. Three mechanisms bound that risk.

**Nothing invalid crosses the boundary.** Before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back: a dry run using the commit's own code, not a second validator that could drift out of sync. Every violation the store can detect — schema, cardinality, link endpoints — is refused before anything reaches a system of record. The adapter also receives its inputs up front, as its own copies: the validated plan, and the target object as the runtime loaded it (`meta.target`). It never needs to read the ontology store.

**The audit log records both failure directions.** A **`WRITEBACK_FAILED`** refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing, since source-side atomicity is the adapter's contract, not this runtime's. The reverse failure is audited as **`COMMIT_FAILED`**, plan included: after a write-back-first action, those edits are what already reached the source. Both entries are raw material for reconciliation.

**"Every action attempt is audited" has a stated limit.** It covers `execute` calls admitted to the write gate and observed to completion, including unknown Action names. Reads, Function calls, and calls refused because of a caller-opened transaction do not enter this log. If the process dies between the source update and the local commit, both the edit and its audit entry are lost. Closing that window would take a persisted pending-invocation record, which this implementation does not have.

A crash inside the write path is audited as **`EXECUTION_CRASHED`** — a storage fault, or model code (a visibility predicate, a precondition, an effects function) that threw. The error then propagates to the caller.

The audit write itself must not be a failure point. Params whose values would change when serialized to JSON and back are refused as **`INVALID_PARAMS`** before the model runs. Anything the log still cannot encode is recorded as a `$unserializable` placeholder: a lossy audit entry is better than a missing one.

The audit log sits outside the object graph because its contract differs from that of ordinary business objects. It records refusals and crashes that commit no business edits, retains a record using placeholders for values it cannot encode, and is appended to by the runtime without going through an action. Treating entries as ordinary objects would require exceptions to schema-based refusal and action-gated writes, so this implementation exposes them through a separate administrative view.

**Preconditions and freshness.** Rules see the indexed snapshot plus applied local edits. The source may have changed since indexing; the runtime does not re-check source invariants itself. The adapter must handle that boundary. The demo's [ERP adapter](../examples/orders/erp-adapter.ts) uses a guarded `UPDATE`, allowing the ERP to refuse a cancellation after an order has shipped.

**Concurrency.** Action execution and the adapter interface are synchronous. The example assumes a single writer, so no other action interleaves between preflight and commit. An asynchronous adapter or multiple writers would require an explicit concurrency mechanism; neither is implemented here.

**Retries.** There are no idempotency keys or deduplication. `cancelOrder` refuses an already-cancelled order through its own precondition, but that does not guarantee every action or external side effect is safe to retry. A caller-supplied note ID can prevent duplicate local creation; it is not a general retry protocol.

An action instance is identified by its occurrence, not its arguments. Two calls with the same params are separate attempts, each subject to auditing. Adding an invocation ID to params can correlate attempts, but deduplication also requires deciding how checking and recording that ID coordinates with executing side effects. Recording the ID in the log alone does not prevent duplicate execution.

## Transaction ownership

Rollback has three areas of responsibility. Source dataset versioning and rollback belong to the data platform. This runtime applies an action's local edits and audit entry in one SQLite transaction. Consistency across write-back to external systems is a separate design concern: a local rollback cannot undo changes already delivered to a source. This implementation declares its ordering and failure behavior in the [preceding section](#failure-semantics-in-detail).

One rule is enforced: callers cannot wrap the runtime. Running an Action and calling `load()` are refused inside a caller-opened transaction, because inside one, "committed" would really mean "until the caller rolls the savepoint back" — an applied-and-audited action could be undone after the runtime reported success. This is an atomicity guarantee, not an intrusion defense.

The rest of the boundary is declared, not defended. The runtime is an in-process library: any code that holds the database handle — the caller, a rule, the write-back adapter — can bypass the action gate with a direct `UPDATE`, and no in-process check can prevent that. The contract is therefore: rules and the adapter must not touch the ontology store. The adapter has no reason to — it receives its own copies of the edit plan and the target object, and speaks only to the systems of record.

A deployment that needs an enforced boundary should put the runtime behind a process boundary, with no direct database access for consumers. The bundled MCP server is exactly that shape.

## The storable boundary

The store keeps JSON, so every stored value must survive JSON serialization and deserialization unchanged. A row containing a value that would come back changed or dropped — a class instance, a `Date`, `NaN`, a `Map`, `undefined` at any depth — is refused at every write, whether it arrives through an action or through `load()`. The same check applies to a declared default for an `owned` property (at definition time) and to action params (at the entry point; see the audit note above).

Property schemas must validate without transforming values. This is the model author's responsibility. The runtime feeds stored values back through the same schema on later writes, so a transforming schema (`z.coerce.date()`, `.transform(…)`) would refuse or silently rewrite its own output on the next pass.

## Re-indexing vs edits

Snapshot semantics, per loaded type: replace the base, reapply the edit layer. The rules, each stated as its outcome:

- **Refused: a snapshot row that supplies ontology-owned state.** Rows that set ontology-owned properties, rows of ontology-owned types, and instances of ontology-owned links are all refused — the source owns none of them.
- **Kept: edits to ontology-owned properties.** They live in an overlay keyed by (type, pk); after a re-index, the overlay's current patch is reapplied over the fresh base. An edit set back to its declared default is removed from the overlay — clearing an edit also clears the obligation to preserve it. (The comparison is structural, so key order cannot fake or hide "back at default".)
- **Kept in place: ontology-owned types and links.** `load()` refuses to touch them, so they need no overlay.
- **Refused whole: a load that would orphan an edit.** If a base row disappears while it still carries ontology-owned edits, the entire load is refused and the previous state stands. What happens to that state is a reconciliation decision, and the runtime does not make reconciliation decisions silently: clear the edit or restore the row, then re-load. Clearing the edit is itself an action, so even reconciliation stays inside the write gate.
- **Refused: an overlay key the model no longer owns.** If the model stops declaring a property ontology-owned while an overlay patch still carries it, the load is refused — that state's fate belongs to explicit schema evolution, not to a refresh.
- **Refused: a partial snapshot that breaks constraints.** If surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.

## Current limits

- Creation requires an ID known before write-back; source-generated IDs and returned source values are unsupported.
- Object deletion, link properties and composite keys are unsupported. Quantities or timestamps on a relationship can be represented by a separate object, as in the factory's shipment lines and finance's transfers.
- Nested properties follow their Zod schemas and are not made strict by the runtime.
- Queries use the local SQLite snapshot, with no pagination or result cap. Saved/lazy queries, automatic path history, recursive exploration, arbitrary transforms, joins, federation and runtime schema evolution are outside the implemented API.
