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
  link,
  modify,
  reject,
  remove,
  unlink,
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
    reassignOrder: defineAction({
      // Rewires the graph itself: unlink + link + modify, atomically.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), toCustomerId: z.string() },
      preconditions: [
        ({ object }) =>
          object.status === 'shipped'
            ? reject('SHIPPED_ORDER_CANNOT_BE_REASSIGNED', `order ${object.id} has already shipped`)
            : undefined,
      ],
      effects: ({ object, params }) => [
        unlink('customerOrders', object.customerId as string, object.id as string),
        link('customerOrders', params.toCustomerId as string, object.id as string),
        modify('Order', object.id as string, { customerId: params.toCustomerId }),
      ],
    }),
    sloppyReassign: defineAction({
      // Forgets the unlink — the runtime's cardinality check must catch it.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), toCustomerId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [
        link('customerOrders', params.toCustomerId as string, object.id as string),
      ],
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
    purgeOrder: defineAction({
      // Deletes without unlinking — the RESTRICT rule must catch it.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [remove('Order', object.id as string)],
    }),
    scrapOrder: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [
        unlink('customerOrders', object.customerId as string, object.id as string),
        remove('Order', object.id as string),
      ],
    }),
    mangleId: defineAction({
      // Tries to rewrite the primary key — the runtime must refuse.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { id: 'HIJACKED' })],
    }),
  },
})

const SNAPSHOT = {
  objects: {
    Customer: [
      { id: 'C1', name: 'Yamada' },
      { id: 'C2', name: 'Sato' },
    ],
    Order: [
      { id: 'O1', customerId: 'C1', status: 'shipped', total: 100 },
      { id: 'O2', customerId: 'C1', status: 'pending', total: 200 },
    ],
  },
  links: { customerOrders: [['C1', 'O1'], ['C1', 'O2']] as Array<[string, string]> },
}

function setup(adapter?: WritebackAdapter) {
  const rt = createRuntime(
    ontology,
    new Database(':memory:'),
    adapter ? { writeback: adapter } : { writeback: noopAdapter() },
  )
  rt.load(SNAPSHOT)
  return rt
}

const asTest = { actor: 'test' }

const noopAdapter = (): WritebackAdapter => ({ name: 'noop', apply: () => {} })

test('a business rule refuses the write with a machine-readable error', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'O1', reason: 'changed mind' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'SHIPPED_ORDER_CANNOT_BE_CANCELLED')
  assert.equal(rt.get<{ status: string }>('Order', 'O1', asTest)!.status, 'shipped') // unchanged
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
  assert.equal(rt.get<{ status: string }>('Order', 'O2', asTest)!.status, 'cancelled')
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

test('attempts that never reach the model are audited too', () => {
  const rt = setup()
  rt.execute('dropAllTables', {}, { actor: 'test' })
  rt.execute('cancelOrder', { orderId: 'O2', reason: '' }, { actor: 'test' })
  const rejected = rt.auditLog({ status: 'rejected' })
  assert.deepEqual(rejected.map((e) => e.error?.code), ['UNKNOWN_ACTION', 'INVALID_PARAMS'])
  assert.equal(rejected[0].target, '(unknown action)')
  assert.equal(rejected[1].target, 'Order/O2')
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
  assert.equal(rt.get<{ status: string }>('Order', 'O2', asTest)!.status, 'pending') // …but nothing changed here
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('a failing commit rolls back completely (no partial edits, no orphan applied rows)', () => {
  const rt = setup()
  assert.throws(() => rt.execute('corruptOrder', { orderId: 'O2' }, { actor: 'test' }))
  assert.equal(rt.get<{ status: string }>('Order', 'O2', asTest)!.status, 'pending')
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
  // The crashed attempt itself is still on the record.
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'COMMIT_FAILED')
})

test('actions can rewire the graph itself — links are edits too', () => {
  const rt = setup()
  const result = rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C1', asTest).map((o) => o.id), ['O1'])
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C2', asTest).map((o) => o.id), ['O2'])
  assert.equal(rt.get<{ customerId: string }>('Order', 'O2', asTest)!.customerId, 'C2')
})

test('linking to a missing object rolls back the whole action', () => {
  const rt = setup()
  assert.throws(() => rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'GHOST' }, { actor: 'test' }))
  // The unlink that ran before the failing link is rolled back too.
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C1', asTest).map((o) => o.id), ['O1', 'O2'])
  assert.equal(rt.get<{ customerId: string }>('Order', 'O2', asTest)!.customerId, 'C1')
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('one-to-many cardinality is enforced at the write gate', () => {
  const rt = setup()
  // Linking O2 to C2 without unlinking C1 first would give the order two customers.
  assert.throws(
    () => rt.execute('sloppyReassign', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' }),
    /one-to-many/,
  )
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'O2', { ...asTest, direction: 'reverse' }).map((c) => c.id), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('links traverse in both directions', () => {
  const rt = setup()
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'C1', asTest).map((o) => o.id),
    ['O1', 'O2'],
  )
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'O2', { ...asTest, direction: 'reverse' }).map((c) => c.id),
    ['C1'],
  )
})

test('delete is RESTRICT: a linked object refuses to die — unlink first', () => {
  const rt = setup()
  assert.throws(() => rt.execute('purgeOrder', { orderId: 'O2' }, { actor: 'test' }), /unlink first/)
  assert.notEqual(rt.get('Order', 'O2', asTest), undefined)
  assert.equal(rt.execute('scrapOrder', { orderId: 'O2' }, { actor: 'test' }).ok, true)
  assert.equal(rt.get('Order', 'O2', asTest), undefined)
})

test('the primary key cannot be modified', () => {
  const rt = setup()
  assert.throws(() => rt.execute('mangleId', { orderId: 'O2' }, { actor: 'test' }), /primary key/)
  assert.notEqual(rt.get('Order', 'O2', asTest), undefined)
})

test('re-loading is snapshot replacement — links reset instead of merging', () => {
  const rt = setup()
  rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  rt.load(SNAPSHOT)
  // The edited link is gone; the snapshot's view is back, with a single parent.
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'O2', { ...asTest, direction: 'reverse' }).map((c) => c.id),
    ['C1'],
  )
})

test('the indexed snapshot must satisfy the model constraints too', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () =>
      rt.load({
        objects: {
          Customer: [
            { id: 'C1', name: 'A' },
            { id: 'C2', name: 'B' },
          ],
          Order: [{ id: 'O1', customerId: 'C1', status: 'pending', total: 1 }],
        },
        links: { customerOrders: [['C1', 'O1'], ['C2', 'O1']] },
      }),
    /one-to-many/,
  )
})

test('aggregation happens at query time', () => {
  const rt = setup()
  const byStatus = rt.aggregate<{ status: string; total: number }>('Order', {
    ...asTest,
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

// ── Visibility: the read-side twin of preconditions ──

const visOntology = defineOntology({
  name: 'vis',
  objects: {
    Doc: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), owner: z.string(), title: z.string() },
      visibility: ({ object, actor }) => actor === object.owner || actor === 'user:auditor',
    }),
    Comment: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), docId: z.string(), text: z.string() },
    }),
  },
  links: {
    docComments: defineLink({ from: 'Doc', to: 'Comment', kind: 'one-to-many' }),
  },
  actions: {
    renameDoc: defineAction({
      object: 'Doc',
      targetParam: 'docId',
      params: { docId: z.string(), title: z.string().min(1) },
      preconditions: [],
      effects: ({ object, params }) => [modify('Doc', object.id as string, { title: params.title })],
    }),
  },
})

function visSetup() {
  const rt = createRuntime(visOntology, new Database(':memory:'))
  rt.load({
    objects: {
      Doc: [
        { id: 'D1', owner: 'user:alice', title: 'alpha' },
        { id: 'D2', owner: 'user:bob', title: 'beta' },
      ],
      Comment: [{ id: 'CM1', docId: 'D2', text: 'looks good' }],
    },
    links: { docComments: [['D2', 'CM1']] },
  })
  return rt
}

test('visibility lives in the model: the same search returns different worlds', () => {
  const rt = visSetup()
  assert.deepEqual(rt.search<{ id: string }>('Doc', { actor: 'user:alice' }).map((d) => d.id), ['D1'])
  assert.deepEqual(rt.search<{ id: string }>('Doc', { actor: 'user:auditor' }).map((d) => d.id), ['D1', 'D2'])
})

test('a hidden origin leaks nothing through traversal', () => {
  const rt = visSetup()
  assert.deepEqual(rt.traverse('docComments', 'D2', { actor: 'user:alice' }), [])
  assert.equal(rt.traverse('docComments', 'D2', { actor: 'user:bob' }).length, 1)
})

test('a hidden object is indistinguishable from a nonexistent one — even as an action target', () => {
  const rt = visSetup()
  assert.equal(rt.get('Doc', 'D2', { actor: 'user:alice' }), undefined)
  const result = rt.execute('renameDoc', { docId: 'D2', title: 'x' }, { actor: 'user:alice' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TARGET_NOT_FOUND') // no existence leak
  // The owner performs the same action without friction.
  assert.equal(rt.execute('renameDoc', { docId: 'D2', title: 'x' }, { actor: 'user:bob' }).ok, true)
})
