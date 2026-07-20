**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](./README.md) defines the pattern and summarizes this repository's declared answers. This document explains the mechanics behind those answers: processing order, error codes, and edge cases. None of it is the pattern — all of it is what this one implementation declares — and every behavior described here is pinned by a test in [`tests/core.test.ts`](./tests/core.test.ts).

Every refusal named here is machine-readable: the action returns `{ ok: false, error: { code, message } }`, and the attempt is recorded in the audit log.

## The authority line, checked

The model declares ownership in two places: `owned` on object types and links marks ontology-owned state, and `writeback: true` on an action marks its changes source-backed. The runtime classifies every edit plan against the `owned` declarations and refuses any plan that contradicts its action's declaration:

| the plan | action declares `writeback` | result |
| --- | --- | --- |
| changes source-backed state | no | refused: **`UNDECLARED_SOURCE_WRITE`** |
| changes only ontology-owned state | yes | refused: **`MISDECLARED_WRITEBACK`** |
| changes both kinds, within one edit or across edits | either | refused: **`MIXED_AUTHORITY`** |
| creates an object of a source-backed type | either | refused: **`SOURCE_CREATE_UNSUPPORTED`** |

The reasoning, row by row. An undeclared source write would be a local change to source-owned data that never reaches the source — exactly what property 4 forbids. A misdeclared write-back contains nothing that belongs to a source. A mixed plan is refused because this implementation routes plans whole, so an action must sit on one side of the line; split the action if it needs both. (Per-edit routing is future work.) Creating a row at the source is real — write-back could carry it — but this implementation does not demonstrate it, so it refuses rather than half-supports; creation is limited to ontology-owned types. (Also future work.)

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

## Transaction ownership

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
