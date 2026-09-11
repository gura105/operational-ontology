/**
 * Type-level tests: the runtime's call sites are typed by the model they
 * were built from. `pnpm typecheck` is the real test here — an
 * `@ts-expect-error` that stops erroring fails it. The compile-only block is
 * never called, because most of what the types refuse the runtime refuses
 * too, by throwing; the one runtime test at the bottom keeps the typed calls
 * honest under `pnpm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  createRuntime,
  defineAction,
  defineLink,
  defineObject,
  defineOntology,
  modify,
  reject,
  type Direction,
  type ObjectOf,
  type OntologyDef,
  type ParamsOf,
} from '../src/core.js'

const model = defineOntology({
  name: 'typed',
  objects: {
    Customer: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), name: z.string() },
    }),
    Order: defineObject({
      primaryKey: 'id',
      properties: {
        id: z.string(),
        status: z.enum(['pending', 'shipped', 'cancelled']),
        total: z.number().int(),
        assignee: z.string().nullable(),
      },
      owned: { assignee: null },
    }),
  },
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [
        ({ object }) => (object.status === 'shipped' ? reject('SHIPPED', `order ${object.id} has shipped`) : undefined),
      ],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'cancelled' })],
      writeback: true,
    }),
  },
})

// Mutual assignability — what a caller can rely on, without depending on
// how zod spells its inferred object types.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertType = <_T extends true>(): void => {}

type Customer = { id: string; name: string }
type Order = { id: string; status: 'pending' | 'shipped' | 'cancelled'; total: number; assignee: string | null }

const actor = { actor: 'user:test' }

// ── Model-derived types are what the definition says ──
assertType<Same<ObjectOf<typeof model, 'Customer'>, Customer>>()
assertType<Same<ObjectOf<typeof model, 'Order'>, Order>>()
assertType<Same<ParamsOf<typeof model, 'cancelOrder'>, { orderId: string; reason: string }>>()

// Checked by tsc, never run: the runtime throws on most of these, on purpose.
export function compileOnly(rt: ReturnType<typeof createRuntime<typeof model>>): void {
  // ── Reads infer their result from the name ──
  const order = rt.get('Order', 'O1', actor)
  assertType<Same<typeof order, Order | undefined>>()

  const orders = rt.traverse('customerOrders', 'C1', actor)
  assertType<Same<typeof orders, Order[]>>()

  const customers = rt.traverse('customerOrders', 'O1', { ...actor, direction: 'reverse' })
  assertType<Same<typeof customers, Customer[]>>()

  // ── traverse decides its end from the shape of the options, not from an inferred direction ──
  // An optional 'reverse' may be absent at runtime, and then the traversal runs forward.
  const maybeReverse: { actor: string; direction?: 'reverse' } = actor
  const either = rt.traverse('customerOrders', 'C1', maybeReverse)
  assertType<Same<typeof either, (Customer | Order)[]>>()
  const maybeForward: { actor: string; direction?: 'forward' } = actor
  const stillForward = rt.traverse('customerOrders', 'C1', maybeForward)
  assertType<Same<typeof stillForward, Order[]>>()
  const explicitForward = rt.traverse('customerOrders', 'C1', { ...actor, direction: 'forward' })
  assertType<Same<typeof explicitForward, Order[]>>()
  const decideLater = (direction: Direction, maybe?: Direction) => {
    const chosen = rt.traverse('customerOrders', 'C1', { ...actor, direction })
    assertType<Same<typeof chosen, (Customer | Order)[]>>()
    const maybeChosen = rt.traverse('customerOrders', 'C1', { ...actor, direction: maybe })
    assertType<Same<typeof maybeChosen, (Customer | Order)[]>>()
  }
  void decideLater

  const pending = rt.search('Order', { ...actor, filter: { status: 'pending' } })
  assertType<Same<typeof pending, Order[]>>()
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

test('the typed calls read and write the same store as before', () => {
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
  assert.equal(rt.execute('cancelOrder', { orderId: 'O2', reason: 'late' }, actor).ok, false)
  assert.equal(rt.execute('cancelOrder', { orderId: 'O1', reason: 'late' }, actor).ok, true)
  assert.equal(rt.get('Order', 'O1', actor)?.status, 'cancelled')
  assert.deepEqual(rt.aggregate('Order', { ...actor, groupBy: (o) => o.status, sum: (o) => o.total }), {
    cancelled: { count: 1, sum: 100 },
    shipped: { count: 1, sum: 250 },
  })
  // The untyped fallback answers the same questions with open records.
  const loose = createRuntime(model as OntologyDef, new Database(':memory:'))
  loose.load({ objects: { Customer: [{ id: 'C1', name: 'Yamada' }] } })
  assert.equal(loose.get('Customer', 'C1', actor)?.name, 'Yamada')
})
