/**
 * operational-ontology · core
 *
 * The definition layer (the model as data) and the runtime that makes it
 * operational:
 *
 *   - objects & links are indexed from existing physical data (read side)
 *   - every write goes through an action: preconditions → effects → audit log
 *   - the API exposes no other write path — a contract on the API, not a
 *     privilege boundary against code holding the database handle (declared;
 *     see "Transaction ownership" in docs/IMPLEMENTATION.md)
 *   - authority is declared in the model: source-backed state comes from the
 *     sources and write-back governs its changes; ontology-owned state lives
 *     here, needs no write-back, and survives re-indexing
 *
 * The ontology definition is a plain value, not a class hierarchy. The
 * runtime interprets it — which is what lets `mcp.ts` enumerate it and expose
 * the same model, guarded by the same rules, to AI agents.
 *
 * Vocabulary: the definitions below are the schema side of the model; the
 * store holds the instance side — object state, link instances, and the
 * audit log, where one entry is one attempted action.
 *
 * Runtime owns actor-scoped reads, the Action gate, and SQLite transactions.
 * query.ts operates on evaluated values without reading or writing the store.
 * The public methods expose data shapes; runtime checks enforce model constraints.
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Database } from 'better-sqlite3'

import * as query from './query.js'
import type { ObjectSet, AggregationResult, AggregationRow, ObjectFilter } from './query.js'
export { objectSet, aggregationResult } from './query.js'
export type { ObjectSet, AggregationResult, AggregationRow, ObjectFilter } from './query.js'

// ───────────────────────────── Definitions ─────────────────────────────

/** A map of property names to validators, rather than a row's actual values. */
export type Properties = z.ZodRawShape

/**
 * A read snapshot. Identity is (type, pk); properties are business data.
 * N preserves the object type's literal name; P is its parsed property shape.
 * `readonly` protects identity in TypeScript, not by freezing the value.
 * Changing this snapshot does not persist a change: writes require an Action.
 */
export interface ObjectInstance<N extends string = string, P = Record<string, unknown>> {
  readonly type: N
  readonly pk: string
  properties: P
}

export interface ObjectTypeDef<S extends Properties = Properties> {
  /** Property that uniquely identifies an object of this type. Must be a string property. */
  primaryKey: keyof S & string
  /**
   * Property schema. Validates rows at indexing time and edits at write time,
   * and is reused verbatim to generate MCP tool schemas. Schemas must
   * validate, not transform: the runtime stores what a schema produced and
   * feeds it back through the same schema on later writes, so a transforming
   * schema would refuse or rewrite its own output — a declared contract (see
   * "The storable boundary" in docs/IMPLEMENTATION.md).
   */
  properties: S
  /**
   * Authority declaration — which of this type's state the ontology itself
   * owns. Everything not declared here is source-backed: the indexed snapshot
   * supplies it, and changing it requires write-back.
   *
   * - `owned: true` — the whole type is ontology-owned, existence included.
   *   No source supplies its rows (`load()` refuses them); actions create and
   *   modify them without write-back; they survive re-indexing untouched.
   * - `owned: { prop: default }` — these properties are ontology-owned on
   *   otherwise source-backed rows. Loaded rows and source-backed creates
   *   must NOT supply them (the source has no authority over them); they start
   *   at the declared default, change only through actions, and survive
   *   re-indexing via the overlay.
   */
  owned?: true | Partial<z.input<z.ZodObject<S>>>
  /**
   * Row-level visibility, attached to the model (an optional slot). Absent
   * means visible to everyone: this reference implementation is fail-open by
   * declaration — it has no authentication, so `actor` is self-declared and
   * enforcement here demonstrates placement, not protection. A fail-closed
   * deployment makes this slot required rather than optional, on top of an
   * authenticated identity layer. See "Visibility and caller identity"
   * in docs/IMPLEMENTATION.md.
   */
  visibility?: (ctx: { object: ObjectInstance<string, z.output<z.ZodObject<S>>>; actor: string }) => boolean
  /**
   * Where the rows physically come from (documentation only — the integration
   * itself belongs to the data layer, outside the ontology).
   */
  source?: string
  description?: string
}

/** Check the definition and owned defaults now; Runtime checks individual rows later. */
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
      const parsed = (def.properties[key] as z.ZodType).safeParse(fallback)
      if (!parsed.success) {
        throw new Error(`default for owned property "${key}" does not satisfy its schema`)
      }
      // Owned values live in the store and travel through re-indexing, so
      // the default must be a value the store can hold faithfully.
      if (!isPlainJson(parsed.data)) {
        throw new Error(`default for owned property "${key}" must be plain JSON data`)
      }
    }
  }
  return def
}

/**
 * The store keeps JSON, so a storable value must survive the JSON round trip
 * unchanged. Dates and other class instances, Maps, functions, symbols,
 * BigInt, NaN and Infinity, holes in arrays, undefined at any depth — all
 * would come back changed or dropped, so all are "not plain JSON".
 */
export function isPlainJson(value: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value)
  } catch {
    return false
  }
}

/**
 * A relationship between object types, not an existing pair of instances.
 * `from` and `to` give it an orientation; either end can be a query's starting
 * point. Cardinality constrains stored relationships, not traversal direction.
 */
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
  description?: string
}

/** defineOntology checks the endpoints against the assembled model. */
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
 * just node properties. Deletes are out of scope; see docs/IMPLEMENTATION.md.
 */
export type Edit =
  | { op: 'modify'; object: string; pk: string; changes: Record<string, unknown> }
  | { op: 'create'; object: string; pk: string; data: Record<string, unknown> }
  | { op: 'link'; link: string; from: string; to: string }
  | { op: 'unlink'; link: string; from: string; to: string }

/** Describe a change to an instance; only running an action applies it. */
// Property names and values are checked during preflight, like create/link.
export const modify = (object: ObjectInstance, changes: Record<string, unknown>): Edit => ({
  op: 'modify',
  object: object.type,
  pk: object.pk,
  changes,
})
// These helpers only describe edits. Names, payloads and relationship constraints
// are checked against the model during preflight, before any write-back occurs.
// A source-backed create supplies source properties only; owned defaults are local.
export const create = (object: string, pk: string, data: Record<string, unknown>): Edit => ({
  op: 'create',
  object,
  pk,
  data,
})
export const link = (linkName: string, from: string, to: string): Edit => ({ op: 'link', link: linkName, from, to })
export const unlink = (linkName: string, from: string, to: string): Edit => ({ op: 'unlink', link: linkName, from, to })

export interface ActionCtx<O = ObjectInstance, P = Record<string, unknown>> {
  /** The object the action targets, loaded from the ontology store. */
  object: O
  /** Already parsed: schema defaults have been supplied before callbacks run. */
  params: P
  actor: string
}

/**
 * The schema side of an action — its type. Each `execute()` of this action is one
 * instance of it, applied or refused, recorded as an audit entry.
 */
export interface ActionDef<S extends Properties = Properties, O extends ObjectInstance = ObjectInstance> {
  /** Object type this action operates on. */
  object: O['type']
  /** Name of the param that carries the target's primary key. */
  targetParam: keyof S & string
  /** Parameter schema. Reused verbatim as the MCP tool input schema. */
  params: S
  description?: string
  /**
   * Business rules must be pure, like effects.
   * Each precondition may return `reject(code, message)` to
   * refuse the write. These are domain rules ("a shipped order cannot be
   * cancelled"), not access control — a permission system decides *who* may
   * act; preconditions decide *whether the operation is valid at all*.
   */
  preconditions: Array<(ctx: ActionCtx<O, z.output<z.ZodObject<S>>>) => Violation | void>
  /**
   * The changes this action makes, described as data. Effects must be pure:
   * they describe edits, they do not perform them. Reaching into external
   * systems from here bypasses write-back ordering and the audit log — side
   * effects belong to the WritebackAdapter.
   */
  effects: (ctx: ActionCtx<O, z.output<z.ZodObject<S>>>) => Edit[]
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
 * Give rules the object schema before their callbacks are inferred. Passing
 * definitions separately lets callback hints come from the selected object
 * and parameter schemas, without inferring them from the callback bodies.
 */
export function defineAction<Objects extends ObjectDefinitions, K extends keyof Objects & string, S extends Properties>(
  objects: Objects,
  def: ActionDef<S, ObjectInstance<K, PropertiesOf<Objects[K]>>>,
): ActionDef<S, ObjectInstance<K, PropertiesOf<Objects[K]>>> {
  if (!Object.hasOwn(objects, def.object)) throw new Error(`unknown object type "${def.object}"`)
  if (!Object.hasOwn(def.params, def.targetParam)) {
    throw new Error(`targetParam "${def.targetParam}" is not one of the action's params`)
  }
  return def
}

/** A named domain read. It must not perform writes or other side effects. */
export interface FunctionDef<S extends Properties = Properties, Result = unknown> {
  description?: string
  params: S
  /** Use the caller's actor for all reads; return values, not applied edits. */
  run: (ctx: { params: z.output<z.ZodObject<S>>; actor: string }) => Result
}

/**
 * Infer input params from their schema and the result from the implementation.
 * Result stays as returned, including Promise results; it is not ActionResult.
 * The read-only contract above is the author's responsibility, not a sandbox.
 */
export function defineFunction<S extends Properties, Result>(def: FunctionDef<S, Result>): FunctionDef<S, Result> {
  return def
}

export interface OntologyDef {
  name: string
  objects: ObjectDefinitions
  links: Record<string, LinkTypeDef>
  actions: Record<string, ActionDef<any, any>>
  functions?: Record<string, FunctionDef<any, any>>
}

/**
 * Cross-reference checks need the assembled model. Distinct operation names
 * keep the generated MCP tools unambiguous across Actions and Functions.
 * Returning Model, rather than OntologyDef, keeps its specific names and schemas.
 */
export function defineOntology<Model extends OntologyDef>(def: Model): Model {
  for (const name of Object.keys(def.functions ?? {})) {
    if (Object.hasOwn(def.actions, name)) {
      throw new Error(`operation "${name}" is defined as both an action and a function`)
    }
  }
  for (const [name, link] of Object.entries(def.links)) {
    for (const end of [link.from, link.to]) {
      if (!Object.hasOwn(def.objects, end)) {
        throw new Error(`link "${name}" references unknown object type "${end}"`)
      }
    }
  }
  for (const [name, action] of Object.entries(def.actions)) {
    if (!Object.hasOwn(def.objects, action.object)) {
      throw new Error(`action "${name}" references unknown object type "${action.object}"`)
    }
  }
  return def
}

// ───────────────────────────── Write-back ─────────────────────────────

/**
 * Propagates an action's edits toward the systems of record, running BEFORE
 * the local commit — write-back-first, the declared failure semantics (see
 * "Failure semantics in detail" in docs/IMPLEMENTATION.md). The adapter speaks
 * only to the systems of record; that boundary is a declared contract, not
 * an enforced one (see "Transaction ownership" in docs/IMPLEMENTATION.md). It
 * receives its own copies of the plan and the target object, so nothing it
 * mutates leaks back into the runtime. For a source-backed create, persist the
 * supplied identity and source properties; owned defaults stay local. Returning
 * source-generated IDs or replacement values is not supported.
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

// A successful preflight deliberately rolls back; other failures propagate.
class Rollback extends Error {}

const editErrorMessage = (e: unknown): string =>
  e instanceof z.ZodError
    ? `${e.issues[0]?.path.join('.') || 'edit'}: ${e.issues[0]?.message ?? 'invalid'}`
    : e instanceof Error
      ? e.message
      : String(e)

/** `ok` narrows the result to edits or a business refusal; unexpected crashes still throw. */
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

// Simple result lookups keep examples readable without constraining input names.
// A dynamic name has an unknown result; schemas still check values at runtime.
type ObjectDefinitions = Record<string, ObjectTypeDef<any>>
type PropertiesOf<Definition extends ObjectTypeDef<any>> = z.output<z.ZodObject<Definition['properties']>>
export type ObjectOf<Model extends OntologyDef, Name extends string> =
  Name extends keyof Model['objects'] ? ObjectInstance<Name, PropertiesOf<Model['objects'][Name]>> : ObjectInstance
export type FunctionResultOf<Model extends OntologyDef, Name extends string> =
  Name extends keyof NonNullable<Model['functions']> ? ReturnType<NonNullable<Model['functions']>[Name]['run']> : unknown
export type Direction = 'forward' | 'reverse'
/** Omit direction when only one end fits; Runtime rejects ambiguous or impossible choices. */
export interface TraverseOptions { actor: string; direction?: Direction }

/**
 * The four answers this implementation declares, as one enumerable value —
 * the same move the model makes: a declaration you can read at runtime, not
 * prose you have to trust. Authority is the model's half of the bargain
 * (`owned`, `writeback`, checked per edit plan); the other three are the
 * runtime's. Each is unpacked in the README and docs/IMPLEMENTATION.md.
 */
export const declarations = {
  authority: 'model-declared-runtime-checked',
  failureSemantics: 'write-back-first',
  reindexing: 'replace-base-reapply-owned-overlay',
  visibilityDefault: 'fail-open',
} as const

/**
 * Interpret one model. Model is kept only for simple get/search/call result
 * lookups; operation inputs use strings and plain data, checked at runtime.
 * SQLite holds ontology state separately from the indexed source systems.
 */
export class Runtime<Model extends OntologyDef = OntologyDef> {
  readonly ontology: Model
  readonly declarations = declarations
  readonly #db: Database
  readonly #schemas = new Map<string, z.ZodObject<Properties>>()
  readonly #writeback?: WritebackAdapter

  constructor(ontology: Model, db: Database, opts: { writeback?: WritebackAdapter } = {}) {
    // A caller may pass a plain definition without using defineOntology first.
    this.ontology = defineOntology(ontology)
    this.#writeback = opts.writeback
    this.#db = db
    for (const [name, obj] of Object.entries(this.ontology.objects)) {
      this.#schemas.set(name, z.object(obj.properties))
    }
    // objects holds effective JSON rows; links holds instance pairs whose types
    // come from the model. Including type/name in keys keeps identities distinct.
    // overlay holds current owned patches for re-indexing, while audit_log holds
    // the history of Action attempts. An overlay is state, not an event log.
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
   * "Re-indexing vs edits" in docs/IMPLEMENTATION.md.
   */
  load(snapshot: {
    objects?: Record<string, Record<string, unknown>[]>
    links?: Record<string, Array<[from: string, to: string]>>
  }): void {
    this.#refuseOpenTransaction('load')
    const insertObject = this.#db.prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
    const insertLink = this.#db.prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
    // One transaction covers all supplied types. Check relationships after the
    // replacements, so a snapshot can supply both new endpoints and their links.
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

  /** The selected type determines properties; hidden and missing IDs both yield undefined. */
  get<K extends string>(type: K, pk: string, opts: { actor: string }): ObjectOf<Model, K> | undefined {
    return this.#read<ObjectOf<Model, K>>(type, pk, opts.actor)
  }

  /** Read visible objects, then apply the caller's predicate to those snapshots. */
  search<K extends string>(type: K, opts: { actor: string; filter?: ObjectFilter<ObjectOf<Model, K>> }): ObjectSet<ObjectOf<Model, K>> {
    const set = query.objectSet(type, this.#scan(type, opts.actor) as ObjectOf<Model, K>[])
    return opts.filter === undefined ? set : query.filterObjects(set, opts.filter)
  }

  /** Links, endpoints and direction are checked from the model at execution time. */
  traverse(source: ObjectInstance, linkName: string, opts: TraverseOptions): ObjectSet {
    if (!source || typeof source.type !== 'string' || typeof source.pk !== 'string' ||
        !source.properties || typeof source.properties !== 'object' || Array.isArray(source.properties)) {
      throw new Error('traverse() requires an object instance with type, pk, and properties')
    }
    return this.#follow(source.type, [source.pk], linkName, opts)
  }

  /** Follow a relationship from a whole set; the output tag is known at runtime. */
  pivot(source: ObjectSet, linkName: string, opts: TraverseOptions): ObjectSet {
    const set = query.objectSet(source.type, source.objects)
    return this.#follow(set.type, set.objects.map((o) => o.pk), linkName, opts)
  }

  /** Filter snapshots or metric rows locally; neither callback is sent over MCP. */
  filter<O extends ObjectInstance>(input: ObjectSet<O>, predicate: ObjectFilter<O>): ObjectSet<O>
  filter<O extends ObjectInstance>(
    input: AggregationResult<O>, predicate: (row: AggregationRow) => boolean,
  ): AggregationResult<O>
  filter(input: ObjectSet | AggregationResult, predicate: unknown): ObjectSet | AggregationResult {
    if ('set' in input) return query.filterAggregation(input, predicate as (row: AggregationRow) => boolean)
    return query.filterObjects(input, predicate as ObjectFilter)
  }

  /** Set algebra checks matching tags at runtime and preserves the left snapshots. */
  union(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('union', a, b) }
  intersect(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('intersect', a, b) }
  subtract(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('subtract', a, b) }

  /** Omit groupBy for a whole-set total (key: null); count is always present, sum is optional. */
  aggregate<O extends ObjectInstance>(set: ObjectSet<O>, options: { groupBy?: string; sum?: string } = {}): AggregationResult<O> {
    const def = Object.hasOwn(this.ontology.objects, set.type) ? this.ontology.objects[set.type] : undefined
    if (!def) throw new Error(`unknown object type "${set.type}"`)
    return query.aggregate(set, options, def.properties)
  }

  /** Validate Function params and return its value, including a Promise. Reads are not audited. */
  call<Name extends string>(
    name: Name, params: Record<string, unknown>, opts: { actor: string },
  ): FunctionResultOf<Model, Name> {
    const functions = this.ontology.functions
    const fn = functions && Object.hasOwn(functions, name) ? functions[name] : undefined
    if (!fn) throw new Error(`unknown function "${name}"`)
    return fn.run({ params: z.object(fn.params).parse(params), actor: opts.actor })
  }

  // ── Write side: every change goes through an action ──

  /**
   * Execute an action. This is the only way the API changes state:
   * validate params → load target → preconditions → effects → dry-run the
   * whole plan through the commit's own code → check the authority
   * declaration → write-back (if declared) → atomically commit edits +
   * audit entry. Validity precedes authority: a plan the store would refuse
   * is INVALID_EDITS, whatever else it is.
   */
  execute(actionName: string, params: Record<string, unknown>, opts: { actor: string }): ActionResult {
    this.#refuseOpenTransaction('execute')
    // Every execution attempt is audited, including early refusals.
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
      return refuseAs('(unknown action)', params, reject('UNKNOWN_ACTION', `no action named "${actionName}"`))
    }

    const guessTarget = () => {
      const guessed = params[action.targetParam]
      return `${action.object}/${guessed != null ? String(guessed) : '(invalid)'}`
    }

    // Params are stored verbatim in the audit log, so they must be values
    // the log can hold faithfully — refused here, and still audited (the
    // audit write falls back to a placeholder for what it cannot encode).
    if (!isPlainJson(params)) {
      return refuseAs(guessTarget(), params, reject('INVALID_PARAMS', 'params are not plain JSON data'))
    }

    const parsed = z.object(action.params).safeParse(params)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return refuseAs(
        guessTarget(),
        params,
        reject('INVALID_PARAMS', `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`),
      )
    }

    const pk = String(parsed.data[action.targetParam])
    const target = `${action.object}/${pk}`
    const refuse = (error: Violation, edits?: Edit[]): ActionResult => refuseAs(target, parsed.data, error, edits)

    // Execution crashes are audited as EXECUTION_CRASHED, then rethrown.
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

  /** Administrative history, not an actor-scoped object query. */
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

  // ─────────────── Internal helpers ───────────────

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
   * This classifies who owns the state, not which actor is allowed to act.
   */
  #editAuthority(edit: Edit): 'source' | 'ontology' | Violation {
    if (edit.op === 'link' || edit.op === 'unlink') {
      const linkDef = Object.hasOwn(this.ontology.links, edit.link) ? this.ontology.links[edit.link] : undefined
      return linkDef?.owned ? 'ontology' : 'source'
    }
    const def = this.#objectDef(edit.object)
    if (def.owned === true) return 'ontology'
    const ownedKeys = def.owned ? Object.keys(def.owned) : []
    if (edit.op === 'create') {
      if (!Object.keys(edit.data).some((key) => ownedKeys.includes(key))) return 'source'
      return reject(
        'MIXED_AUTHORITY',
        `create on ${edit.object}/${edit.pk} supplies ontology-owned properties on a source-backed type — ` +
          'omit them to use their declared defaults, then change them in a separate action',
      )
    }
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

  // User reads apply visibility; integrity checks need the complete graph,
  // including endpoints that this particular caller cannot see.
  #visible(object: ObjectInstance, actor: string): boolean {
    const visibility = this.ontology.objects[object.type]?.visibility
    return visibility ? visibility({ object, actor }) : true
  }

  /** Raw properties for integrity checks. User reads pass through #read to apply visibility. */
  #fetch(type: string, pk: string): Record<string, unknown> | undefined {
    this.#objectDef(type)
    const row = this.#db
      .prepare('SELECT data FROM objects WHERE type = ? AND pk = ?')
      .get(type, pk) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  /** A read snapshot, scoped to the actor. Hidden and missing objects are alike. */
  #read<O extends ObjectInstance = ObjectInstance>(type: string, pk: string, actor: string): O | undefined {
    const properties = this.#fetch(type, pk)
    if (properties === undefined) return undefined
    // Store rows use dynamic names; the public signature restores the model's
    // name/property pairing. The assertion itself performs no schema validation.
    const object = { type, pk, properties } as O
    return this.#visible(object, actor) ? object : undefined
  }

  #scan(type: string, actor: string): ObjectInstance[] {
    this.#objectDef(type)
    const rows = this.#db.prepare('SELECT pk, data FROM objects WHERE type = ? ORDER BY pk').all(type) as {
      pk: string; data: string
    }[]
    return rows.map((r) => ({ type, pk: r.pk, properties: JSON.parse(r.data) }))
      .filter((object) => this.#visible(object, actor))
  }

  /** Return neighbor IDs; #follow re-reads endpoints to apply the caller's visibility. */
  #related(link: string, direction: 'forward' | 'reverse', pk: string): { pk: string }[] {
    // Reverse traversal swaps fixed column names; link names and IDs remain bound values.
    const [where, select] = direction === 'forward' ? ['from_pk', 'to_pk'] : ['to_pk', 'from_pk']
    return this.#db.prepare(`SELECT ${select} AS pk FROM links WHERE name = ? AND ${where} = ? ORDER BY pk`)
      .all(link, pk) as { pk: string }[]
  }

  /** Traversal always re-reads both ends as this actor; snapshots are not authority. */
  #follow(type: string, pks: readonly string[], linkName: string, opts: TraverseOptions): ObjectSet {
    // Check the schema before iterating: an empty set must not hide a bad link
    // or an ambiguous direction, regardless of the caller's language.
    const link = Object.hasOwn(this.ontology.links, linkName) ? this.ontology.links[linkName] : undefined
    if (!link) throw new Error(`unknown link type "${linkName}"`)
    const forward = type === link.from
    const reverse = type === link.to
    if (!forward && !reverse) throw new Error(`link "${linkName}" does not connect "${type}"`)
    if (forward && reverse && opts.direction === undefined) throw new Error(`link "${linkName}" requires a direction from "${type}"`)
    const direction = opts.direction === undefined ? (forward ? 'forward' : 'reverse') : opts.direction
    if (!((direction === 'forward' && forward) || (direction === 'reverse' && reverse))) {
      throw new Error(`invalid direction "${direction}" for link "${linkName}" from "${type}"`)
    }
    const target = direction === 'forward' ? link.to : link.from
    const objects: ObjectInstance[] = []
    for (const pk of pks) {
      if (!this.#read(type, pk, opts.actor)) continue
      for (const row of this.#related(linkName, direction, pk)) {
        const object = this.#read(target, row.pk, opts.actor)
        if (object) objects.push(object)
      }
    }
    // Several sources can reach the same target; a pivot returns objects, not paths.
    return query.objectSet(target, objects)
  }

  /**
   * Shared by preflight and commit, each inside its caller's transaction.
   * Plan order is meaningful: create before linking, unlink before rewiring
   * a one-to-many relationship. Do not silently reorder the author's edits.
   */
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
        // Like load(), initialize owned properties locally. The adapter receives
        // only the source payload; explicit owned writes are refused by authority.
        const defaults = def.owned && def.owned !== true ? def.owned : {}
        const data = schema.parse({ ...defaults, ...edit.data })
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
      // Validate the resulting whole object, not a partial patch against a full
      // schema. Untouched required properties remain present during validation.
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

  /**
   * Check every surviving link, including those not replaced by this load.
   * A partial refresh can otherwise remove endpoints of an untouched link.
   */
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
   * Append only. Success calls this inside the edit transaction. The Action gate
   * records refusals separately even when no business edits were applied.
   */
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
 * Best-effort encoding for rejected raw input: use a placeholder when ordinary
 * JSON encoding fails. This preserves some context instead of losing the entry;
 * it does not suppress database errors or guarantee every value can be logged.
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

/** Preserve the supplied model type instead of returning an unspecialized Runtime. */
export function createRuntime<Model extends OntologyDef>(
  ontology: Model,
  db: Database,
  opts: { writeback?: WritebackAdapter } = {},
): Runtime<Model> {
  return new Runtime(ontology, db, opts)
}
