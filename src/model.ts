/** The model as data, its instance values, and the types derived from it. */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

/** A read snapshot. Identity is (type, pk); properties are business data. */
export interface ObjectInstance<N extends string = string, P = Record<string, unknown>> {
  readonly type: N
  readonly pk: string
  properties: P
}

export type Properties = z.ZodRawShape

export interface ObjectTypeDef<S extends Properties = Properties> {
  /** Property that uniquely identifies an object of this type. Must be a string property. */
  primaryKey: keyof S & string
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
  owned?: true | Partial<z.input<z.ZodObject<S>>>
  /**
   * Row-level visibility, attached to the model (an optional slot). Absent
   * means visible to everyone: this reference implementation is fail-open by
   * declaration — it has no authentication, so `actor` is self-declared and
   * enforcement here demonstrates placement, not protection. A fail-closed
   * deployment makes this slot required rather than optional, on top of an
   * authenticated identity layer. See "Visibility and caller identity"
   * in IMPLEMENTATION.md.
   */
  visibility?: (ctx: { object: ObjectInstance<string, z.output<z.ZodObject<S>>>; actor: string }) => boolean
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
 * just node properties. Deletes are out of scope; see IMPLEMENTATION.md.
 */
export type Edit =
  | { op: 'modify'; object: string; pk: string; changes: Record<string, unknown> }
  | { op: 'create'; object: string; pk: string; data: Record<string, unknown> }
  | { op: 'link'; link: string; from: string; to: string }
  | { op: 'unlink'; link: string; from: string; to: string }

/** Describe a change to an instance; only execute() applies it. */
export const modify = <O extends ObjectInstance>(object: O, changes: NoInfer<Partial<O['properties']>>): Edit => ({
  op: 'modify',
  object: object.type,
  pk: object.pk,
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

export interface ActionCtx<O = ObjectInstance, P = Record<string, unknown>> {
  /** The object the action targets, loaded from the ontology store. */
  object: O
  params: P
  actor: string
}

/**
 * The schema side of an action — its type. Each `execute()` call is one
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
   * Business rules. Each precondition may return `reject(code, message)` to
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

/** Give rules the object schema before their callbacks are inferred. */
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

export interface OntologyDef {
  name: string
  objects: ObjectDefinitions
  // `any` ends, not `string`: as the contextual type of a definition literal,
  // `LinkTypeDef<string, string>` would widen the literal names a nested
  // defineLink() call inferred — and the model-derived types below need them.
  links: Record<string, LinkTypeDef<any, any>>
  actions: Record<string, ActionDef<any, any>>
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

// ── Model-derived types: names, schemas, and the ends of a link ──

type ObjectDefinitions = Record<string, ObjectTypeDef<any>>
type PropertiesOf<D extends ObjectTypeDef<any>> = z.output<z.ZodObject<D['properties']>>
export type ObjectName<T extends OntologyDef> = keyof T['objects'] & string
export type LinkName<T extends OntologyDef> = keyof T['links'] & string
export type ActionName<T extends OntologyDef> = keyof T['actions'] & string
export type Direction = 'forward' | 'reverse'

/** Mapping before indexing preserves the tag/properties relationship for unions. */
export type ObjectOf<T extends OntologyDef, K extends ObjectName<T>> = {
  [N in K]: ObjectInstance<N, PropertiesOf<T['objects'][N]>>
}[K]
export type ParamsOf<T extends OntologyDef, A extends ActionName<T>> =
  z.input<z.ZodObject<T['actions'][A]['params']>>

export type LinksFrom<T extends OntologyDef, S extends ObjectName<T>> = {
  [L in LinkName<T>]: S extends T['links'][L]['from'] | T['links'][L]['to'] ? L : never
}[LinkName<T>]
export type LinkDirections<T extends OntologyDef, S extends ObjectName<T>, L extends LinkName<T>> =
  | (S extends T['links'][L]['from'] ? 'forward' : never)
  | (S extends T['links'][L]['to'] ? 'reverse' : never)

/** The other end. A self-type link returns the same type in either direction. */
export type LinkTarget<T extends OntologyDef, S extends ObjectName<T>, L extends LinkName<T>> =
  L extends LinkName<T>
    ? (S extends T['links'][L]['from'] ? T['links'][L]['to'] : never)
      | (S extends T['links'][L]['to'] ? T['links'][L]['from'] : never)
    : never

export type TraverseOptions<T extends OntologyDef, S extends ObjectName<T>, L extends LinkName<T>> =
  { actor: string } & (Direction extends LinkDirections<T, S, L>
    ? { direction: LinkDirections<T, S, L> }
    : { direction?: LinkDirections<T, S, L> })

export type ObjectFilter<O extends ObjectInstance> = Partial<O['properties']> | ((object: O) => boolean)
