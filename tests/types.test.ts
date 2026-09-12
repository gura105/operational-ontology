/** Model-derived call sites. tsc checks the uncalled block and every @ts-expect-error. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  createRuntime, defineAction, defineLink, defineObject, defineOntology, modify, reject,
  type Direction, type ObjectInstance, type ObjectOf, type ParamsOf, type TraverseOptions,
} from '../src/index.js'

const objects = {
  Customer: defineObject({ primaryKey: 'id', properties: { id: z.string(), name: z.string() } }),
  Order: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), status: z.enum(['pending', 'shipped', 'cancelled']), total: z.number().int() },
  }),
  Employee: defineObject({
    primaryKey: 'employeeId',
    properties: { employeeId: z.string(), name: z.string(), owner: z.string() },
    visibility: ({ object, actor }) => actor === 'admin' || object.properties.owner === actor,
  }),
}
const model = defineOntology({
  name: 'typed', objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
    manages: defineLink({ from: 'Employee', to: 'Employee', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order', targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [({ object }) => object.properties.status === 'shipped'
        ? reject('SHIPPED', `order ${object.pk} has shipped`) : undefined],
      effects: ({ object, params }) => {
        assert.equal(object.type, 'Order')
        assert.equal(typeof params.reason, 'string')
        return [modify(object, { status: 'cancelled' })]
      },
      writeback: true,
    }),
  },
})

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertType = <_T extends true>(): void => {}
type Customer = ObjectInstance<'Customer', { id: string; name: string }>
type Order = ObjectInstance<'Order', { id: string; status: 'pending' | 'shipped' | 'cancelled'; total: number }>
type Employee = ObjectOf<typeof model, 'Employee'>
const actor = { actor: 'admin' }

assertType<Same<ObjectOf<typeof model, 'Customer'>, Customer>>()
assertType<Same<ObjectOf<typeof model, 'Order'>, Order>>()
assertType<Same<ParamsOf<typeof model, 'cancelOrder'>, { orderId: string; reason: string }>>()

export function compileOnly(rt: ReturnType<typeof createRuntime<typeof model>>, direction: Direction): void {
  const maybeOrder = rt.get('Order', 'O1', actor)
  assertType<Same<typeof maybeOrder, Order | undefined>>()
  const order = maybeOrder!
  const customer = rt.get('Customer', 'C1', actor)!
  const employee = rt.get('Employee', 'E1', actor)!
  const orders = rt.traverse(customer, 'customerOrders', actor)
  const customers = rt.traverse(order, 'customerOrders', actor)
  assertType<Same<typeof orders, Order[]>>()
  assertType<Same<typeof customers, Customer[]>>()
  rt.traverse(customer, 'customerOrders', { ...actor, direction: 'forward' })
  const maybeReverse: TraverseOptions<typeof model, 'Order', 'customerOrders'> = actor
  const stillCustomers = rt.traverse(order, 'customerOrders', maybeReverse)
  assertType<Same<typeof stillCustomers, Customer[]>>()
  const employees = rt.traverse(employee, 'manages', { ...actor, direction })
  assertType<Same<typeof employees, Employee[]>>()

  // A union retains the tag/properties relationship; narrow before traversing.
  const either = rt.get(Math.random() ? 'Order' : 'Customer', 'shared-id', actor)!
  if (either.type === 'Order') {
    assertType<Same<typeof either, Order>>()
    const result = rt.traverse(either, 'customerOrders', actor)
    assertType<Same<typeof result, Customer[]>>()
  }
  const pending = rt.search('Order', { ...actor, filter: { status: 'pending' } })
  assertType<Same<typeof pending, Order[]>>()
  rt.search('Order', { ...actor, filter: (o) => o.properties.total > 100 && o.type === 'Order' })
  rt.aggregate('Order', { ...actor, groupBy: (o) => o.properties.status, sum: (o) => o.properties.total })
  rt.execute('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor)
  rt.auditLog({ action: 'cancelOrder' })
  rt.load({ objects: { Customer: [{ id: 'C1', name: 'Yamada' }] }, links: { customerOrders: [] } })
  modify(order, { status: 'cancelled' })

  // @ts-expect-error tags are read-only
  order.type = 'Order'
  // @ts-expect-error business properties are nested
  order.status
  // @ts-expect-error unknown object type
  rt.get('Invoice', 'X', actor)
  // @ts-expect-error unknown link
  rt.traverse(order, 'orderLines', actor)
  // @ts-expect-error an unrelated link cannot widen the source type
  rt.traverse(order, 'manages', { ...actor, direction: 'forward' })
  // @ts-expect-error the opposite direction cannot widen the source type
  rt.traverse(customer, 'customerOrders', { ...actor, direction: 'reverse' })
  // @ts-expect-error reverse is the only possible direction from Order
  rt.traverse(order, 'customerOrders', { ...actor, direction: 'forward' })
  // @ts-expect-error same-type links require direction even when the value is in a variable
  rt.traverse(employee, 'manages', actor)
  // @ts-expect-error undefined is not a choice of direction
  rt.traverse(employee, 'manages', { ...actor, direction: undefined })
  const maybeDirection: { actor: string; direction?: Direction } = actor
  // @ts-expect-error optional direction cannot satisfy a same-type link
  rt.traverse(employee, 'manages', maybeDirection)
  // @ts-expect-error a primary key alone is not an instance
  rt.traverse('C1', 'customerOrders', actor)
  // @ts-expect-error a reference without properties is not an instance
  rt.traverse({ type: 'Customer', pk: 'C1' }, 'customerOrders', actor)
  // @ts-expect-error properties must match the tag
  rt.traverse({ type: 'Customer', pk: order.pk, properties: order.properties }, 'customerOrders', actor)
  // @ts-expect-error dynamic unvalidated names do not match a model link
  rt.traverse(customer, 'customerOrders' as string, actor)
  // @ts-expect-error a filter value outside the enum
  rt.search('Order', { ...actor, filter: { status: 'lost' } })
  // @ts-expect-error only numeric values are summable
  rt.aggregate('Order', { ...actor, groupBy: (o) => o.type, sum: (o) => o.pk })
  // @ts-expect-error unknown action
  rt.execute('deleteEverything', {}, actor)
  // @ts-expect-error a required param is missing
  rt.execute('cancelOrder', { orderId: 'O1' }, actor)
  // @ts-expect-error unknown action in an audit filter
  rt.auditLog({ action: 'deleteEverything' })
  // @ts-expect-error unknown object type in a snapshot
  rt.load({ objects: { Invoice: [] } })
  // @ts-expect-error invalid property name
  modify(order, { name: 'x' })
  // @ts-expect-error invalid enum value
  modify(order, { status: 'lost' })
  defineAction(objects, {
    object: 'Order', targetParam: 'orderId', params: { orderId: z.string(), count: z.number() },
    preconditions: [({ object, params }) => {
      assertType<Same<typeof object, Order>>()
      assertType<Same<typeof params.count, number>>()
      // @ts-expect-error action callbacks have model-derived properties
      object.properties.name
      // @ts-expect-error action callbacks have schema-derived params
      params.reason
    }], effects: () => [],
  })
  defineAction(objects, {
    // @ts-expect-error action targets must be in the object definitions
    object: 'Invoice', targetParam: 'id', params: { id: z.string() }, preconditions: [], effects: () => [],
  })
}

function setup() {
  const rt = createRuntime(model, new Database(':memory:'), { writeback: { apply: () => {} } })
  rt.load({
    objects: {
      Customer: [{ id: 'C1', name: 'Yamada' }],
      Order: [{ id: 'O1', status: 'pending', total: 100 }, { id: 'O2', status: 'shipped', total: 200 }],
      Employee: [
        { employeeId: 'E1', name: 'Aki', owner: 'alice' },
        { employeeId: 'E2', name: 'Ren', owner: 'alice' },
        { employeeId: 'E3', name: 'Mio', owner: 'bob' },
      ],
    },
    links: { customerOrders: [['C1', 'O1'], ['C1', 'O2']], manages: [['E1', 'E2'], ['E2', 'E3']] },
  })
  return rt
}

test('reads, traversal, callbacks and action targets share the instance shape', () => {
  const rt = setup()
  const customer = rt.get('Customer', 'C1', actor)!
  assert.deepEqual(customer, { type: 'Customer', pk: 'C1', properties: { id: 'C1', name: 'Yamada' } })
  const orders = rt.traverse(customer, 'customerOrders', actor)
  assert.deepEqual(orders.map((o) => o.pk), ['O1', 'O2'])
  assert.deepEqual(rt.traverse(orders[0], 'customerOrders', actor), [customer])
  assert.deepEqual(rt.search('Order', { ...actor, filter: (o) => o.properties.status === 'pending' }), [orders[0]])
  assert.deepEqual(rt.aggregate('Order', {
    ...actor, filter: { status: 'pending' }, groupBy: (o) => o.type, sum: (o) => o.properties.total,
  }), { Order: { count: 1, sum: 100 } })
  assert.equal(rt.execute('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor).ok, true)
  assert.equal(rt.get('Order', 'O1', actor)!.properties.status, 'cancelled')
  assert.equal(orders[0].properties.status, 'pending', 'an earlier read is a snapshot')
  assert.equal(rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, actor).ok, false)
})

test('same-type links require direction even at an endpoint with only incoming or outgoing edges', () => {
  const rt = setup()
  const ren = rt.get('Employee', 'E2', actor)!
  assert.deepEqual(rt.traverse(ren, 'manages', { ...actor, direction: 'reverse' }).map((o) => o.properties.name), ['Aki'])
  assert.deepEqual(rt.traverse(ren, 'manages', { ...actor, direction: 'forward' }).map((o) => o.properties.name), ['Mio'])
  for (const employee of rt.search('Employee', actor)) {
    // @ts-expect-error runtime must also reject missing direction
    assert.throws(() => rt.traverse(employee, 'manages', actor), /requires a direction/)
  }
})

test('traversal validates source and direction and re-reads visibility from stored properties', () => {
  const rt = setup()
  const customer = rt.get('Customer', 'C1', actor)!
  // @ts-expect-error runtime defense against the opposite direction
  assert.throws(() => rt.traverse(customer, 'customerOrders', { ...actor, direction: 'reverse' }), /invalid direction/)
  // @ts-expect-error runtime defense against an unrelated link
  assert.throws(() => rt.traverse(customer, 'manages', { ...actor, direction: 'forward' }), /does not connect/)
  // @ts-expect-error runtime defense against the old reference API
  assert.throws(() => rt.traverse({ type: 'Customer', pk: 'C1' }, 'customerOrders', actor), /requires an object instance/)
  const ren = rt.get('Employee', 'E2', actor)!
  // @ts-expect-error runtime defense against a non-direction value
  assert.throws(() => rt.traverse(ren, 'manages', { ...actor, direction: null }), /invalid direction/)
  ren.properties.owner = 'bob'
  // A caller cannot supply visibility-granting properties. The stored owner is alice.
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'bob', direction: 'forward' }), [])
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'alice', direction: 'forward' }), [], 'hidden destination')
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'alice', direction: 'reverse' }).map((o) => o.pk), ['E1'])
  assert.deepEqual(rt.traverse({ ...customer, pk: 'missing' }, 'customerOrders', actor), [])
})

test('identity does not collide with business properties or primary keys in another type', () => {
  const model = defineOntology({
    name: 'identity',
    objects: {
      Left: defineObject({
        primaryKey: 'code',
        properties: { code: z.string(), type: z.string(), pk: z.string(), properties: z.string() },
      }),
      Right: defineObject({ primaryKey: 'key', properties: { key: z.string() } }),
    },
    links: { pair: defineLink({ from: 'Left', to: 'Right', kind: 'one-to-many' }) },
    actions: {},
  })
  const rt = createRuntime(model, new Database(':memory:'))
  const properties = { code: 'same', type: 'business type', pk: 'business pk', properties: 'business value' }
  rt.load({ objects: { Left: [properties], Right: [{ key: 'same' }] }, links: { pair: [['same', 'same']] } })
  const left = rt.get('Left', 'same', actor)!
  const right = rt.get('Right', 'same', actor)!
  assert.deepEqual(left, { type: 'Left', pk: 'same', properties })
  assert.deepEqual(rt.traverse(left, 'pair', actor), [right])
  assert.deepEqual(rt.traverse(right, 'pair', actor), [left])
  assert.deepEqual(rt.search('Left', { ...actor, filter: { type: 'business type' } }), [left])
  assert.deepEqual(modify(left, { type: 'new business type' }), {
    op: 'modify', object: 'Left', pk: 'same', changes: { type: 'new business type' },
  })
})
