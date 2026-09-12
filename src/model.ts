/** The model as data and the types derived from it. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

export type Properties = z.ZodRawShape

export interface ObjectTypeDef<S extends Properties = Properties> {
  /** Property that uniquely identifies an object of this type. Must be a string property. */
  primaryKey: string
  /**
   * Property schema. Validates rows at indexing time and edits at write time,
   * and is reused verbatim to generate MCP tool schemas. Schemas must
   * validate, not transform: the runtime stores what a schema produced and
   * feeds it back through the same schema on later writes, so a transforming
   * schema would refuse or rewrite its own output — a declared contract (see
   * "The storable boundary" in IMPLEMENTATION.md).
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

export interface LinkTypeDef<From extends string = string, To extends string = string> {
  from: From
  to: To
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

export function defineLink<From extends string, To extends string>(
  def: LinkTypeDef<From, To>,
): LinkTypeDef<From, To> {
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
 * just node properties. (Deletes are out of scope in v0.2 — see the README.)
 */
export type Edit =
  | { op: 'modify'; object: string; pk: string; changes: Record<string, unknown> }
  | { op: 'create'; object: string; pk: string; data: Record<string, unknown> }
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
export const link = (linkName: string, from: string, to: string): Edit => ({ op: 'link', link: linkName, from, to })
export const unlink = (linkName: string, from: string, to: string): Edit => ({ op: 'unlink', link: linkName, from, to })

export interface ActionCtx<O = Record<string, unknown>, P = Record<string, unknown>> {
  /** The object the action targets, loaded from the ontology store. */
  object: O
  params: P
  actor: string
}

/**
 * The schema side of an action — its type. Each `execute()` call is one
 * instance of it, applied or refused, recorded as an audit entry.
 */
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

export function defineAction<S extends Properties>(def: ActionDef<S>): ActionDef<S> {
  if (!Object.hasOwn(def.params, def.targetParam)) {
    throw new Error(`targetParam "${def.targetParam}" is not one of the action's params`)
  }
  return def
}

export interface OntologyDef {
  name: string
  objects: Record<string, ObjectTypeDef<any>>
  // `any` ends, not `string`: as the contextual type of a definition literal,
  // `LinkTypeDef<string, string>` would widen the literal names a nested
  // defineLink() call inferred — and the model-derived types below need them.
  links: Record<string, LinkTypeDef<any, any>>
  actions: Record<string, ActionDef<any>>
}

export function defineOntology<T extends OntologyDef>(def: T): T {
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

// ───────────────────────────── Model-derived types ─────────────────────────────
//
// The runtime's call sites are typed by the definition they were built from:
// object, link, and action names are the keys of the model, an object's
// instance shape is what its property schema produces, and an action's
// params are its parameter schema. A runtime built from a definition typed
// only as `OntologyDef` falls back to strings and open records — the same
// contract as before, just untyped.

export type ObjectName<T extends OntologyDef> = keyof T['objects'] & string
export type LinkName<T extends OntologyDef> = keyof T['links'] & string
export type ActionName<T extends OntologyDef> = keyof T['actions'] & string
export type Direction = 'forward' | 'reverse'

/** `any` is the untyped fallback's marker: whatever it names, we know nothing about. */
type IsAny<X> = 0 extends 1 & X ? true : false

/** The instance shape of object type `K`, as its property schema produces it. */
export type ObjectOf<T extends OntologyDef, K> =
  IsAny<K> extends true
    ? Record<string, unknown>
    : K extends ObjectName<T>
      ? T['objects'][K] extends ObjectTypeDef<infer S>
        ? IsAny<S> extends true
          ? Record<string, unknown>
          : z.infer<z.ZodObject<S>>
        : Record<string, unknown>
      : Record<string, unknown>

/**
 * The object type a traversal of link `L` arrives at, decided by the shape
 * of the options it was called with — not by an inferred direction, which
 * would read `direction?: 'reverse'` as reverse even when the value is
 * absent and the traversal runs forward. Absent: the to side (forward).
 * A required `'reverse'`: the from side. `'forward'`, required or
 * optional: the to side. Anything else — an optional `'reverse'`, a union —
 * could go either way, and the type says so. Two mechanics: `O` is
 * distributed first, so a union of option shapes is decided member by
 * member (`keyof` of a union keeps only the common keys, which would hide
 * `direction`); and presence is tested with `keyof`, because
 * `{ direction?: undefined }` alone is a weak type, which an options object
 * without `direction` would fail to match.
 */
export type LinkEnd<T extends OntologyDef, L extends LinkName<T>, O extends { direction?: Direction }> =
  O extends unknown
    ? 'direction' extends keyof O
      ? O extends { direction: 'reverse' }
        ? T['links'][L]['from']
        : Exclude<O['direction'], undefined> extends 'forward'
          ? T['links'][L]['to']
          : T['links'][L]['from'] | T['links'][L]['to']
      : T['links'][L]['to']
    : never

/** What a caller passes to action `A` — its parameter schema's input side. */
export type ParamsOf<T extends OntologyDef, A extends ActionName<T>> =
  T['actions'][A] extends ActionDef<infer S>
    ? IsAny<S> extends true
      ? Record<string, unknown>
      : z.input<z.ZodObject<S>>
    : Record<string, unknown>
