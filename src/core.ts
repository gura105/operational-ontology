/**
 * operational-ontology · core
 *
 * The definition layer (the model as data) and the runtime that makes it
 * operational:
 *
 *   - objects & links are indexed from existing physical data (read side)
 *   - every write goes through an action: preconditions → effects → audit log
 *   - there is no other write path
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
  if (!(def.primaryKey in def.properties)) {
    throw new Error(`primaryKey "${def.primaryKey}" is not one of the defined properties`)
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
  /** Physical origin of the link (a foreign key, a join table) — documentation only. */
  via?: string
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
  /** The changes this action makes, described as data. */
  effects: (ctx: ActionCtx<any, any>) => Edit[]
  /**
   * Route this action's edits through the write-back adapter before they are
   * committed to the ontology store. See `WritebackAdapter`.
   */
  writeback?: boolean
}

export function defineAction<S extends Properties>(def: ActionDef<S>): ActionDef<S> {
  if (!(def.targetParam in def.params)) {
    throw new Error(`targetParam "${def.targetParam}" is not one of the action's params`)
  }
  return def
}

export interface OntologyDef {
  name: string
  objects: Record<string, ObjectTypeDef<any>>
  links: Record<string, LinkTypeDef>
  actions: Record<string, ActionDef<any>>
}

export function defineOntology(def: OntologyDef): OntologyDef {
  for (const [name, link] of Object.entries(def.links)) {
    for (const end of [link.from, link.to]) {
      if (!(end in def.objects)) {
        throw new Error(`link "${name}" references unknown object type "${end}"`)
      }
    }
  }
  for (const [name, action] of Object.entries(def.actions)) {
    if (!(action.object in def.objects)) {
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
   * Caveat (v0 simplification): re-loading replaces base rows and thereby
   * overwrites prior action edits. Foundry keeps edits in their own layer and
   * reapplies them over the re-indexed base — see "Failure semantics" in the
   * README.
   */
  load(snapshot: {
    objects?: Record<string, Record<string, unknown>[]>
    links?: Record<string, Array<[from: string, to: string]>>
  }): void {
    const insertObject = this.#db.prepare(
      'INSERT OR REPLACE INTO objects (type, pk, data) VALUES (?, ?, ?)',
    )
    const insertLink = this.#db.prepare(
      'INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)',
    )
    this.#db.transaction(() => {
      for (const [type, rows] of Object.entries(snapshot.objects ?? {})) {
        const def = this.ontology.objects[type]
        const schema = this.#schemas.get(type)
        if (!def || !schema) throw new Error(`unknown object type "${type}"`)
        for (const row of rows) {
          const parsed = schema.safeParse(row)
          if (!parsed.success) {
            throw new Error(`invalid ${type} row: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
          }
          insertObject.run(type, String(parsed.data[def.primaryKey]), JSON.stringify(parsed.data))
        }
      }
      for (const [name, pairs] of Object.entries(snapshot.links ?? {})) {
        if (!(name in this.ontology.links)) throw new Error(`unknown link type "${name}"`)
        for (const [from, to] of pairs) insertLink.run(name, from, to)
      }
    })()
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

  /** Follow a link from one object to its neighbours. Both directions are indexed. */
  traverse<O = Record<string, unknown>>(
    linkName: string,
    pk: string,
    opts: { actor: string; direction?: 'forward' | 'reverse' },
  ): O[] {
    const link = this.ontology.links[linkName]
    if (!link) throw new Error(`unknown link type "${linkName}"`)
    const [where, select, targetType] =
      (opts.direction ?? 'forward') === 'forward'
        ? ['from_pk', 'to_pk', link.to]
        : ['to_pk', 'from_pk', link.from]
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
    const out: Record<string, { count: number; sum?: number }> = {}
    for (const obj of this.search<O>(type, { actor: opts.actor, filter: opts.filter })) {
      const key = opts.groupBy(obj)
      const bucket = (out[key] ??= { count: 0, ...(opts.sum ? { sum: 0 } : {}) })
      bucket.count += 1
      if (opts.sum) bucket.sum = (bucket.sum ?? 0) + opts.sum(obj)
    }
    return out
  }

  // ── Write side: there is exactly one door ──

  /**
   * Execute an action. This is the only way state changes:
   * validate params → load target → preconditions → effects →
   * write-back (if configured) → atomically commit edits + audit entry.
   */
  execute(actionName: string, params: Record<string, unknown>, opts: { actor: string }): ActionResult {
    // Every attempt is audited — including the ones that never reach the model.
    const refuseAs = (target: string, auditParams: Record<string, unknown>, error: Violation): ActionResult => {
      this.#audit({ actor: opts.actor, action: actionName, target, params: auditParams, status: 'rejected', error })
      return { ok: false, error }
    }

    const action = this.ontology.actions[actionName]
    if (!action) {
      return refuseAs('(unknown action)', params, reject('UNKNOWN_ACTION', `no action named "${actionName}"`))
    }

    const parsed = z.object(action.params).safeParse(params)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const guessed = params[action.targetParam]
      return refuseAs(
        `${action.object}/${guessed != null ? String(guessed) : '(invalid)'}`,
        params,
        reject('INVALID_PARAMS', `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`),
      )
    }

    const pk = String(parsed.data[action.targetParam])
    const target = `${action.object}/${pk}`
    const refuse = (error: Violation): ActionResult => refuseAs(target, parsed.data, error)

    // Visibility gates action targets too: an object the actor cannot see is
    // TARGET_NOT_FOUND — same error as a missing one, so existence never leaks.
    const object = this.get(action.object, pk, { actor: opts.actor })
    if (!object) return refuse(reject('TARGET_NOT_FOUND', `${target} does not exist`))

    const ctx: ActionCtx = { object, params: parsed.data, actor: opts.actor }

    for (const precondition of action.preconditions) {
      const violation = precondition(ctx)
      if (violation) return refuse(violation)
    }

    const edits = action.effects(ctx)

    if (action.writeback) {
      if (!this.#writeback) {
        return refuse(reject('NO_WRITEBACK_ADAPTER', 'action requires write-back but no adapter is configured'))
      }
      try {
        // Write-back first: if the system of record refuses, nothing changes here.
        this.#writeback.apply(edits, { action: actionName, actor: opts.actor })
      } catch (e) {
        return refuse(reject('WRITEBACK_FAILED', e instanceof Error ? e.message : String(e)))
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
    const def = this.ontology.objects[type]
    if (!def) throw new Error(`unknown object type "${type}"`)
    return def
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
        const current = this.#fetch(edit.object, edit.pk)
        if (!current) throw new Error(`cannot modify missing object ${edit.object}/${edit.pk}`)
        const next = schema.parse({ ...current, ...edit.changes })
        this.#db
          .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
          .run(JSON.stringify(next), edit.object, edit.pk)
      } else if (edit.op === 'create') {
        const data = schema.parse(edit.data)
        this.#db
          .prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
          .run(edit.object, String(data[def.primaryKey]), JSON.stringify(data))
      } else {
        this.#db.prepare('DELETE FROM objects WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
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
