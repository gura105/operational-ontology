/**
 * operational-ontology · core
 *
 * The definition layer (the model as data) and the runtime that makes it
 * operational:
 *
 *   - objects & links are indexed from existing physical data (read side)
 *   - every write goes through an action: preconditions → effects → audit log
 *   - there is no other write path
 *   - authority is declared in the model: source-backed state comes from the
 *     sources and write-back governs its changes; ontology-owned state lives
 *     here, needs no write-back, and survives re-indexing
 *
 * The ontology definition is a plain value, not a class hierarchy. The
 * runtime interprets it — which is what lets `mcp.ts` enumerate it and expose
 * the same model, guarded by the same rules, to AI agents.
 */
import { z } from 'zod'
import type { Database } from 'better-sqlite3'

// ───────────────────────────── Definitions ─────────────────────────────

export type Properties = z.ZodRawShape

export interface ObjectTypeDef<S extends Properties = Properties> {
  /** Property that uniquely identifies an object of this type. Must be a string property. */
  primaryKey: string
  /**
   * Property schema. Validates rows at indexing time and edits at write time,
   * and is reused verbatim to generate MCP tool schemas.
   */
  properties: S
  /**
   * Authority declaration — which of this type's state the ontology itself
   * owns. Everything not declared here is source-backed: the indexed snapshot
   * supplies it, and changing it requires write-back.
   *
   * - `owned: true` — the whole type is ontology-owned, existence included.
   *   No source supplies its rows (`load()` refuses them); actions create,
   *   modify, and delete them without write-back; they survive re-indexing
   *   untouched.
   * - `owned: { prop: default }` — these properties are ontology-owned on
   *   otherwise source-backed rows. A loaded row must NOT supply them (the
   *   source has no authority over them); they start at the declared default,
   *   change only through actions, and survive re-indexing via the overlay.
   */
  owned?: true | Record<string, unknown>
  /**
   * Row-level visibility, attached to the model (an optional slot). Absent
   * means visible to everyone: this reference implementation is fail-open by
   * declaration — it has no authentication, so `actor` is self-declared and
   * enforcement here demonstrates placement, not protection. A fail-closed
   * deployment makes this slot required rather than optional, on top of an
   * authenticated identity layer. See "permissions and security" in the README.
   */
  visibility?: (ctx: { object: Record<string, unknown>; actor: string }) => boolean
  /**
   * Where the rows physically come from (documentation only — the integration
   * itself belongs to the data layer, outside the ontology).
   */
  source?: string
  description?: string
}

export function defineObject<S extends Properties>(def: ObjectTypeDef<S>): ObjectTypeDef<S> {
  if (!Object.hasOwn(def.properties, def.primaryKey)) {
    throw new Error(`primaryKey "${def.primaryKey}" is not one of the defined properties`)
  }
  if (def.owned === true && def.source) {
    throw new Error('an ontology-owned type has no source — drop `source` or the `owned: true`')
  }
  if (def.owned && def.owned !== true) {
    for (const [key, fallback] of Object.entries(def.owned)) {
      if (!Object.hasOwn(def.properties, key)) {
        throw new Error(`owned property "${key}" is not one of the defined properties`)
      }
      if (key === def.primaryKey) {
        throw new Error(`the primary key "${key}" cannot be ontology-owned`)
      }
      if (!(def.properties[key] as z.ZodType).safeParse(fallback).success) {
        throw new Error(`default for owned property "${key}" does not satisfy its schema`)
      }
    }
  }
  return def
}

export interface LinkTypeDef {
  from: string
  to: string
  /**
   * Cardinality is a model constraint, so it is enforced at the write gate:
   * for one-to-many, the "many" side belongs to at most one "one" side.
   */
  kind: 'one-to-many' | 'many-to-many'
  /**
   * Authority declaration for the link's instances. Absent means
   * source-backed: the snapshot supplies them, rewiring them requires
   * write-back, and re-indexing replaces them. `owned: true` means the
   * ontology owns them: `load()` refuses them, actions rewire them without
   * write-back, and they survive re-indexing.
   */
  owned?: true
  /** Physical origin of the link (a foreign key, a join table) — documentation only. */
  via?: string
  /**
   * For a one-to-many link mirrored by a foreign-key property on the "to"
   * side (`Order.customerId` for customerOrders): the property's name. The
   * link and the property are two representations of one fact, so the
   * runtime validates they agree — at indexing time and after every edit
   * plan. Absent for links with no property twin (join tables).
   */
  viaProperty?: string
  description?: string
}

export function defineLink(def: LinkTypeDef): LinkTypeDef {
  return def
}

/** A machine-readable refusal. Agents and UIs receive this, not a stack trace. */
export interface Violation {
  code: string
  message: string
}

export function reject(code: string, message: string): Violation {
  return { code, message }
}

/**
 * Edits are data: what an action wants to change, decoupled from how it is
 * applied. Links are edits too — actions can rewire the graph itself, not
 * just node properties.
 */
export type Edit =
  | { op: 'modify'; object: string; pk: string; changes: Record<string, unknown> }
  | { op: 'create'; object: string; pk: string; data: Record<string, unknown> }
  | { op: 'delete'; object: string; pk: string }
  | { op: 'link'; link: string; from: string; to: string }
  | { op: 'unlink'; link: string; from: string; to: string }

export const modify = (object: string, pk: string, changes: Record<string, unknown>): Edit => ({
  op: 'modify',
  object,
  pk,
  changes,
})
export const create = (object: string, pk: string, data: Record<string, unknown>): Edit => ({
  op: 'create',
  object,
  pk,
  data,
})
export const remove = (object: string, pk: string): Edit => ({ op: 'delete', object, pk })
export const link = (linkName: string, from: string, to: string): Edit => ({ op: 'link', link: linkName, from, to })
export const unlink = (linkName: string, from: string, to: string): Edit => ({ op: 'unlink', link: linkName, from, to })

export interface ActionCtx<O = Record<string, unknown>, P = Record<string, unknown>> {
  /** The object the action targets, loaded from the ontology store. */
  object: O
  params: P
  actor: string
}

/** Context for a targetless action: no existing object is the subject. */
export interface TargetlessActionCtx<P = Record<string, unknown>> {
  params: P
  actor: string
}

export interface ActionDef<S extends Properties = Properties> {
  /** Object type this action operates on. */
  object: string
  /** Name of the param that carries the target's primary key. */
  targetParam: string
  /** Parameter schema. Reused verbatim as the MCP tool input schema. */
  params: S
  description?: string
  /**
   * Business rules. Each precondition may return `reject(code, message)` to
   * refuse the write. These are domain rules ("a shipped order cannot be
   * cancelled"), not access control — a permission system decides *who* may
   * act; preconditions decide *whether the operation is valid at all*.
   */
  preconditions: Array<(ctx: ActionCtx<any, any>) => Violation | void>
  /**
   * The changes this action makes, described as data. Effects must be pure:
   * they describe edits, they do not perform them. Reaching into external
   * systems from here bypasses write-back ordering and the audit log — side
   * effects belong to the WritebackAdapter.
   */
  effects: (ctx: ActionCtx<any, any>) => Edit[]
  /**
   * Authority declaration for this action's changes. `writeback: true`
   * declares them source-backed: the edit plan is routed through the
   * write-back adapter before commit. Its absence declares them
   * ontology-owned. The declaration is checked, not trusted — the runtime
   * classifies every edit plan against the model's `owned` declarations and
   * refuses a plan on the wrong side of the line (or straddling it).
   */
  writeback?: boolean
}

/**
 * An action with no pre-existing target — its whole plan is creation (plus
 * whatever wiring the created objects need). No target means no visibility
 * gate: there is no object whose existence could leak. Preconditions still
 * run, and edit-plan validation still refuses links to nonexistent objects.
 */
export interface TargetlessActionDef<S extends Properties = Properties> {
  params: S
  description?: string
  preconditions: Array<(ctx: TargetlessActionCtx<any>) => Violation | void>
  effects: (ctx: TargetlessActionCtx<any>) => Edit[]
  writeback?: boolean
}

export type AnyActionDef = ActionDef<any> | TargetlessActionDef<any>

export function isTargeted(action: AnyActionDef): action is ActionDef<any> {
  return 'targetParam' in action
}

export function defineAction<S extends Properties>(def: ActionDef<S>): ActionDef<S>
export function defineAction<S extends Properties>(def: TargetlessActionDef<S>): TargetlessActionDef<S>
export function defineAction(def: AnyActionDef): AnyActionDef {
  if ('targetParam' in def || 'object' in def) {
    const targeted = def as ActionDef
    if (typeof targeted.object !== 'string' || typeof targeted.targetParam !== 'string') {
      throw new Error('a targeted action needs both `object` and `targetParam`; a targetless action has neither')
    }
    if (!Object.hasOwn(targeted.params, targeted.targetParam)) {
      throw new Error(`targetParam "${targeted.targetParam}" is not one of the action's params`)
    }
  }
  return def
}

export interface OntologyDef {
  name: string
  objects: Record<string, ObjectTypeDef<any>>
  links: Record<string, LinkTypeDef>
  actions: Record<string, AnyActionDef>
}

export function defineOntology(def: OntologyDef): OntologyDef {
  for (const [name, link] of Object.entries(def.links)) {
    for (const end of [link.from, link.to]) {
      if (!Object.hasOwn(def.objects, end)) {
        throw new Error(`link "${name}" references unknown object type "${end}"`)
      }
    }
    if (link.viaProperty !== undefined) {
      if (link.kind !== 'one-to-many') {
        throw new Error(`link "${name}": viaProperty implies a foreign key on the "to" side — one-to-many only`)
      }
      const to = def.objects[link.to]
      if (!Object.hasOwn(to.properties, link.viaProperty)) {
        throw new Error(`link "${name}": viaProperty "${link.viaProperty}" is not a property of ${link.to}`)
      }
      // The link and its property twin are one fact, so they must sit on the
      // same side of the authority line — otherwise every consistent change
      // would straddle it, and nothing could ever move them.
      const propertyOwned = to.owned === true || (to.owned !== undefined && Object.hasOwn(to.owned, link.viaProperty))
      if (Boolean(link.owned) !== propertyOwned) {
        throw new Error(
          `link "${name}" and its viaProperty ${link.to}.${link.viaProperty} sit on opposite sides of the ` +
            'authority line — one fact cannot have two owners',
        )
      }
    }
  }
  for (const [name, action] of Object.entries(def.actions)) {
    if (isTargeted(action) && !Object.hasOwn(def.objects, action.object)) {
      throw new Error(`action "${name}" references unknown object type "${action.object}"`)
    }
  }
  return def
}

// ───────────────────────────── Write-back ─────────────────────────────

/**
 * Propagates an action's edits toward the systems of record.
 *
 * The pattern leaves the consistency mechanism between the ontology and the
 * systems of record implementation-defined, but requires it to be declared.
 * This implementation declares write-back-first ordering (mirroring Foundry's
 * write-back webhooks): the adapter runs BEFORE the edits are committed to
 * the ontology store. If the adapter throws, no ontology changes are applied.
 * The reverse failure — adapter succeeded, local commit fails — remains
 * possible; see "Failure semantics" in the README.
 */
export interface WritebackAdapter {
  name: string
  apply(edits: Edit[], meta: { action: string; actor: string }): void
}

// ───────────────────────────── Runtime ─────────────────────────────

/** Internal: a Violation surfacing through plan classification. */
class PlanViolation extends Error {
  constructor(readonly violation: Violation) {
    super(violation.message)
  }
}

/** Internal: the sentinel that rolls a preflight transaction back. */
class Rollback extends Error {}

const editErrorMessage = (e: unknown): string =>
  e instanceof z.ZodError
    ? `${e.issues[0]?.path.join('.') || 'edit'}: ${e.issues[0]?.message ?? 'invalid'}`
    : e instanceof Error
      ? e.message
      : String(e)

export type ActionResult = { ok: true; edits: Edit[] } | { ok: false; error: Violation }

export interface AuditEntry {
  seq: number
  ts: string
  actor: string
  action: string
  target: string
  params: Record<string, unknown>
  status: 'applied' | 'rejected'
  error: Violation | null
  edits: Edit[] | null
}

export interface AggregateOptions<O> {
  filter?: Partial<O> | ((o: O) => boolean)
  groupBy: (o: O) => string
  sum?: (o: O) => number
}

/**
 * The ontology's own store — object state, user edits, and the audit log —
 * separate from the source systems it was indexed from. A read-only layer
 * could stay virtual; a layer that accepts writes has to own state
 * (edits exist here before, or instead of, the systems of record).
 */
export class Runtime {
  readonly ontology: OntologyDef
  readonly #db: Database
  readonly #writeback?: WritebackAdapter
  readonly #schemas = new Map<string, z.ZodObject<Properties>>()

  constructor(ontology: OntologyDef, db: Database, opts: { writeback?: WritebackAdapter } = {}) {
    this.ontology = ontology
    this.#db = db
    this.#writeback = opts.writeback
    for (const [name, obj] of Object.entries(ontology.objects)) {
      this.#schemas.set(name, z.object(obj.properties))
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        type TEXT NOT NULL, pk TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (type, pk)
      );
      CREATE TABLE IF NOT EXISTS links (
        name TEXT NOT NULL, from_pk TEXT NOT NULL, to_pk TEXT NOT NULL,
        PRIMARY KEY (name, from_pk, to_pk)
      );
      -- The edit layer for ontology-owned properties on source-backed rows:
      -- the current effective patch per object, reapplied over a re-indexed
      -- base. Ontology-owned types and links need no overlay — load() cannot
      -- touch them, so they survive in place.
      CREATE TABLE IF NOT EXISTS overlay (
        type TEXT NOT NULL, pk TEXT NOT NULL, patch TEXT NOT NULL,
        PRIMARY KEY (type, pk)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, params TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
        error TEXT, edits TEXT
      );
    `)
  }

  // ── Indexing (the data-layer hand-off) ──

  /**
   * Load a snapshot of integrated physical data into the ontology store.
   * This is the stand-in for the indexing pipeline (Funnel's job in Foundry).
   * It is an infrastructure entry point, not a user write path — user writes
   * go through `execute`.
   *
   * Snapshot semantics, per loaded type: replace the base, reapply the edit
   * layer. A source snapshot speaks only for source-backed state: rows of an
   * ontology-owned type, instances of an ontology-owned link, and values for
   * ontology-owned properties are all refused — the source has no authority
   * over them. Owned properties start at their declared defaults and get the
   * overlay's current patch reapplied on top; owned types and links are
   * simply left alone. An overlay patch whose base row disappeared refuses
   * the whole load (state the ontology owns must not be dropped silently) —
   * clear the edit or restore the row, then re-load. The result must satisfy
   * the model's constraints, the same as edits.
   */
  load(snapshot: {
    objects?: Record<string, Record<string, unknown>[]>
    links?: Record<string, Array<[from: string, to: string]>>
  }): void {
    const insertObject = this.#db.prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
    const insertLink = this.#db.prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
    this.#db.transaction(() => {
      for (const [type, rows] of Object.entries(snapshot.objects ?? {})) {
        const def = this.ontology.objects[type]
        const schema = this.#schemas.get(type)
        if (!def || !schema) throw new Error(`unknown object type "${type}"`)
        if (def.owned === true) {
          throw new Error(`cannot load "${type}": the type is ontology-owned — no source supplies its rows`)
        }
        const defaults = def.owned ?? {}
        this.#db.prepare('DELETE FROM objects WHERE type = ?').run(type)
        for (const row of rows) {
          // The same strictness as edits, for the same reason: a silently
          // stripped key is an integration bug travelling without a trace.
          const unknown = Object.keys(row).filter((key) => !Object.hasOwn(def.properties, key))
          if (unknown.length > 0) {
            throw new Error(
              `invalid ${type} row: unknown propert${unknown.length > 1 ? 'ies' : 'y'} "${unknown.join('", "')}"`,
            )
          }
          for (const key of Object.keys(defaults)) {
            if (Object.hasOwn(row, key)) {
              throw new Error(`invalid ${type} row: property "${key}" is ontology-owned — a source cannot supply it`)
            }
          }
          const parsed = schema.safeParse({ ...row, ...defaults })
          if (!parsed.success) {
            throw new Error(`invalid ${type} row: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
          }
          insertObject.run(type, String(parsed.data[def.primaryKey]), JSON.stringify(parsed.data))
        }
        this.#reapplyOverlay(type)
      }
      for (const [name, pairs] of Object.entries(snapshot.links ?? {})) {
        const link = Object.hasOwn(this.ontology.links, name) ? this.ontology.links[name] : undefined
        if (!link) throw new Error(`unknown link type "${name}"`)
        if (link.owned) {
          throw new Error(`cannot load link "${name}": the link type is ontology-owned — no source supplies its instances`)
        }
        this.#db.prepare('DELETE FROM links WHERE name = ?').run(name)
        for (const [from, to] of pairs) insertLink.run(name, from, to)
      }
      this.#validateLinks()
      this.#validateViaProperties()
    })()
  }

  /**
   * Reapply the edit layer over a freshly indexed base. Refusals here roll
   * back the whole load: an orphaned patch means the source dropped a row
   * the ontology still holds owned state for — a reconciliation decision the
   * runtime must not make silently.
   */
  #reapplyOverlay(type: string): void {
    const def = this.ontology.objects[type]!
    const schema = this.#schemas.get(type)!
    const ownedKeys = def.owned && def.owned !== true ? Object.keys(def.owned) : []
    const rows = this.#db.prepare('SELECT pk, patch FROM overlay WHERE type = ?').all(type) as Array<{
      pk: string
      patch: string
    }>
    for (const { pk, patch } of rows) {
      const changes = JSON.parse(patch) as Record<string, unknown>
      const stale = Object.keys(changes).filter((key) => !ownedKeys.includes(key))
      if (stale.length > 0) {
        throw new Error(
          `overlay for ${type}/${pk} carries "${stale.join('", "')}" which the model no longer declares ontology-owned`,
        )
      }
      const base = this.#fetch<Record<string, unknown>>(type, pk)
      if (!base) {
        throw new Error(
          `re-index conflict: ${type}/${pk} carries ontology-owned edits (${Object.keys(changes).join(', ')}) ` +
            'but the re-indexed base no longer has the row — clear the edit or restore the row, then re-load',
        )
      }
      const merged = schema.parse({ ...base, ...changes })
      this.#db
        .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
        .run(JSON.stringify(merged), type, pk)
    }
  }

  // ── Read side: query the model, not the tables — and always as someone ──

  get<O = Record<string, unknown>>(type: string, pk: string, opts: { actor: string }): O | undefined {
    const object = this.#fetch<O>(type, pk)
    if (object === undefined) return undefined
    // A hidden object is indistinguishable from a nonexistent one.
    return this.#visible(type, object as Record<string, unknown>, opts.actor) ? object : undefined
  }

  search<O = Record<string, unknown>>(
    type: string,
    opts: { actor: string; filter?: Partial<O> | ((o: O) => boolean) },
  ): O[] {
    this.#objectDef(type)
    const rows = this.#db.prepare('SELECT data FROM objects WHERE type = ? ORDER BY pk').all(type) as {
      data: string
    }[]
    return rows
      .map((r) => JSON.parse(r.data) as O)
      .filter((o) => this.#visible(type, o as Record<string, unknown>, opts.actor))
      .filter(matcher(opts.filter))
  }

  /** Follow a link from one object to its neighbours. Both directions are traversable. */
  traverse<O = Record<string, unknown>>(
    linkName: string,
    pk: string,
    opts: { actor: string; direction?: 'forward' | 'reverse' },
  ): O[] {
    const link = Object.hasOwn(this.ontology.links, linkName) ? this.ontology.links[linkName] : undefined
    if (!link) throw new Error(`unknown link type "${linkName}"`)
    const [where, select, targetType, originType] =
      (opts.direction ?? 'forward') === 'forward'
        ? ['from_pk', 'to_pk', link.to, link.from]
        : ['to_pk', 'from_pk', link.from, link.to]
    // A hidden origin leaks nothing: traversal from an object the actor
    // cannot see behaves exactly like traversal from a missing one.
    if (!this.get(originType, pk, { actor: opts.actor })) return []
    const rows = this.#db
      .prepare(`SELECT ${select} AS pk FROM links WHERE name = ? AND ${where} = ? ORDER BY pk`)
      .all(linkName, pk) as { pk: string }[]
    return rows
      .map((r) => this.get<O>(targetType, r.pk, { actor: opts.actor }))
      .filter((o): o is O => o !== undefined)
  }

  /** Query-time aggregation over the indexed objects. Nothing is precomputed. */
  aggregate<O = Record<string, unknown>>(
    type: string,
    opts: { actor: string } & AggregateOptions<O>,
  ): Record<string, { count: number; sum?: number }> {
    // Accumulate in a Map: group keys are data, and data named "__proto__"
    // must not walk — let alone pollute — the prototype chain.
    const out = new Map<string, { count: number; sum?: number }>()
    for (const obj of this.search<O>(type, { actor: opts.actor, filter: opts.filter })) {
      const key = opts.groupBy(obj)
      let bucket = out.get(key)
      if (!bucket) {
        bucket = { count: 0, ...(opts.sum ? { sum: 0 } : {}) }
        out.set(key, bucket)
      }
      bucket.count += 1
      if (opts.sum) bucket.sum = (bucket.sum ?? 0) + opts.sum(obj)
    }
    return Object.fromEntries(out)
  }

  // ── Write side: there is exactly one door ──

  /**
   * Execute an action. This is the only way state changes:
   * validate params → load target (if the action has one) → preconditions →
   * effects → validate the edit plan (model checks, the authority line, and
   * a dry run of the commit) → write-back (if declared) →
   * atomically commit edits + audit entry.
   */
  execute(actionName: string, params: Record<string, unknown>, opts: { actor: string }): ActionResult {
    // Every attempt is audited — including the ones that never reach the model.
    const refuseAs = (
      target: string,
      auditParams: Record<string, unknown>,
      error: Violation,
      edits?: Edit[],
    ): ActionResult => {
      this.#audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: auditParams,
        status: 'rejected',
        error,
        edits,
      })
      return { ok: false, error }
    }

    const action = Object.hasOwn(this.ontology.actions, actionName)
      ? this.ontology.actions[actionName]
      : undefined
    if (!action) {
      return refuseAs('(unknown action)', params, reject('UNKNOWN_ACTION', `no action named "${actionName}"`))
    }

    const parsed = z.object(action.params).safeParse(params)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const guessed = isTargeted(action) ? params[action.targetParam] : undefined
      const target = isTargeted(action)
        ? `${action.object}/${guessed != null ? String(guessed) : '(invalid)'}`
        : '(targetless)'
      return refuseAs(
        target,
        params,
        reject('INVALID_PARAMS', `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`),
      )
    }

    const target = isTargeted(action)
      ? `${action.object}/${String(parsed.data[action.targetParam])}`
      : '(targetless)'
    const refuse = (error: Violation, edits?: Edit[]): ActionResult => refuseAs(target, parsed.data, error, edits)

    // Crashes are attempts too, and they are audited with a code that says
    // where they happened: READ_FAILED for storage faults, RULE_CRASHED for
    // model code (visibility, preconditions, effects) that threw.
    const crashedAs = (code: string, e: unknown): never => {
      this.#audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: parsed.data,
        status: 'rejected',
        error: reject(code, e instanceof Error ? e.message : String(e)),
      })
      throw e
    }

    let ctx: ActionCtx | TargetlessActionCtx
    if (isTargeted(action)) {
      const pk = String(parsed.data[action.targetParam])
      let object: Record<string, unknown> | undefined
      try {
        object = this.#fetch(action.object, pk)
      } catch (e) {
        crashedAs('READ_FAILED', e)
      }
      if (object !== undefined) {
        try {
          // Visibility gates action targets too: an object the actor cannot see
          // is TARGET_NOT_FOUND — same as a missing one, so existence never leaks.
          if (!this.#visible(action.object, object, opts.actor)) object = undefined
        } catch (e) {
          crashedAs('RULE_CRASHED', e)
        }
      }
      if (!object) return refuse(reject('TARGET_NOT_FOUND', `${target} does not exist`))
      ctx = { object, params: parsed.data, actor: opts.actor }
    } else {
      ctx = { params: parsed.data, actor: opts.actor }
    }

    let edits: Edit[] = []
    try {
      for (const precondition of action.preconditions) {
        const violation = precondition(ctx as ActionCtx)
        if (violation) return refuse(violation)
      }
      edits = action.effects(ctx as ActionCtx)
    } catch (e) {
      crashedAs('RULE_CRASHED', e)
    }

    // Statically invalid edits are refused before anything leaves this
    // process — the write-back adapter never sees an edit plan the model can
    // already prove wrong.
    try {
      this.#validateEdits(edits)
    } catch (e) {
      return refuse(reject('INVALID_EDITS', editErrorMessage(e)))
    }

    // The authority line. `writeback` is the action's declared side of it,
    // and the declaration is checked against what the plan actually touches:
    // an undeclared write to source-backed state is exactly the shadow copy
    // the fourth property forbids, whatever the action is named.
    try {
      const authorities = new Set(edits.map((e) => this.#editAuthority(e)).filter((a) => a !== null))
      if (authorities.size > 1) {
        return refuse(
          reject(
            'MIXED_AUTHORITY',
            'the edit plan changes both source-backed and ontology-owned state — ' +
              'v0.1 routes a plan whole, so split the action along the authority line',
          ),
        )
      }
      const authority = authorities.values().next().value
      if (authority === 'source' && !action.writeback) {
        return refuse(
          reject(
            'UNDECLARED_SOURCE_WRITE',
            'the edit plan changes source-backed state but the action does not declare `writeback: true` — ' +
              'a local change to source truth that never travels home is a shadow copy',
          ),
        )
      }
      if (authority === 'ontology' && action.writeback) {
        return refuse(
          reject(
            'MISDECLARED_WRITEBACK',
            'the action declares `writeback: true` but the edit plan changes only ontology-owned state — ' +
              'nothing in it belongs to a source',
          ),
        )
      }
    } catch (e) {
      if (e instanceof PlanViolation) return refuse(e.violation)
      throw e
    }

    // Dry-run the commit before anything leaves this process: the same code
    // that will apply the plan applies it inside a transaction that is
    // always rolled back. Everything the commit would check — link
    // endpoints, cardinality, delete restrictions, merged schemas — is
    // checked here first, so the write-back adapter never sees a plan the
    // ontology store would refuse. (Single-writer, synchronous: nothing can
    // change between this dry run and the commit below.)
    try {
      this.#preflight(edits)
    } catch (e) {
      return refuse(reject('INVALID_EDITS', editErrorMessage(e)))
    }

    // An empty plan changes nothing, so there is nothing to write back —
    // the attempt still commits an audit entry below.
    if (action.writeback && edits.length > 0) {
      if (!this.#writeback) {
        return refuse(reject('NO_WRITEBACK_ADAPTER', 'action requires write-back but no adapter is configured'))
      }
      try {
        // Write-back first: if the system of record refuses, nothing changes
        // here. The adapter gets its own copy of the plan: what commits below
        // is the plan that was validated, not whatever the adapter left
        // behind on a shared reference.
        this.#writeback.apply(structuredClone(edits), { action: actionName, actor: opts.actor })
      } catch (e) {
        // The adapter may have partially applied the plan before throwing —
        // source-side atomicity is the adapter's contract, not this
        // runtime's. The full plan goes on the record as the raw material
        // for reconciliation.
        return refuse(reject('WRITEBACK_FAILED', e instanceof Error ? e.message : String(e)), edits)
      }
    }

    // Edits and their audit entry commit together or not at all.
    try {
      this.#db.transaction(() => {
        this.#applyEdits(edits)
        this.#audit({ actor: opts.actor, action: actionName, target, params: parsed.data, status: 'applied', edits })
      })()
    } catch (e) {
      // The transaction rolled back (its audit entry included) — record the
      // crashed attempt outside it, then surface the error.
      this.#audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: parsed.data,
        status: 'rejected',
        error: reject('COMMIT_FAILED', e instanceof Error ? e.message : String(e)),
        // The edits are on the record even though they did not apply: after a
        // write-back-first action, they are what already reached the source.
        edits,
      })
      throw e
    }

    return { ok: true, edits }
  }

  auditLog(filter: { action?: string; status?: 'applied' | 'rejected'; target?: string } = {}): AuditEntry[] {
    const rows = this.#db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<{
      seq: number
      ts: string
      actor: string
      action: string
      target: string
      params: string
      status: 'applied' | 'rejected'
      error: string | null
      edits: string | null
    }>
    return rows
      .map((r) => ({
        ...r,
        params: JSON.parse(r.params) as Record<string, unknown>,
        error: r.error ? (JSON.parse(r.error) as Violation) : null,
        edits: r.edits ? (JSON.parse(r.edits) as Edit[]) : null,
      }))
      .filter(
        (e) =>
          (!filter.action || e.action === filter.action) &&
          (!filter.status || e.status === filter.status) &&
          (!filter.target || e.target === filter.target),
      )
  }

  // ── Private: the only code that touches object state ──

  #objectDef(type: string): ObjectTypeDef {
    const def = Object.hasOwn(this.ontology.objects, type) ? this.ontology.objects[type] : undefined
    if (!def) throw new Error(`unknown object type "${type}"`)
    return def
  }

  /**
   * Model-only validation of an edit plan — everything provable without
   * reading current state. DB-dependent checks (merged-object schemas, link
   * endpoints, cardinality, delete restrictions) live in #applyEdits, which
   * the preflight dry-runs before write-back and the commit runs for real.
   */
  #validateEdits(edits: Edit[]): void {
    for (const edit of edits) {
      if (edit.op === 'link' || edit.op === 'unlink') {
        if (!Object.hasOwn(this.ontology.links, edit.link)) throw new Error(`unknown link type "${edit.link}"`)
        continue
      }
      const def = this.#objectDef(edit.object)
      const schema = this.#schemas.get(edit.object)!
      if (edit.op === 'create' || edit.op === 'modify') {
        // Unknown keys are refused, not silently stripped: a stripped key
        // would still travel to the write-back adapter in the raw edit and
        // let source and store diverge without a trace.
        const payload = edit.op === 'create' ? edit.data : edit.changes
        // Object.hasOwn, not `in`: prototype names (toString, __proto__, …) must
        // not masquerade as model properties.
        const unknown = Object.keys(payload).filter((key) => !Object.hasOwn(def.properties, key))
        if (unknown.length > 0) {
          throw new Error(`unknown propert${unknown.length > 1 ? 'ies' : 'y'} "${unknown.join('", "')}" on ${edit.object}`)
        }
      }
      if (edit.op === 'create') {
        const data = schema.parse(edit.data)
        if (String(data[def.primaryKey]) !== edit.pk) {
          throw new Error(
            `create pk mismatch for ${edit.object}: edit says "${edit.pk}", data says "${String(data[def.primaryKey])}"`,
          )
        }
      } else if (edit.op === 'modify') {
        if (Object.hasOwn(edit.changes, def.primaryKey) && edit.changes[def.primaryKey] !== edit.pk) {
          throw new Error(`cannot modify the primary key of ${edit.object}/${edit.pk}`)
        }
        schema.partial().parse(edit.changes)
      }
    }
  }

  /**
   * Which side of the authority line an edit falls on, per the model's
   * `owned` declarations. `null` for a no-op modify. Throws PlanViolation
   * for an edit no side can legally hold.
   */
  #editAuthority(edit: Edit): 'source' | 'ontology' | null {
    if (edit.op === 'link' || edit.op === 'unlink') {
      return this.ontology.links[edit.link]?.owned ? 'ontology' : 'source'
    }
    const def = this.#objectDef(edit.object)
    if (def.owned === true) return 'ontology'
    if (edit.op === 'create') {
      throw new PlanViolation(
        reject(
          'SOURCE_CREATE_UNSUPPORTED',
          `cannot create ${edit.object}/${edit.pk}: the type is source-backed, and v0.1 supports creation ` +
            'for ontology-owned types only — creating at the source is undemonstrated, so undeclared',
        ),
      )
    }
    if (edit.op === 'delete') return 'source'
    const ownedKeys = def.owned ? Object.keys(def.owned) : []
    const touched = Object.keys(edit.changes)
    if (touched.length === 0) return null
    const owned = touched.filter((key) => ownedKeys.includes(key))
    if (owned.length === 0) return 'source'
    if (owned.length === touched.length) return 'ontology'
    throw new PlanViolation(
      reject(
        'MIXED_AUTHORITY',
        `edit on ${edit.object}/${edit.pk} changes source-backed and ontology-owned properties together — split it`,
      ),
    )
  }

  /**
   * The dry run behind the write-back guarantee: the exact code that will
   * commit the plan applies it inside a transaction that always rolls back.
   * No second validator to drift out of sync with the real one.
   */
  #preflight(edits: Edit[]): void {
    try {
      this.#db.transaction(() => {
        this.#applyEdits(edits)
        throw new Rollback('preflight')
      })()
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
  }

  /** Raw fetch without visibility — for internal integrity checks only. */
  #fetch<O = Record<string, unknown>>(type: string, pk: string): O | undefined {
    this.#objectDef(type)
    const row = this.#db
      .prepare('SELECT data FROM objects WHERE type = ? AND pk = ?')
      .get(type, pk) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as O) : undefined
  }

  #visible(type: string, object: Record<string, unknown>, actor: string): boolean {
    const visibility = this.ontology.objects[type]?.visibility
    return visibility ? visibility({ object, actor }) : true
  }

  #applyEdits(edits: Edit[]): void {
    for (const edit of edits) {
      if (edit.op === 'link' || edit.op === 'unlink') {
        const linkDef = this.ontology.links[edit.link]
        if (!linkDef) throw new Error(`unknown link type "${edit.link}"`)
        if (edit.op === 'link') {
          // A link is a statement about two objects — both endpoints must exist.
          if (!this.#fetch(linkDef.from, edit.from))
            throw new Error(`cannot link: ${linkDef.from}/${edit.from} does not exist`)
          if (!this.#fetch(linkDef.to, edit.to))
            throw new Error(`cannot link: ${linkDef.to}/${edit.to} does not exist`)
          if (linkDef.kind === 'one-to-many') {
            const existing = this.#db
              .prepare('SELECT from_pk FROM links WHERE name = ? AND to_pk = ? AND from_pk != ?')
              .get(edit.link, edit.to, edit.from) as { from_pk: string } | undefined
            if (existing)
              throw new Error(
                `cannot link: ${linkDef.to}/${edit.to} is already linked to ` +
                  `${linkDef.from}/${existing.from_pk} via "${edit.link}" (one-to-many — unlink first)`,
              )
          }
          this.#db
            .prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
            .run(edit.link, edit.from, edit.to)
        } else {
          this.#db
            .prepare('DELETE FROM links WHERE name = ? AND from_pk = ? AND to_pk = ?')
            .run(edit.link, edit.from, edit.to)
        }
        continue
      }
      const def = this.#objectDef(edit.object)
      const schema = this.#schemas.get(edit.object)!
      if (edit.op === 'modify') {
        if (Object.hasOwn(edit.changes, def.primaryKey) && edit.changes[def.primaryKey] !== edit.pk) {
          throw new Error(`cannot modify the primary key of ${edit.object}/${edit.pk}`)
        }
        const current = this.#fetch(edit.object, edit.pk)
        if (!current) throw new Error(`cannot modify missing object ${edit.object}/${edit.pk}`)
        const next = schema.parse({ ...current, ...edit.changes })
        this.#db
          .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
          .run(JSON.stringify(next), edit.object, edit.pk)
        // Ontology-owned changes on a source-backed row also land in the
        // overlay — the layer load() reapplies over a re-indexed base. A
        // value back at its declared default is pruned, so clearing an edit
        // clears the survival obligation with it.
        if (def.owned && def.owned !== true && this.#editAuthority(edit) === 'ontology') {
          const row = this.#db
            .prepare('SELECT patch FROM overlay WHERE type = ? AND pk = ?')
            .get(edit.object, edit.pk) as { patch: string } | undefined
          const patch: Record<string, unknown> = { ...(row ? JSON.parse(row.patch) : {}), ...edit.changes }
          for (const [key, fallback] of Object.entries(def.owned)) {
            if (Object.hasOwn(patch, key) && JSON.stringify(patch[key]) === JSON.stringify(fallback)) {
              delete patch[key]
            }
          }
          if (Object.keys(patch).length === 0) {
            this.#db.prepare('DELETE FROM overlay WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
          } else {
            this.#db
              .prepare('INSERT OR REPLACE INTO overlay (type, pk, patch) VALUES (?, ?, ?)')
              .run(edit.object, edit.pk, JSON.stringify(patch))
          }
        }
      } else if (edit.op === 'create') {
        const data = schema.parse(edit.data)
        if (String(data[def.primaryKey]) !== edit.pk) {
          throw new Error(
            `create pk mismatch for ${edit.object}: edit says "${edit.pk}", data says "${String(data[def.primaryKey])}"`,
          )
        }
        this.#db
          .prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
          .run(edit.object, edit.pk, JSON.stringify(data))
      } else {
        // RESTRICT: an object with links still attached refuses to die — unlink first.
        for (const [name, link] of Object.entries(this.ontology.links)) {
          const columns = [
            ...(link.from === edit.object ? ['from_pk'] : []),
            ...(link.to === edit.object ? ['to_pk'] : []),
          ]
          for (const column of columns) {
            const { n } = this.#db
              .prepare(`SELECT COUNT(*) AS n FROM links WHERE name = ? AND ${column} = ?`)
              .get(name, edit.pk) as { n: number }
            if (n > 0) {
              throw new Error(
                `cannot delete ${edit.object}/${edit.pk}: ${n} "${name}" link(s) attached — unlink first`,
              )
            }
          }
        }
        this.#db.prepare('DELETE FROM objects WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
        // The row's owned state goes with the row — a later re-index of the
        // type must not resurrect an orphaned patch.
        this.#db.prepare('DELETE FROM overlay WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
      }
    }
    this.#validateViaProperties()
  }

  /** The indexed snapshot must satisfy the model's constraints, same as edits do. */
  #validateLinks(): void {
    for (const [name, link] of Object.entries(this.ontology.links)) {
      const rows = this.#db
        .prepare('SELECT from_pk, to_pk FROM links WHERE name = ?')
        .all(name) as Array<{ from_pk: string; to_pk: string }>
      const parentOf = new Map<string, string>()
      for (const { from_pk, to_pk } of rows) {
        if (!this.#fetch(link.from, from_pk))
          throw new Error(`link "${name}": ${link.from}/${from_pk} does not exist`)
        if (!this.#fetch(link.to, to_pk))
          throw new Error(`link "${name}": ${link.to}/${to_pk} does not exist`)
        if (link.kind === 'one-to-many') {
          const previous = parentOf.get(to_pk)
          if (previous !== undefined && previous !== from_pk) {
            throw new Error(
              `link "${name}": ${link.to}/${to_pk} is linked to more than one ${link.from} (one-to-many)`,
            )
          }
          parentOf.set(to_pk, from_pk)
        }
      }
    }
  }

  /**
   * A link with a viaProperty and its foreign-key property twin are two
   * representations of one fact, and they must agree — after indexing and
   * after every edit plan. Full scan by declaration: keeping this fast is
   * indexing infrastructure, which is an implementation concern, not part
   * of the pattern.
   */
  #validateViaProperties(): void {
    for (const [name, link] of Object.entries(this.ontology.links)) {
      if (!link.viaProperty) continue
      const parentOf = new Map<string, string>()
      const linkRows = this.#db
        .prepare('SELECT from_pk, to_pk FROM links WHERE name = ?')
        .all(name) as Array<{ from_pk: string; to_pk: string }>
      for (const { from_pk, to_pk } of linkRows) parentOf.set(to_pk, from_pk)
      const objectRows = this.#db
        .prepare('SELECT pk, data FROM objects WHERE type = ?')
        .all(link.to) as Array<{ pk: string; data: string }>
      for (const { pk, data } of objectRows) {
        const raw = (JSON.parse(data) as Record<string, unknown>)[link.viaProperty]
        const value = raw == null ? null : String(raw)
        const linked = parentOf.get(pk) ?? null
        if (value !== linked) {
          throw new Error(
            `link "${name}" disagrees with ${link.to}.${link.viaProperty} for ${link.to}/${pk}: ` +
              `the property says ${value === null ? 'none' : `"${value}"`}, ` +
              `the links say ${linked === null ? 'none' : `"${linked}"`}`,
          )
        }
      }
    }
  }

  #audit(entry: {
    actor: string
    action: string
    target: string
    params: Record<string, unknown>
    status: 'applied' | 'rejected'
    error?: Violation
    edits?: Edit[]
  }): void {
    this.#db
      .prepare(
        `INSERT INTO audit_log (ts, actor, action, target, params, status, error, edits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.actor,
        entry.action,
        entry.target,
        JSON.stringify(entry.params),
        entry.status,
        entry.error ? JSON.stringify(entry.error) : null,
        entry.edits ? JSON.stringify(entry.edits) : null,
      )
  }
}

export function createRuntime(
  ontology: OntologyDef,
  db: Database,
  opts: { writeback?: WritebackAdapter } = {},
): Runtime {
  return new Runtime(ontology, db, opts)
}

function matcher<O>(filter?: Partial<O> | ((o: O) => boolean)): (o: O) => boolean {
  if (!filter) return () => true
  if (typeof filter === 'function') return filter as (o: O) => boolean
  const entries = Object.entries(filter)
  return (o: O) => entries.every(([k, v]) => (o as Record<string, unknown>)[k] === v)
}
