**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](./README.md) defines the pattern and summarizes this repository's declared answers. This document is the engineering appendix: the exact mechanics behind those answers — error codes, edge cases, and the guarantees they add up to. None of this is the pattern. All of it is what one implementation declares, and every behavior described here is pinned by a test in [`tests/core.test.ts`](./tests/core.test.ts).

Refusals named here are machine-readable: an action that hits one returns `{ ok: false, error: { code, message } }`, and the attempt lands in the audit log.

## The authority line, checked

The model declares which state the ontology owns (`owned` on object types and links) and which changes are source-backed (`writeback: true` on actions). The runtime classifies every edit plan against the `owned` declarations and refuses a plan that contradicts its action's declaration:

- **`UNDECLARED_SOURCE_WRITE`** — the plan changes source-backed state but the action does not declare `writeback: true`. A local change to source truth that never travels home is exactly the shadow copy the fourth property forbids.
- **`MISDECLARED_WRITEBACK`** — the action declares `writeback: true` but the plan changes only ontology-owned state. Nothing in it belongs to a source.
- **`MIXED_AUTHORITY`** — the plan changes both kinds of state, within one edit or across edits. This implementation routes a plan whole, so an action must sit on one side of the line; split it if it doesn't. (Per-edit routing is future work.)
- **`SOURCE_CREATE_UNSUPPORTED`** — the plan creates an object of a source-backed type. Creating a row *at* the source is real — write-back could carry it — but this implementation does not demonstrate it, so it refuses rather than half-supports. Creation is for ontology-owned types only. (Also future work.)

An empty plan touches neither side of the line: it calls no adapter and commits only its audit entry. An action that declares write-back but has no adapter configured is refused (**`NO_WRITEBACK_ADAPTER`**).

The refusal order is declared, too: **validity precedes authority.** The whole plan is dry-run through the commit's own code first, so a plan the store would refuse is **`INVALID_EDITS`** even if it also crosses the authority line — an edit that cannot happen has no home worth arguing about.

The four declared answers themselves travel as one enumerable value, `Runtime.declarations`, pinned by a test.

## Failure semantics in detail

The README declares write-back-first ordering: the adapter runs before the local commit, so if the system of record refuses, nothing changes here — and the reverse failure (adapter succeeded, local commit failed) remains possible. Three mechanisms sharpen that boundary:

**Nothing invalid crosses it.** Before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back — a dry run of the commit, by the commit's own code, not a second validator that could drift out of sync. Every violation the ontology store could raise (schemas, cardinality, link endpoints) is refused *before* anything reaches a system of record. The only divergence left is the declared reverse failure. The adapter also receives its routing material up front: its own copies of the validated plan and of the target object as the runtime loaded it (`meta.target`), so it never needs to read the ontology store.

**The audit log carries the reconciliation material.** A **`WRITEBACK_FAILED`** refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing; source-side atomicity is the adapter's contract, not this runtime's. The reverse failure is audited as **`COMMIT_FAILED`**, plan included: after a write-back-first action, those edits are what already reached the source.

**The honest limit of "every attempt is audited".** It means every attempt this runtime observed to completion. A process death between the source update and the local commit loses both the edit and its audit entry; closing that window takes a persisted pending-invocation record, which this implementation does not have.

Crashes inside the write path are audited too: **`EXECUTION_CRASHED`** — a storage fault, or model code (a visibility predicate, a precondition, an effects function) that threw. The error then surfaces to the caller.

The audit write itself must never be the thing that fails. Params that survive no JSON round trip are refused as **`INVALID_PARAMS`** before the model runs, and whatever the log cannot encode is recorded as a `$unserializable` placeholder — a lossy audit entry beats a lost one.

## Transaction ownership

One rule is enforced: **callers cannot wrap the runtime.** `execute()` and `load()` refuse to run inside a caller-opened transaction. Inside one, "committed" would really mean "until the caller rolls the savepoint back" — an applied-and-audited action could be silently unwound after the runtime reported success. This is an atomicity guarantee, not an intrusion defense.

The rest of the boundary is **declared, not defended**. This runtime is an in-process library: any code that holds the database handle — the caller, a rule, the write-back adapter — can physically bypass the action gate with a direct `UPDATE`, and no in-process check can prevent that. So the boundary is a contract: rules and the adapter must not touch the ontology store. (The adapter has no reason to — it receives its own copies of the edit plan and the target object, and speaks only to the systems of record.) An earlier version policed the one observable slice of this — a transaction left open on the store — and v0.2 removed the detector: a check that catches one intrusion shape but not the simplest one reads as a defense and is not one. A deployment that needs a real boundary puts the runtime behind a process boundary; the MCP server is exactly that shape.

## The storable boundary

The store keeps JSON, so every stored value must survive the JSON round trip unchanged. A class instance, a `Date`, `NaN`, a `Map`, `undefined` at any depth — all would come back changed or dropped, so a row containing one is refused at every write, whichever door it came through (an action or `load()`). A declared default for an `owned` property gets the same check at definition time, and action params get it at the door (see the audit note above).

One obligation is declared rather than checked: **property schemas must validate, not transform.** The runtime feeds stored values back through the same schema on later writes, so a transforming schema (`z.coerce.date()`, `.transform(…)`) would refuse or silently rewrite its own output on the next pass. An earlier version enforced this with a per-write fixed-point check; v0.2 states it as the model author's contract instead.

## Re-indexing vs edits

Snapshot semantics, per loaded type: replace the base, reapply the edit layer. In detail:

- **A snapshot speaks only for source-backed state.** A row that supplies an ontology-owned property is refused, as are rows of ontology-owned types and instances of ontology-owned links — the source has no authority over any of them.
- **Ontology-owned properties survive via the overlay.** Edits to them live in an overlay keyed by (type, pk); after a re-index, the overlay's current patch is reapplied over the fresh base. An edit set back to its declared default is pruned from the overlay — clearing an edit clears the survival obligation with it. (Compared structurally, so key order cannot fake or hide "back at default".)
- **Ontology-owned types and links survive in place.** `load()` refuses to touch them, so they need no overlay.
- **Conflicts refuse the whole load**, and the previous state stays standing. A base row that disappears while still carrying ontology-owned edits is a reconciliation decision, and the runtime does not make reconciliation decisions silently: clear the edit or restore the row, then re-load. Clearing the edit is itself an action, so even reconciliation stays inside the write gate.
- **A model that stops owning a property is the schema-evolution twin of the same conflict.** An overlay patch carrying a key the model no longer declares ontology-owned refuses the load — a refresh must not decide that state's fate; schema evolution must, explicitly.
- **A partial snapshot has the same outcome.** If surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.
