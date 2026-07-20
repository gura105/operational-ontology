**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](./README.md) defines the pattern and summarizes this repository's declared answers. This document is the engineering appendix: the exact mechanics behind those answers — error codes, edge cases, and the guarantees they add up to. None of this is the pattern. All of it is what one implementation declares, and every behavior described here is pinned by a test in [`tests/core.test.ts`](./tests/core.test.ts).

Refusals named here are machine-readable: an action that hits one returns `{ ok: false, error: { code, message } }`, and the attempt lands in the audit log.

## The authority line, checked

The model declares which state the ontology owns (`owned` on object types and links) and which changes are source-backed (`writeback: true` on actions). The runtime classifies every edit plan against the `owned` declarations and refuses a plan that contradicts its action's declaration:

- **`UNDECLARED_SOURCE_WRITE`** — the plan changes source-backed state but the action does not declare `writeback: true`. A local change to source truth that never travels home is exactly the shadow copy the fourth property forbids.
- **`MISDECLARED_WRITEBACK`** — the action declares `writeback: true` but the plan changes only ontology-owned state. Nothing in it belongs to a source.
- **`MIXED_AUTHORITY`** — the plan changes both kinds of state, within one edit or across edits. This implementation routes a plan whole, so an action must sit on one side of the line; split it if it doesn't. (Per-edit routing is on the v0.2 worklist.)
- **`SOURCE_CREATE_UNSUPPORTED`** — the plan creates an object of a source-backed type. Creating a row *at* the source is real — write-back could carry it — but this implementation does not demonstrate it, so it refuses rather than half-supports. Creation is for ontology-owned types only. (Also on the v0.2 worklist.)

An empty plan touches neither side of the line: it calls no adapter and commits only its audit entry. An action that declares write-back but has no adapter configured is refused (**`NO_WRITEBACK_ADAPTER`**).

## Failure semantics in detail

The README declares write-back-first ordering: the adapter runs before the local commit, so if the system of record refuses, nothing changes here — and the reverse failure (adapter succeeded, local commit failed) remains possible. Three mechanisms sharpen that boundary:

**Nothing invalid crosses it.** Before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back — a dry run of the commit, by the commit's own code, not a second validator that could drift out of sync. Every violation the ontology store could raise (schemas, cardinality, delete restrictions, link endpoints) is refused *before* anything reaches a system of record. The only divergence left is the declared reverse failure.

**The audit log carries the reconciliation material.** A **`WRITEBACK_FAILED`** refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing; source-side atomicity is the adapter's contract, not this runtime's. The reverse failure is audited as **`COMMIT_FAILED`**, plan included: after a write-back-first action, those edits are what already reached the source.

**The honest limit of "every attempt is audited".** It means every attempt this runtime observed to completion. A process death between the source update and the local commit loses both the edit and its audit entry; closing that window takes a persisted pending-invocation record, which this implementation does not have.

Crashes inside the write path are audited too, with a code that says where they happened: **`READ_FAILED`** for storage faults, **`RULE_CRASHED`** for model code — a visibility predicate, a precondition, an effects function — that threw. The error then surfaces to the caller.

## Transaction ownership

The runtime owns its database transactions, in both directions:

- **Callers cannot wrap it.** `execute()` and `load()` refuse to run inside a caller-opened transaction. Inside one, "committed" would really mean "until the caller rolls the savepoint back" — an applied-and-audited action could be silently unwound after the runtime reported success.
- **Foreign code cannot reach in.** Rules and the write-back adapter must not touch the ontology store; the adapter receives its own copy of the edit plan and speaks only to the systems of record. The observable violation — a transaction left open on the store, however the attempt ends, success or refusal — is rolled back whole, everything the attempt wrote with it, and recorded as the one fact that survives: **`FOREIGN_TRANSACTION`**.

## The storable boundary

The store keeps what a schema produced and feeds it back to the same schema on later writes. Two things must therefore hold for every stored value, and the runtime checks them at the boundary, per write:

- **Plain JSON data.** A value the store cannot hold faithfully — a class instance, a `Date`, `NaN`, a `Map`, `undefined` at any depth — is refused: it would come back changed.
- **A fixed point of its schema.** The schema must accept its own output unchanged (validate-and-normalize, not a one-way transform) — otherwise a stored value would come back refused, or silently drift on every pass. Compared canonically, so key order and equivalent encodings cannot fake or hide a difference.

Declared defaults for `owned` properties get the same checks at definition time; the per-write check exists because a declaration alone cannot hold a conditional transform to it.

## Targetless scope

A targetless action has no target object, hence no visibility gate. The runtime holds its plan to exactly what that bargain allows: **create objects, and wire the objects it created to each other.** A modify, a delete, or a link endpoint that is not one of the plan's own creations is refused (**`TARGETLESS_SCOPE`**) — without a gate, touching pre-existing state would turn the action into an existence probe. Touching what exists is a targeted action's job, behind its visibility gate.

Creation identity is tracked as (type, pk) pairs, never as a joined string — names are data, and data does not get to invent delimiters.

## Re-indexing vs edits

Snapshot semantics, per loaded type: replace the base, reapply the edit layer. In detail:

- **A snapshot speaks only for source-backed state.** A row that supplies an ontology-owned property is refused, as are rows of ontology-owned types and instances of ontology-owned links — the source has no authority over any of them.
- **Ontology-owned properties survive via the overlay.** Edits to them live in an overlay keyed by (type, pk); after a re-index, the overlay's current patch is reapplied over the fresh base. An edit set back to its declared default is pruned from the overlay — clearing an edit clears the survival obligation with it. (Compared canonically: transforms and key order cannot fake or hide "back at default".)
- **Ontology-owned types and links survive in place.** `load()` refuses to touch them, so they need no overlay.
- **Conflicts refuse the whole load**, and the previous state stays standing. A base row that disappears while still carrying ontology-owned edits is a reconciliation decision, and the runtime does not make reconciliation decisions silently: clear the edit or restore the row, then re-load. Clearing the edit is itself an action, so even reconciliation stays inside the write gate.
- **The same rule binds deletes.** Deleting a source-backed row that still carries ontology-owned edits is refused — clear them first.
- **A partial snapshot has the same outcome.** If surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.
