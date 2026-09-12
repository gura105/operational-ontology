/**
 * operational-ontology · core
 *
 * The runtime that interprets the definitions in model.ts:
 *
 *   - objects & links are indexed from existing physical data (read side)
 *   - every write goes through an action: preconditions → effects → audit log
 *   - the API exposes no other write path — a contract on the API, not a
 *     privilege boundary against code holding the database handle (declared;
 *     see "Transaction ownership" in IMPLEMENTATION.md)
 *   - authority is declared in the model: source-backed state comes from the
 *     sources and write-back governs its changes; ontology-owned state lives
 *     here, needs no write-back, and survives re-indexing
 *
 * The ontology definition is a plain value, not a class hierarchy. The
 * runtime interprets it — which is what lets `mcp.ts` enumerate it and expose
 * the same model, guarded by the same rules, to AI agents.
 *
 * Vocabulary: model.ts defines the schema side of the model; the
 * store holds the instance side — object state, link instances, and the
 * audit log, where one entry is one attempted action.
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Database } from 'better-sqlite3'

import { isPlainJson, reject } from './model.js'
import type {
  ActionCtx, ActionDef, ActionName, Edit, ObjectFilter, ObjectInstance, ObjectName,
  ObjectOf, ObjectTypeDef, OntologyDef, ParamsOf, Properties, LinkName, LinksFrom, LinkTarget,
  TraverseOptions, Violation,
} from './model.js'
export * from './model.js'

// ───────────────────────────── Write-back ─────────────────────────────

/**
 * Propagates an action's edits toward the systems of record, running BEFORE
 * the local commit — write-back-first, the declared failure semantics (see
 * "Failure semantics" in the README). The adapter speaks to the systems of
 * record and to nothing else; that boundary is a declared contract, not an
 * enforced one (see "Transaction ownership" in IMPLEMENTATION.md). It
 * receives its own copies of the plan and the target object, so nothing it
 * mutates leaks back into the runtime.
 */
export interface WritebackAdapter {
  apply(
    edits: Edit[],
    meta: {
      action: string
      actor: string
      /** The action's target, as the runtime loaded it — routing material. */
      target: ObjectInstance
    },
  ): void
}

// ───────────────────────────── Runtime ─────────────────────────────

/** Internal: the sentinel that rolls a preflight transaction back. */
class Rollback extends Error {}

const editErrorMessage = (e: unknown): string =>
  e instanceof z.ZodError
    ? `${e.issues[0]?.path.join('.') || 'edit'}: ${e.issues[0]?.message ?? 'invalid'}`
    : e instanceof Error
      ? e.message
      : String(e)

export type ActionResult = { ok: true; edits: Edit[] } | { ok: false; error: Violation }

/**
 * One attempted action, applied or rejected — the instance to an ActionDef's
 * type. Its identity is the occurrence, not the arguments: the same params
 * submitted twice are two entries. That is why the log only appends.
 */
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

export interface AggregateOptions<O extends ObjectInstance> {
  filter?: ObjectFilter<O>
  groupBy: (o: O) => string
  sum?: (o: O) => number
}

/**
 * The four answers this implementation declares, as one enumerable value —
 * the same move the model makes: a declaration you can read at runtime, not
 * prose you have to trust. Authority is the model's half of the bargain
 * (`owned`, `writeback`, checked per edit plan); the other three are the
 * runtime's. Each is unpacked in the README and IMPLEMENTATION.md.
 */
export const declarations = {
  authority: 'model-declared-runtime-checked',
  failureSemantics: 'write-back-first',
  reindexing: 'replace-base-reapply-owned-overlay',
  visibilityDefault: 'fail-open',
} as const

/**
 * The ontology's own store — object state, user edits, and the audit log —
 * separate from the source systems it was indexed from. A read-only layer
 * could stay virtual; a layer that accepts writes has to own state
 * (edits exist here before, or instead of, the systems of record).
 */
export class Runtime<T extends OntologyDef = OntologyDef> {
  readonly ontology: T
  readonly declarations = declarations
  readonly #db: Database
  readonly #writeback?: WritebackAdapter
  readonly #schemas = new Map<string, z.ZodObject<Properties>>()

  constructor(ontology: T, db: Database, opts: { writeback?: WritebackAdapter } = {}) {
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
   * Load a snapshot of integrated physical data into the ontology store —
   * the stand-in for the indexing pipeline, an infrastructure entry point
   * rather than a user write path. Semantics, per loaded type: replace the
   * base, reapply the edit layer. A snapshot speaks only for source-backed
   * state, so anything ontology-owned in it is refused, and an overlay
   * patch whose base row disappeared refuses the whole load. Details:
   * "Re-indexing vs edits" in IMPLEMENTATION.md.
   */
  load(snapshot: {
    objects?: { [K in ObjectName<T>]?: Record<string, unknown>[] }
    links?: { [L in LinkName<T>]?: Array<[from: string, to: string]> }
  }): void {
    this.#refuseOpenTransaction('load')
    const insertObject = this.#db.prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
    const insertLink = this.#db.prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
    this.#db.transaction(() => {
      const objectEntries = Object.entries(snapshot.objects ?? {}) as Array<[string, Record<string, unknown>[]]>
      for (const [type, rows] of objectEntries) {
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
          insertObject.run(type, String(parsed.data[def.primaryKey]), this.#storable(type, parsed.data))
        }
        this.#reapplyOverlay(type)
      }
      const linkEntries = Object.entries(snapshot.links ?? {}) as Array<[string, Array<[string, string]>]>
      for (const [name, pairs] of linkEntries) {
        const link = Object.hasOwn(this.ontology.links, name) ? this.ontology.links[name] : undefined
        if (!link) throw new Error(`unknown link type "${name}"`)
        if (link.owned) {
          throw new Error(`cannot load link "${name}": the link type is ontology-owned — no source supplies its instances`)
        }
        this.#db.prepare('DELETE FROM links WHERE name = ?').run(name)
        for (const [from, to] of pairs) insertLink.run(name, from, to)
      }
      this.#validateLinks()
    })()
  }

  /**
   * Reapply the edit layer over a freshly indexed base. Refusals here roll
   * back the whole load: an orphaned patch means the source dropped a row
   * the ontology still holds owned state for — a reconciliation decision the
   * runtime must not make silently. A patch carrying a key the model no
   * longer declares ontology-owned is the schema-evolution twin of the same
   * problem, refused for the same reason.
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
      const base = this.#fetch(type, pk)
      if (!base) {
        throw new Error(
          `re-index conflict: ${type}/${pk} carries ontology-owned edits (${Object.keys(changes).join(', ')}) ` +
            'but the re-indexed base no longer has the row — clear the edit or restore the row, then re-load',
        )
      }
      const merged = schema.parse({ ...base, ...changes })
      this.#db
        .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
        .run(this.#storable(type, merged), type, pk)
    }
  }

  // ── Read side: query the model, not the tables — and always as someone ──

  get<K extends ObjectName<T>>(type: K, pk: string, opts: { actor: string }): ObjectOf<T, K> | undefined {
    return this.#read<ObjectOf<T, K>>(type, pk, opts.actor)
  }

  search<K extends ObjectName<T>>(
    type: K,
    opts: { actor: string; filter?: ObjectFilter<ObjectOf<T, K>> },
  ): ObjectOf<T, K>[] {
    return this.#scan<ObjectOf<T, K>>(type, opts.actor, opts.filter)
  }

  /** Follow a link from an instance. A self-type link needs an explicit direction. */
  // Infer source, then link; later arguments must not widen earlier choices.
  traverse<S extends ObjectName<T>, L extends LinksFrom<T, NoInfer<S>>>(
    source: ObjectOf<T, S>,
    linkName: L,
    opts: TraverseOptions<T, NoInfer<S>, NoInfer<L>>,
  ): ObjectOf<T, LinkTarget<T, S, L>>[] {
    if (
      !source || typeof source.type !== 'string' || typeof source.pk !== 'string' ||
      !source.properties || typeof source.properties !== 'object' || Array.isArray(source.properties)
    ) {
      throw new Error('traverse() requires an object instance with type, pk, and properties')
    }
    const link = Object.hasOwn(this.ontology.links, linkName) ? this.ontology.links[linkName] : undefined
    if (!link) throw new Error(`unknown link type "${linkName}"`)
    const forward = source.type === link.from
    const reverse = source.type === link.to
    if (!forward && !reverse) throw new Error(`link "${linkName}" does not connect "${source.type}"`)
    if (forward && reverse && opts.direction === undefined) {
      throw new Error(`link "${linkName}" requires a direction from "${source.type}"`)
    }
    const direction = opts.direction === undefined ? (forward ? 'forward' : 'reverse') : opts.direction
    if (!((direction === 'forward' && forward) || (direction === 'reverse' && reverse))) {
      throw new Error(`invalid direction "${direction}" for link "${linkName}" from "${source.type}"`)
    }
    const [where, select, targetType] = direction === 'forward'
      ? ['from_pk', 'to_pk', link.to]
      : ['to_pk', 'from_pk', link.from]
    // The input is a snapshot, not authority. Re-read the origin under this actor.
    if (!this.#read(source.type, source.pk, opts.actor)) return []
    const rows = this.#db
      .prepare(`SELECT ${select} AS pk FROM links WHERE name = ? AND ${where} = ? ORDER BY pk`)
      .all(linkName, source.pk) as { pk: string }[]
    return rows
      .map((r) => this.#read<ObjectOf<T, LinkTarget<T, S, L>>>(targetType, r.pk, opts.actor))
      .filter((o) => o !== undefined)
  }

  /** Query-time aggregation over the indexed objects. Nothing is precomputed. */
  aggregate<K extends ObjectName<T>>(
    type: K,
    opts: { actor: string } & AggregateOptions<ObjectOf<T, K>>,
  ): Record<string, { count: number; sum?: number }> {
    // Accumulate in a Map: group keys are data, and data named "__proto__"
    // must not walk — let alone pollute — the prototype chain.
    const out = new Map<string, { count: number; sum?: number }>()
    for (const obj of this.#scan<ObjectOf<T, K>>(type, opts.actor, opts.filter)) {
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

  // ── Write side: there is exactly one door in the API ──

  /**
   * Execute an action. This is the only way the API changes state:
   * validate params → load target → preconditions → effects → dry-run the
   * whole plan through the commit's own code → check the authority
   * declaration → write-back (if declared) → atomically commit edits +
   * audit entry. Validity precedes authority: a plan the store would refuse
   * is INVALID_EDITS, whatever else it is.
   */
  execute<A extends ActionName<T>>(actionName: A, params: ParamsOf<T, A>, opts: { actor: string }): ActionResult {
    this.#refuseOpenTransaction('execute')
    // From here on the params are raw input: the schema, not the type, decides.
    const raw = params as Record<string, unknown>
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

    const action: ActionDef<any, any> | undefined = Object.hasOwn(this.ontology.actions, actionName)
      ? this.ontology.actions[actionName]
      : undefined
    if (!action) {
      return refuseAs('(unknown action)', raw, reject('UNKNOWN_ACTION', `no action named "${actionName}"`))
    }

    const guessTarget = () => {
      const guessed = raw[action.targetParam]
      return `${action.object}/${guessed != null ? String(guessed) : '(invalid)'}`
    }

    // Params are stored verbatim in the audit log, so they must be values
    // the log can hold faithfully — refused here, and still audited (the
    // audit write falls back to a placeholder for what it cannot encode).
    if (!isPlainJson(raw)) {
      return refuseAs(guessTarget(), raw, reject('INVALID_PARAMS', 'params are not plain JSON data'))
    }

    const parsed = z.object(action.params).safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return refuseAs(
        guessTarget(),
        raw,
        reject('INVALID_PARAMS', `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`),
      )
    }

    const pk = String(parsed.data[action.targetParam])
    const target = `${action.object}/${pk}`
    const refuse = (error: Violation, edits?: Edit[]): ActionResult => refuseAs(target, parsed.data, error, edits)

    // Crashes are attempts too — audited as EXECUTION_CRASHED, then the
    // error surfaces to the caller.
    const crashed = (e: unknown): never => {
      this.#audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: parsed.data,
        status: 'rejected',
        error: reject('EXECUTION_CRASHED', e instanceof Error ? e.message : String(e)),
      })
      throw e
    }

    let object: ObjectInstance | undefined
    try {
      // Hidden targets are indistinguishable from missing ones.
      object = this.#read(action.object, pk, opts.actor)
    } catch (e) {
      crashed(e)
    }
    if (!object) return refuse(reject('TARGET_NOT_FOUND', `${target} does not exist`))
    const ctx: ActionCtx = { object, params: parsed.data, actor: opts.actor }

    let edits: Edit[] = []
    try {
      for (const precondition of action.preconditions) {
        const violation = precondition(ctx)
        if (violation) return refuse(violation)
      }
      edits = action.effects(ctx)
    } catch (e) {
      crashed(e)
    }

    // The single validation gate: dry-run the whole plan through the
    // commit's own code before anything leaves this process. Everything the
    // commit would check — unknown keys, schemas, link endpoints,
    // cardinality — is checked here first, so the write-back adapter never
    // sees a plan the ontology store would refuse. (Single-writer,
    // synchronous: nothing can change between this dry run and the commit
    // below.)
    try {
      this.#preflight(edits)
    } catch (e) {
      return refuse(reject('INVALID_EDITS', editErrorMessage(e)))
    }

    // The authority line, checked after validity: `writeback` is the
    // action's declared side of it, and the declaration is checked against
    // what the plan actually touches — an undeclared write to source-backed
    // state is exactly the shadow copy the fourth property forbids,
    // whatever the action is named.
    const sides = new Set<'source' | 'ontology'>()
    for (const edit of edits) {
      const side = this.#editAuthority(edit)
      if (typeof side !== 'string') return refuse(side)
      sides.add(side)
    }
    if (sides.size > 1) {
      return refuse(
        reject(
          'MIXED_AUTHORITY',
          'the edit plan changes both source-backed and ontology-owned state — ' +
            'plans are routed whole, so split the action along the authority line',
        ),
      )
    }
    const authority = sides.values().next().value
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

    // An empty plan changes nothing, so there is nothing to write back —
    // the attempt still commits an audit entry below.
    if (action.writeback && edits.length > 0) {
      if (!this.#writeback) {
        return refuse(reject('NO_WRITEBACK_ADAPTER', 'action requires write-back but no adapter is configured'))
      }
      try {
        // Write-back first: if the system of record refuses, nothing changes
        // here. The adapter gets its own copies: what commits below is the
        // plan that was validated, not whatever the adapter left behind.
        this.#writeback.apply(structuredClone(edits), {
          action: actionName,
          actor: opts.actor,
          target: structuredClone(object),
        })
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

  auditLog(filter: { action?: ActionName<T>; status?: 'applied' | 'rejected'; target?: string } = {}): AuditEntry[] {
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

  /**
   * Inside a caller's transaction, "committed" would mean "until the caller
   * rolls the savepoint back" — an applied-and-audited action could be
   * silently unwound after this runtime reported success. The runtime owns
   * its transactions or refuses to run.
   */
  #refuseOpenTransaction(entry: string): void {
    if (this.#db.inTransaction) {
      throw new Error(
        `${entry}() must not run inside an open transaction — ` +
          'a commit that is really a savepoint could be rolled back after success was reported',
      )
    }
  }

  #objectDef(type: string): ObjectTypeDef {
    const def = Object.hasOwn(this.ontology.objects, type) ? this.ontology.objects[type] : undefined
    if (!def) throw new Error(`unknown object type "${type}"`)
    return def
  }

  /**
   * Which side of the authority line an edit falls on, per the model's
   * `owned` declarations — or the Violation for an edit no side can legally
   * hold. Runs after the preflight, so every edit it sees is one the store
   * would accept (empty modifies included: they were already refused).
   */
  #editAuthority(edit: Edit): 'source' | 'ontology' | Violation {
    if (edit.op === 'link' || edit.op === 'unlink') {
      const linkDef = Object.hasOwn(this.ontology.links, edit.link) ? this.ontology.links[edit.link] : undefined
      return linkDef?.owned ? 'ontology' : 'source'
    }
    const def = this.#objectDef(edit.object)
    if (def.owned === true) return 'ontology'
    if (edit.op === 'create') {
      return reject(
        'SOURCE_CREATE_UNSUPPORTED',
        `cannot create ${edit.object}/${edit.pk}: the type is source-backed, and creation is supported ` +
          'for ontology-owned types only — creating at the source is undemonstrated, so undeclared',
      )
    }
    const ownedKeys = def.owned ? Object.keys(def.owned) : []
    const touched = Object.keys(edit.changes)
    const owned = touched.filter((key) => ownedKeys.includes(key))
    if (owned.length === 0) return 'source'
    if (owned.length === touched.length) return 'ontology'
    return reject(
      'MIXED_AUTHORITY',
      `edit on ${edit.object}/${edit.pk} changes source-backed and ontology-owned properties together — split it`,
    )
  }

  /**
   * The single validation gate, and the dry run behind the write-back
   * guarantee: the exact code that will commit the plan applies it inside a
   * transaction that always rolls back. No second validator to drift out of
   * sync with the real one.
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

  /**
   * The gate every stored row passes through: the store keeps JSON, so the
   * value must survive the JSON round trip unchanged — or it would come
   * back a different value. (That the schema also accepts its own output is
   * the model author's declared contract; see ObjectTypeDef.properties.)
   */
  #storable(type: string, value: Record<string, unknown>): string {
    if (!isPlainJson(value)) {
      throw new Error(`${type} row is not plain JSON data — the store cannot hold it faithfully`)
    }
    return JSON.stringify(value)
  }

  /** A read snapshot, scoped to the actor. Hidden and missing objects are alike. */
  #read<O extends ObjectInstance = ObjectInstance>(type: string, pk: string, actor: string): O | undefined {
    const properties = this.#fetch(type, pk)
    if (properties === undefined) return undefined
    const object = { type, pk, properties } as O
    return this.#visible(object, actor) ? object : undefined
  }

  #scan<O extends ObjectInstance = ObjectInstance>(type: string, actor: string, filter?: ObjectFilter<O>): O[] {
    this.#objectDef(type)
    const rows = this.#db.prepare('SELECT pk, data FROM objects WHERE type = ? ORDER BY pk').all(type) as {
      pk: string; data: string
    }[]
    return rows
      .map((r) => ({ type, pk: r.pk, properties: JSON.parse(r.data) }) as O)
      .filter((o) => this.#visible(o, actor))
      .filter(matcher(filter))
  }

  /** Raw properties without visibility — for internal integrity checks only. */
  #fetch(type: string, pk: string): Record<string, unknown> | undefined {
    this.#objectDef(type)
    const row = this.#db
      .prepare('SELECT data FROM objects WHERE type = ? AND pk = ?')
      .get(type, pk) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  #visible(object: ObjectInstance, actor: string): boolean {
    const visibility = this.ontology.objects[object.type]?.visibility
    return visibility ? visibility({ object, actor }) : true
  }

  #applyEdits(edits: Edit[]): void {
    for (const edit of edits) {
      if (edit.op === 'link' || edit.op === 'unlink') {
        // Object.hasOwn, not a bare index: prototype names (toString,
        // __proto__, …) must not masquerade as link types.
        const linkDef = Object.hasOwn(this.ontology.links, edit.link) ? this.ontology.links[edit.link] : undefined
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
      // Unknown keys are refused, not silently stripped: zod would strip
      // them, but the raw edit still travels to the write-back adapter, and
      // a stripped key would let source and store diverge without a trace.
      // Object.hasOwn, not `in`: prototype names are unknown keys too.
      const payload = edit.op === 'create' ? edit.data : edit.changes
      const unknown = Object.keys(payload).filter((key) => !Object.hasOwn(def.properties, key))
      if (unknown.length > 0) {
        throw new Error(`unknown propert${unknown.length > 1 ? 'ies' : 'y'} "${unknown.join('", "')}" on ${edit.object}`)
      }
      if (edit.op === 'create') {
        const data = schema.parse(edit.data)
        if (String(data[def.primaryKey]) !== edit.pk) {
          throw new Error(
            `create pk mismatch for ${edit.object}: edit says "${edit.pk}", data says "${String(data[def.primaryKey])}"`,
          )
        }
        this.#db
          .prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
          .run(edit.object, edit.pk, this.#storable(edit.object, data))
        continue
      }
      // modify. A modify that changes nothing is not an edit — refusing it
      // keeps the authority classification total: every edit has a side.
      if (Object.keys(edit.changes).length === 0) {
        throw new Error(`modify on ${edit.object}/${edit.pk} changes nothing`)
      }
      if (Object.hasOwn(edit.changes, def.primaryKey) && edit.changes[def.primaryKey] !== edit.pk) {
        throw new Error(`cannot modify the primary key of ${edit.object}/${edit.pk}`)
      }
      const current = this.#fetch(edit.object, edit.pk)
      if (!current) throw new Error(`cannot modify missing object ${edit.object}/${edit.pk}`)
      const next = schema.parse({ ...current, ...edit.changes })
      this.#db
        .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
        .run(this.#storable(edit.object, next), edit.object, edit.pk)
      // Ontology-owned changes on a source-backed row also land in the
      // overlay — the layer load() reapplies over a re-indexed base. A
      // value set back to its declared default is pruned (compared
      // structurally, so key order cannot hide "back at default"): clearing
      // an edit clears the survival obligation with it.
      if (def.owned && def.owned !== true && this.#editAuthority(edit) === 'ontology') {
        const defaults = def.owned
        const row = this.#db
          .prepare('SELECT patch FROM overlay WHERE type = ? AND pk = ?')
          .get(edit.object, edit.pk) as { patch: string } | undefined
        const patch: Record<string, unknown> = row ? (JSON.parse(row.patch) as Record<string, unknown>) : {}
        for (const key of Object.keys(edit.changes)) {
          const value = (next as Record<string, unknown>)[key]
          if (isDeepStrictEqual(value, defaults[key])) delete patch[key]
          else patch[key] = value
        }
        if (Object.keys(patch).length === 0) {
          this.#db.prepare('DELETE FROM overlay WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
        } else {
          this.#db
            .prepare('INSERT OR REPLACE INTO overlay (type, pk, patch) VALUES (?, ?, ?)')
            .run(edit.object, edit.pk, JSON.stringify(patch))
        }
      }
    }
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
        safeJson(entry.params),
        entry.status,
        entry.error ? JSON.stringify(entry.error) : null,
        entry.edits ? safeJson(entry.edits) : null,
      )
  }
}

/**
 * The audit write must never be the thing that fails: a value the log cannot
 * encode is recorded as a placeholder, because a lost audit entry is worse
 * than a lossy one.
 */
function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    if (typeof encoded === 'string') return encoded
  } catch {
    // fall through to the placeholder
  }
  return JSON.stringify({ $unserializable: String(value) })
}

export function createRuntime<T extends OntologyDef>(
  ontology: T,
  db: Database,
  opts: { writeback?: WritebackAdapter } = {},
): Runtime<T> {
  return new Runtime(ontology, db, opts)
}

function matcher<O extends ObjectInstance>(filter?: ObjectFilter<O>): (o: O) => boolean {
  if (!filter) return () => true
  if (typeof filter === 'function') return filter
  const entries = Object.entries(filter)
  return (o: O) => entries.every(([k, v]) => o.properties[k] === v)
}
