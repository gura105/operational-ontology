/**
 * Type-level tests: the model types its own insides — a rule's `object`
 * and `params`, the changes an edit carries, the references between
 * definitions — and the runtime's call sites. `pnpm typecheck` is the real
 * test here — an `@ts-expect-error` that stops erroring fails it. The
 * compile-only block is never called, because most of what the types
 * refuse the runtime refuses too, by throwing; the runtime tests at the
 * bottom keep the typed calls honest under `pnpm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  create,
  createRuntime,
  defineAction,
  defineLink,
  defineObject,
  defineOntology,
  link,
  modify,
  reject,
  type Direction,
  type InstanceOf,
  type ObjectOf,
  type OntologyDef,
  type ParamsOf,
} from '../src/core.js'

const Customer = defineObject('Customer', {
  primaryKey: 'id',
  properties: { id: z.string(), name: z.string() },
  // The visibility rule sees the instance shape.
  visibility: ({ object, actor }) => actor === 'user:auditor' || object.name !== 'hidden',
})
const Order = defineObject('Order', {
  primaryKey: 'id',
  properties: {
    id: z.string(),
    status: z.enum(['pending', 'shipped', 'cancelled']),
    total: z.number().int(),
    assignee: z.string().nullable(),
  },
  owned: { assignee: null },
})
const customerOrders = defineLink('customerOrders', { from: Customer, to: Order, kind: 'one-to-many' })
const cancelOrder = defineAction('cancelOrder', {
  object: Order,
  targetParam: 'orderId',
  params: { orderId: z.string(), reason: z.string().min(1) },
  preconditions: [
    // `object` is an Order, `params` are the parsed params: both typed, no casts.
    ({ object, params }) =>
      object.status === 'shipped' ? reject('SHIPPED', `order ${object.id} has shipped (${params.reason})`) : undefined,
  ],
  effects: ({ object }) => [modify(Order, object.id, { status: 'cancelled' })],
  writeback: true,
})
const model = defineOntology({
  name: 'typed',
  objects: [Customer, Order],
  links: [customerOrders],
  actions: [cancelOrder],
})

// Mutual assignability — what a caller can rely on, without depending on
// how zod spells its inferred object types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertType = <_T extends true>(): void => {}

type CustomerRow = { id: string; name: string }
type OrderRow = { id: string; status: 'pending' | 'shipped' | 'cancelled'; total: number; assignee: string | null }

const actor = { actor: 'user:test' }

// ── Model-derived types are what the definitions say ──
assertType<Same<InstanceOf<typeof Order>, OrderRow>>()
assertType<Same<ObjectOf<typeof model, 'Customer'>, CustomerRow>>()
assertType<Same<ObjectOf<typeof model, 'Order'>, OrderRow>>()
assertType<Same<ParamsOf<typeof model, 'cancelOrder'>, { orderId: string; reason: string }>>()

// Checked by tsc, never run: the runtime throws on most of these, on purpose.
export function compileOnly(rt: ReturnType<typeof createRuntime<typeof model>>): void {
  // ── Inside the definitions ──
  defineObject('Widget', {
    // @ts-expect-error the primary key must be one of the properties
    primaryKey: 'nope',
    properties: { id: z.string() },
  })
  defineObject('Widget', {
    primaryKey: 'id',
    properties: { id: z.string(), note: z.string() },
    // @ts-expect-error an owned default must satisfy the property's schema
    owned: { note: 1 },
  })
  defineObject('Widget', {
    primaryKey: 'id',
    properties: { id: z.string() },
    // @ts-expect-error the visibility rule sees only declared properties
    visibility: ({ object }) => object.secret === true,
  })
  defineAction('cancelOrder', {
    object: Order,
    // @ts-expect-error the target param must be one of the params
    targetParam: 'nope',
    params: { orderId: z.string() },
    preconditions: [],
    effects: () => [],
  })
  defineAction('cancelOrder', {
    object: Order,
    targetParam: 'orderId',
    params: { orderId: z.string() },
    // @ts-expect-error a rule sees only the object's declared properties
    preconditions: [({ object }) => (object.shipped ? reject('X', 'x') : undefined)],
    effects: () => [],
  })
  // Edits are checked against the object type they name.
  modify(Order, 'O1', { status: 'cancelled' })
  // @ts-expect-error not a status the schema knows
  modify(Order, 'O1', { status: 'lost' })
  // @ts-expect-error not a property of Order
  modify(Order, 'O1', { vaporware: 1 })
  create(Customer, 'C9', { id: 'C9', name: 'Suzuki' })
  // @ts-expect-error a creation must supply every property
  create(Customer, 'C9', { id: 'C9' })
  link(customerOrders, 'C1', 'O1')
  // @ts-expect-error a link edit takes the link type, not its name
  link('customerOrders', 'C1', 'O1')
  // @ts-expect-error an edit takes the object type, not its name
  modify('Order', 'O1', { status: 'cancelled' })
  // References must point into the model.
  const Product = defineObject('Product', { primaryKey: 'id', properties: { id: z.string() } })
  const orderProducts = defineLink('orderProducts', { from: Order, to: Product, kind: 'many-to-many' })
  const restock = defineAction('restock', {
    object: Product,
    targetParam: 'id',
    params: { id: z.string() },
    preconditions: [],
    effects: () => [],
  })
  // @ts-expect-error the link's end is not one of the ontology's objects
  defineOntology({ name: 'x', objects: [Customer, Order], links: [orderProducts] })
  // @ts-expect-error the action's object is not one of the ontology's objects
  defineOntology({ name: 'x', objects: [Customer, Order], actions: [restock] })
  defineOntology({ name: 'x', objects: [Customer, Order, Product], links: [orderProducts], actions: [restock] })

  // ── Reads infer their result from the name ──
  const order = rt.get('Order', 'O1', actor)
  assertType<Same<typeof order, OrderRow | undefined>>()

  const orders = rt.traverse('customerOrders', 'C1', actor)
  assertType<Same<typeof orders, OrderRow[]>>()

  const customers = rt.traverse('customerOrders', 'O1', { ...actor, direction: 'reverse' })
  assertType<Same<typeof customers, CustomerRow[]>>()

  // ── traverse decides its end from the shape of the options, not from an inferred direction ──
  // An optional 'reverse' may be absent at runtime, and then the traversal runs forward.
  const maybeReverse: { actor: string; direction?: 'reverse' } = actor
  const either = rt.traverse('customerOrders', 'C1', maybeReverse)
  assertType<Same<typeof either, (CustomerRow | OrderRow)[]>>()
  const maybeForward: { actor: string; direction?: 'forward' } = actor
  const stillForward = rt.traverse('customerOrders', 'C1', maybeForward)
  assertType<Same<typeof stillForward, OrderRow[]>>()
  const explicitForward = rt.traverse('customerOrders', 'C1', { ...actor, direction: 'forward' })
  assertType<Same<typeof explicitForward, OrderRow[]>>()
  const decideLater = (
    direction: Direction,
    maybe: Direction | undefined,
    // A union of option shapes: `keyof` alone would see only the common key.
    oneOrTheOther: { actor: string } | { actor: string; direction: 'reverse' },
    flag: boolean,
  ) => {
    const chosen = rt.traverse('customerOrders', 'C1', { ...actor, direction })
    assertType<Same<typeof chosen, (CustomerRow | OrderRow)[]>>()
    const maybeChosen = rt.traverse('customerOrders', 'C1', { ...actor, direction: maybe })
    assertType<Same<typeof maybeChosen, (CustomerRow | OrderRow)[]>>()
    const eitherShape = rt.traverse('customerOrders', 'C1', oneOrTheOther)
    assertType<Same<typeof eitherShape, (CustomerRow | OrderRow)[]>>()
    const builtOnTheSpot = rt.traverse('customerOrders', 'C1', flag ? { ...actor, direction: 'reverse' as const } : actor)
    assertType<Same<typeof builtOnTheSpot, (CustomerRow | OrderRow)[]>>()
  }
  void decideLater

  const pending = rt.search('Order', { ...actor, filter: { status: 'pending' } })
  assertType<Same<typeof pending, OrderRow[]>>()
  rt.search('Order', { ...actor, filter: (o) => o.total > 100 })

  rt.aggregate('Order', { ...actor, groupBy: (o) => o.status, sum: (o) => o.total })

  // ── Writes and snapshots are checked against the model ──
  rt.execute('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor)
  rt.auditLog({ action: 'cancelOrder' })
  rt.load({
    objects: {
      Customer: [{ id: 'C1', name: 'Yamada' }],
      Order: [{ id: 'O1', status: 'pending', total: 100 }],
    },
    links: { customerOrders: [['C1', 'O1']] },
  })

  // ── What the types refuse, before the runtime ever would ──
  // @ts-expect-error unknown object type
  rt.get('Invoice', 'X', actor)
  // @ts-expect-error unknown link type
  rt.traverse('orderLines', 'O1', actor)
  // @ts-expect-error a filter value outside the enum
  rt.search('Order', { ...actor, filter: { status: 'lost' } })
  // @ts-expect-error only numeric properties are summable
  rt.aggregate('Order', { ...actor, groupBy: (o) => o.status, sum: (o) => o.id })
  // @ts-expect-error unknown action
  rt.execute('deleteEverything', {}, actor)
  // @ts-expect-error a required param is missing
  rt.execute('cancelOrder', { orderId: 'O1' }, actor)
  // @ts-expect-error unknown action in an audit filter
  rt.auditLog({ action: 'deleteEverything' })
  // @ts-expect-error unknown object type in a snapshot
  rt.load({ objects: { Invoice: [] } })

  // ── A definition typed only as OntologyDef keeps the untyped contract ──
  const loose = createRuntime(model as OntologyDef, new Database(':memory:'))
  const anything: Record<string, unknown> | undefined = loose.get('Whatever', 'x', actor)
  void anything
  loose.execute('whatever', { anything: 'goes' }, actor)
  loose.load({ objects: { Whatever: [] } })
}

test('the typed definitions and calls read and write the same store as before', () => {
  const rt = createRuntime(model, new Database(':memory:'), { writeback: { apply: () => {} } })
  rt.load({
    objects: {
      Customer: [{ id: 'C1', name: 'Yamada' }],
      Order: [
        { id: 'O1', status: 'pending', total: 100 },
        { id: 'O2', status: 'shipped', total: 250 },
      ],
    },
    links: { customerOrders: [['C1', 'O1'], ['C1', 'O2']] },
  })
  const [customer] = rt.traverse('customerOrders', 'O1', { ...actor, direction: 'reverse' })
  assert.equal(customer?.name, 'Yamada')
  assert.deepEqual(rt.traverse('customerOrders', 'C1', actor).map((o) => o.status), ['pending', 'shipped'])
  // An optional 'reverse' that is absent at runtime runs forward: orders come back, and
  // the type above admits them (the hole a review of this change found).
  const maybeReverse: { actor: string; direction?: 'reverse' } = actor
  assert.deepEqual(rt.traverse('customerOrders', 'C1', maybeReverse).map((o) => o.id), ['O1', 'O2'])
  // A union of option shapes is decided per member: the reverse member comes back as customers,
  // and the type admits both — a second review found this one.
  const read = (pk: string, opts: { actor: string } | { actor: string; direction: 'reverse' }) =>
    rt.traverse('customerOrders', pk, opts).map((o) => o.id)
  assert.deepEqual(read('C1', actor), ['O1', 'O2'])
  assert.deepEqual(read('O1', { ...actor, direction: 'reverse' }), ['C1'])
  // The typed rule refuses, the typed edit applies, and the audit names the object type.
  const refused = rt.execute('cancelOrder', { orderId: 'O2', reason: 'late' }, actor)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.error.code, 'SHIPPED')
  const applied = rt.execute('cancelOrder', { orderId: 'O1', reason: 'late' }, actor)
  assert.deepEqual(applied, {
    ok: true,
    edits: [{ op: 'modify', object: 'Order', pk: 'O1', changes: { status: 'cancelled' } }],
  })
  assert.equal(rt.get('Order', 'O1', actor)?.status, 'cancelled')
  assert.equal(rt.auditLog({ status: 'applied' })[0]?.target, 'Order/O1')
  assert.deepEqual(rt.aggregate('Order', { ...actor, groupBy: (o) => o.status, sum: (o) => o.total }), {
    cancelled: { count: 1, sum: 100 },
    shipped: { count: 1, sum: 250 },
  })
  // The untyped fallback answers the same questions with open records.
  const loose = createRuntime(model as OntologyDef, new Database(':memory:'))
  loose.load({ objects: { Customer: [{ id: 'C1', name: 'Yamada' }] } })
  assert.equal(loose.get('Customer', 'C1', actor)?.name, 'Yamada')
})

test('defineOntology refuses references that point outside the model, and duplicate names', () => {
  const Product = defineObject('Product', { primaryKey: 'id', properties: { id: z.string() } })
  const orderProducts = defineLink('orderProducts', { from: Order, to: Product, kind: 'many-to-many' })
  assert.throws(
    () => defineOntology({ name: 'x', objects: [Customer, Order], links: [orderProducts as never] }),
    /link "orderProducts" references object type "Product"/,
  )
  const restock = defineAction('restock', {
    object: Product,
    targetParam: 'id',
    params: { id: z.string() },
    preconditions: [],
    effects: () => [],
  })
  assert.throws(
    () => defineOntology({ name: 'x', objects: [Customer, Order], actions: [restock as never] }),
    /action "restock" references object type "Product"/,
  )
  // Same name, different definition: identity is the definition, the name is its handle.
  const Order2 = defineObject('Order', { primaryKey: 'id', properties: { id: z.string() } })
  assert.throws(() => defineOntology({ name: 'x', objects: [Order, Order2] }), /two object types are named "Order"/)
})
