/**
 * The specification, as executable tests. The first test is the reason this
 * repository exists: a business rule refusing a write with a machine-readable
 * error.
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
  type WritebackAdapter,
} from '../src/core.js'

const ontology = defineOntology({
  name: 'test',
  objects: {
    Customer: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), name: z.string() },
    }),
    Order: defineObject({
      primaryKey: 'id',
      properties: {
        id: z.string(),
        customerId: z.string(),
        status: z.enum(['pending', 'shipped', 'cancelled']),
        total: z.number(),
      },
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
        ({ object }) =>
          object.status === 'shipped'
            ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.id} has already shipped`)
            : undefined,
      ],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'cancelled' })],
      writeback: true,
    }),
    corruptOrder: defineAction({
      // Deliberately produces an edit that violates the Order schema —
      // used to prove that a failing commit leaves no partial state behind.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'bogus' })],
    }),
  },
})

function setup(adapter?: WritebackAdapter) {
  const rt = createRuntime(
    ontology,
    new Database(':memory:'),
    adapter ? { writeback: adapter } : { writeback: noopAdapter() },
  )
  rt.load({
    objects: {
      Customer: [{ id: 'C1', name: 'Yamada' }],
      Order: [
        { id: 'O1', customerId: 'C1', status: 'shipped', total: 100 },
        { id: 'O2', customerId: 'C1', status: 'pending', total: 200 },
      ],
    },
    links: { customerOrders: [['C1', 'O1'], ['C1', 'O2']] },
  })
  return rt
}

const noopAdapter = (): WritebackAdapter => ({ name: 'noop', apply: () => {} })

test('a business rule refuses the write with a machine-readable error', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'O1', reason: 'changed mind' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'SHIPPED_ORDER_CANNOT_BE_CANCELLED')
  assert.equal(rt.get<{ status: string }>('Order', 'O1')!.status, 'shipped') // unchanged
})

test('rejected attempts are recorded in the audit log', () => {
  const rt = setup()
  rt.execute('cancelOrder', { orderId: 'O1', reason: 'changed mind' }, { actor: 'test' })
  const entries = rt.auditLog({ status: 'rejected' })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].error?.code, 'SHIPPED_ORDER_CANNOT_BE_CANCELLED')
})

test('an allowed action applies its edits and audits them atomically', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.equal(rt.get<{ status: string }>('Order', 'O2')!.status, 'cancelled')
  const applied = rt.auditLog({ status: 'applied' })
  assert.equal(applied.length, 1)
  assert.deepEqual(applied[0].edits, [{ op: 'modify', object: 'Order', pk: 'O2', changes: { status: 'cancelled' } }])
})

test('invalid params are refused before anything runs', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: '' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_PARAMS')
})

test('a missing target is refused', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'NOPE', reason: 'x' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TARGET_NOT_FOUND')
})

test('an unknown action is refused', () => {
  const rt = setup()
  const result = rt.execute('dropAllTables', {}, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_ACTION')
})

test('write-back-first ordering: adapter failure blocks the ontology edit', () => {
  const calls: string[] = []
  const failing: WritebackAdapter = {
    name: 'failing-erp',
    apply: () => {
      calls.push('adapter')
      throw new Error('ERP is down')
    },
  }
  const rt = setup(failing)
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'WRITEBACK_FAILED')
  assert.deepEqual(calls, ['adapter']) // adapter ran…
  assert.equal(rt.get<{ status: string }>('Order', 'O2')!.status, 'pending') // …but nothing changed here
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('a failing commit rolls back completely (no partial edits, no orphan audit rows)', () => {
  const rt = setup()
  assert.throws(() => rt.execute('corruptOrder', { orderId: 'O2' }, { actor: 'test' }))
  assert.equal(rt.get<{ status: string }>('Order', 'O2')!.status, 'pending')
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('links traverse in both directions', () => {
  const rt = setup()
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'C1').map((o) => o.id),
    ['O1', 'O2'],
  )
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'O2', 'reverse').map((c) => c.id),
    ['C1'],
  )
})

test('aggregation happens at query time', () => {
  const rt = setup()
  const byStatus = rt.aggregate<{ status: string; total: number }>('Order', {
    groupBy: (o) => o.status,
    sum: (o) => o.total,
  })
  assert.deepEqual(byStatus, { shipped: { count: 1, sum: 100 }, pending: { count: 1, sum: 200 } })
})

test('indexing validates rows against the model', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(() =>
    rt.load({ objects: { Order: [{ id: 'O9', customerId: 'C1', status: 'teleported', total: 1 }] } }),
  )
})
