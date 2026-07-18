/**
 * The behavior, as executable tests. The first test is the reason this
 * repository exists: a business rule refusing a write with a machine-readable
 * error.
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
        assignee: z.string().nullable(),
      },
      // The authority line, drawn per property: assignee is ontology-owned,
      // everything else is source-backed.
      owned: { assignee: null },
    }),
    Task: defineObject({
      // The whole type is ontology-owned — existence included.
      primaryKey: 'id',
      owned: true,
      properties: { id: z.string(), title: z.string() },
    }),
  },
  links: {
    customerOrders: defineLink({
      from: 'Customer',
      to: 'Order',
      kind: 'one-to-many',
      viaProperty: 'customerId',
    }),
    orderTasks: defineLink({ from: 'Order', to: 'Task', kind: 'one-to-many', owned: true }),
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
    setAssignee: defineAction({
      // Pure ontology-owned change: no write-back, survives re-indexing.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), assignee: z.string().nullable() },
      preconditions: [],
      effects: ({ object, params }) => [modify('Order', object.id as string, { assignee: params.assignee })],
    }),
    reassignOrder: defineAction({
      // Rewires the graph itself: unlink + link + modify, atomically. The FK
      // and its link twin are both source-backed, so the plan declares it.
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
      writeback: true,
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
      writeback: true,
    }),
    driftFk: defineAction({
      // Moves the FK property without moving the link — the two
      // representations of one fact would disagree.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), toCustomerId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [modify('Order', object.id as string, { customerId: params.toCustomerId })],
      writeback: true,
    }),
    sneakyCancel: defineAction({
      // Touches source-backed state without declaring write-back — the
      // shadow copy the fourth property forbids.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'cancelled' })],
    }),
    vainWriteback: defineAction({
      // Declares write-back but changes nothing a source owns.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { assignee: 'nobody' })],
      writeback: true,
    }),
    mixedTouch: defineAction({
      // One edit straddling the authority line.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'cancelled', assignee: 'x' })],
      writeback: true,
    }),
    mixedPlan: defineAction({
      // Two edits on opposite sides of the authority line.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [
        modify('Order', object.id as string, { status: 'cancelled' }),
        modify('Order', object.id as string, { assignee: 'x' }),
      ],
      writeback: true,
    }),
    conjureSource: defineAction({
      // A schema-valid creation of a source-backed object — undemonstrated
      // territory in v0.1, so refused by declaration.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [
        create('Order', 'N1', { id: 'N1', customerId: 'C1', status: 'pending', total: 1, assignee: null }),
      ],
      writeback: true,
    }),
    corruptOrder: defineAction({
      // Deliberately produces an edit that violates the Order schema —
      // used to prove the plan is refused before write-back ever runs.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'bogus' })],
      writeback: true,
    }),
    typoOrder: defineAction({
      // A typo'd property — must be refused, not silently stripped.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { vaporware: 1 })],
      writeback: true,
    }),
    conjureNoise: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [
        create('Order', 'N1', { id: 'N1', customerId: 'C1', status: 'pending', total: 1, ghost: true }),
      ],
      writeback: true,
    }),
    protoOrder: defineAction({
      // Prototype-chain names must not masquerade as model properties.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify('Order', object.id as string, { toString: 'gotcha' })],
      writeback: true,
    }),
    purgeOrder: defineAction({
      // Deletes without unlinking — the RESTRICT rule must catch it.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [remove('Order', object.id as string)],
      writeback: true,
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
      writeback: true,
    }),
    landmine: defineAction({
      // A crashing rule — must be audited as RULE_CRASHED, not lost.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [
        () => {
          throw new Error('precondition crashed')
        },
      ],
      effects: () => [],
    }),
    explodingEffects: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => {
        throw new Error('effects crashed')
      },
    }),
    conjureOrder: defineAction({
      // Creates with a pk that disagrees with the data — the runtime must refuse.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [
        create('Order', 'CLAIMED', { id: 'ACTUAL', customerId: 'C1', status: 'pending', total: 1, assignee: null }),
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
    openTask: defineAction({
      // Targetless: no pre-existing object is the subject.
      params: { taskId: z.string().min(1), title: z.string().min(1) },
      preconditions: [],
      effects: ({ params }) => [create('Task', params.taskId as string, { id: params.taskId, title: params.title })],
    }),
    attachTask: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), taskId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [link('orderTasks', object.id as string, params.taskId as string)],
    }),
    scrapTask: defineAction({
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), taskId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [
        unlink('orderTasks', object.id as string, params.taskId as string),
        remove('Task', params.taskId as string),
      ],
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
  // The plan that already left for the source is on the record — the
  // adapter may have partially applied it before throwing.
  const rejected = rt.auditLog({ status: 'rejected' })[0]
  assert.equal(rejected?.error?.code, 'WRITEBACK_FAILED')
  assert.deepEqual(rejected?.edits, [{ op: 'modify', object: 'Order', pk: 'O2', changes: { status: 'cancelled' } }])
})

test('statically invalid edits are refused before the adapter ever runs', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { name: 'spy', apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // All these actions declare writeback: true — the spy proves the plan
  // was refused before it could leave the process.
  const bogus = rt.execute('corruptOrder', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(bogus.ok, false)
  if (!bogus.ok) assert.equal(bogus.error.code, 'INVALID_EDITS')

  const typo = rt.execute('typoOrder', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(typo.ok, false)
  if (!typo.ok) {
    assert.equal(typo.error.code, 'INVALID_EDITS')
    assert.match(typo.error.message, /vaporware/) // refused, not silently stripped
  }

  const noise = rt.execute('conjureNoise', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(noise.ok, false)
  if (!noise.ok) assert.match(noise.error.message, /ghost/)

  // Prototype-chain names (toString, __proto__, …) are unknown keys too.
  const proto = rt.execute('protoOrder', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(proto.ok, false)
  if (!proto.ok) {
    assert.equal(proto.error.code, 'INVALID_EDITS')
    assert.match(proto.error.message, /toString/)
  }

  assert.deepEqual(calls, []) // the write-back adapter never saw a bad plan
  assert.equal(rt.get<{ status: string }>('Order', 'O2', asTest)!.status, 'pending')
  assert.equal(rt.auditLog({ status: 'rejected' }).length, 4)
})

test('DB-dependent violations are ALSO refused before the adapter runs (preflight)', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { name: 'spy', apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // A link to a customer that does not exist — provable only against the
  // store, and still refused before anything leaves the process.
  const result = rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'GHOST' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /does not exist/)
  }
  assert.deepEqual(calls, []) // the plan never reached the system of record
  // The dry run left no trace: the unlink that "ran" before the failing
  // link is rolled back with everything else.
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C1', asTest).map((o) => o.id), ['O1', 'O2'])
  assert.equal(rt.get<{ customerId: string }>('Order', 'O2', asTest)!.customerId, 'C1')
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('one-to-many cardinality is enforced at the write gate, before write-back', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { name: 'spy', apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // Linking O2 to C2 without unlinking C1 first would give the order two customers.
  const result = rt.execute('sloppyReassign', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /one-to-many/)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'O2', { ...asTest, direction: 'reverse' }).map((c) => c.id), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('the link and its foreign-key property twin must agree', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { name: 'spy', apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // Moving the property without moving the link leaves two representations
  // of one fact telling different stories.
  const result = rt.execute('driftFk', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /disagrees/)
  }
  assert.deepEqual(calls, [])
  assert.equal(rt.get<{ customerId: string }>('Order', 'O2', asTest)!.customerId, 'C1')
})

test('a commit failure after write-back is the declared divergence — audited with its edits', () => {
  const db = new Database(':memory:')
  // An adapter that succeeds against the source but sabotages the local
  // store — the mechanical stand-in for the declared reverse failure
  // (adapter succeeded, local commit failed).
  const saboteur: WritebackAdapter = {
    name: 'saboteur',
    apply: () => {
      db.prepare("UPDATE objects SET data = 'not json' WHERE pk = 'O2'").run()
    },
  }
  const rt = createRuntime(ontology, db, { writeback: saboteur })
  rt.load(SNAPSHOT)
  assert.throws(() => rt.execute('cancelOrder', { orderId: 'O2', reason: 'x' }, { actor: 'test' }))
  const rejected = rt.auditLog({ status: 'rejected' })[0]
  assert.equal(rejected?.error?.code, 'COMMIT_FAILED')
  // The edits are on the record even though they did not apply here: they
  // are what already reached the source — the raw material for reconciliation.
  assert.ok(rejected?.edits && rejected.edits.length > 0)
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

// ── The authority line ──

test('an undeclared write to source-backed state is refused as a shadow copy', () => {
  const rt = setup()
  const result = rt.execute('sneakyCancel', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'UNDECLARED_SOURCE_WRITE')
  assert.equal(rt.get<{ status: string }>('Order', 'O2', asTest)!.status, 'pending')
})

test('a declared write-back with nothing source-backed in the plan is refused', () => {
  const rt = setup()
  const result = rt.execute('vainWriteback', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'MISDECLARED_WRITEBACK')
})

test('a plan straddling the authority line is refused — within one edit or across edits', () => {
  const rt = setup()
  const withinOne = rt.execute('mixedTouch', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(withinOne.ok, false)
  if (!withinOne.ok) assert.equal(withinOne.error.code, 'MIXED_AUTHORITY')
  const acrossTwo = rt.execute('mixedPlan', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(acrossTwo.ok, false)
  if (!acrossTwo.ok) assert.equal(acrossTwo.error.code, 'MIXED_AUTHORITY')
})

test('creating a source-backed object is refused by declaration', () => {
  const rt = setup()
  const result = rt.execute('conjureSource', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'SOURCE_CREATE_UNSUPPORTED')
  assert.equal(rt.get('Order', 'N1', asTest), undefined)
})

// ── Re-indexing vs the edit layer ──

test('ontology-owned state survives a re-index; source-backed state refreshes', () => {
  const rt = setup()
  rt.execute('setAssignee', { orderId: 'O2', assignee: 'alice' }, { actor: 'test' })
  // The source moved on: O2 shipped upstream.
  const moved = structuredClone(SNAPSHOT)
  moved.objects.Order[1] = { id: 'O2', customerId: 'C1', status: 'shipped', total: 200 }
  rt.load(moved)
  const o2 = rt.get<{ status: string; assignee: string | null }>('Order', 'O2', asTest)!
  assert.equal(o2.status, 'shipped') // the source spoke, the base refreshed
  assert.equal(o2.assignee, 'alice') // the ontology's own state survived
})

test('an ontology-owned edit back at its default clears the survival obligation', () => {
  const rt = setup()
  rt.execute('setAssignee', { orderId: 'O2', assignee: 'alice' }, { actor: 'test' })
  rt.execute('setAssignee', { orderId: 'O2', assignee: null }, { actor: 'test' })
  // O2 disappears from the source. With the edit cleared there is nothing
  // to preserve, so the re-index goes through.
  const gone = {
    objects: { Customer: SNAPSHOT.objects.Customer, Order: [SNAPSHOT.objects.Order[0]] },
    links: { customerOrders: [['C1', 'O1']] as Array<[string, string]> },
  }
  rt.load(gone)
  assert.equal(rt.get('Order', 'O2', asTest), undefined)
})

test('a re-index that would drop surviving ontology-owned state is refused whole', () => {
  const rt = setup()
  rt.execute('setAssignee', { orderId: 'O2', assignee: 'alice' }, { actor: 'test' })
  const gone = {
    objects: { Customer: SNAPSHOT.objects.Customer, Order: [SNAPSHOT.objects.Order[0]] },
    links: { customerOrders: [['C1', 'O1']] as Array<[string, string]> },
  }
  assert.throws(() => rt.load(gone), /re-index conflict/)
  // Rolled back whole: the old base, the edit, everything still stands.
  const o2 = rt.get<{ assignee: string | null }>('Order', 'O2', asTest)!
  assert.equal(o2.assignee, 'alice')
})

test('a source snapshot cannot supply ontology-owned properties', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () =>
      rt.load({
        objects: {
          Order: [{ id: 'O9', customerId: 'C1', status: 'pending', total: 1, assignee: 'smuggled' }],
        },
      }),
    /ontology-owned/,
  )
})

test('a source snapshot cannot supply ontology-owned types or links', () => {
  const rt = setup()
  assert.throws(() => rt.load({ objects: { Task: [{ id: 'T9', title: 'x' }] } }), /no source supplies/)
  assert.throws(() => rt.load({ links: { orderTasks: [['O1', 'T9']] } }), /no source supplies/)
})

test('ontology-owned objects and links survive a re-index untouched', () => {
  const rt = setup()
  rt.execute('openTask', { taskId: 'T1', title: 'call the customer' }, { actor: 'test' })
  rt.execute('attachTask', { orderId: 'O2', taskId: 'T1' }, { actor: 'test' })
  rt.load(SNAPSHOT) // full re-index of everything a source supplies
  assert.equal(rt.get<{ title: string }>('Task', 'T1', asTest)!.title, 'call the customer')
  assert.deepEqual(rt.traverse<{ id: string }>('orderTasks', 'O2', asTest).map((t) => t.id), ['T1'])
})

// ── Targetless actions ──

test('a targetless action creates from nothing and is audited as such', () => {
  const rt = setup()
  const result = rt.execute('openTask', { taskId: 'T1', title: 'triage the backlog' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.equal(rt.get<{ title: string }>('Task', 'T1', asTest)!.title, 'triage the backlog')
  const applied = rt.auditLog({ status: 'applied' })[0]
  assert.equal(applied?.target, '(targetless)')
})

test('a targetless action still validates params and its edit plan', () => {
  const rt = setup()
  const bad = rt.execute('openTask', { taskId: '', title: 'x' }, { actor: 'test' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.code, 'INVALID_PARAMS')
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.target, '(targetless)')
  // A second creation with the same pk collides in the store.
  assert.equal(rt.execute('openTask', { taskId: 'T1', title: 'a' }, { actor: 'test' }).ok, true)
  const dup = rt.execute('openTask', { taskId: 'T1', title: 'b' }, { actor: 'test' })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.equal(dup.error.code, 'INVALID_EDITS')
})

test('deleting an ontology-owned object is an ontology edit — RESTRICT still applies', () => {
  const rt = setup()
  rt.execute('openTask', { taskId: 'T1', title: 'x' }, { actor: 'test' })
  rt.execute('attachTask', { orderId: 'O2', taskId: 'T1' }, { actor: 'test' })
  assert.equal(rt.execute('scrapTask', { orderId: 'O2', taskId: 'T1' }, { actor: 'test' }).ok, true)
  assert.equal(rt.get('Task', 'T1', asTest), undefined)
})

// ── Graph edits ──

test('actions can rewire the graph itself — links are edits too', () => {
  const rt = setup()
  const result = rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C1', asTest).map((o) => o.id), ['O1'])
  assert.deepEqual(rt.traverse<{ id: string }>('customerOrders', 'C2', asTest).map((o) => o.id), ['O2'])
  assert.equal(rt.get<{ customerId: string }>('Order', 'O2', asTest)!.customerId, 'C2')
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
  const blocked = rt.execute('purgeOrder', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.error.code, 'INVALID_EDITS')
    assert.match(blocked.error.message, /unlink first/)
  }
  assert.notEqual(rt.get('Order', 'O2', asTest), undefined)
  assert.equal(rt.execute('scrapOrder', { orderId: 'O2' }, { actor: 'test' }).ok, true)
  assert.equal(rt.get('Order', 'O2', asTest), undefined)
})

test('create refuses a pk that disagrees with the data — before write-back', () => {
  const rt = setup()
  const result = rt.execute('conjureOrder', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_EDITS')
  assert.equal(rt.get('Order', 'ACTUAL', asTest), undefined)
})

test('the primary key cannot be modified', () => {
  const rt = setup()
  const result = rt.execute('mangleId', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /primary key/)
  }
  assert.notEqual(rt.get('Order', 'O2', asTest), undefined)
})

// ── Crashes, storage faults, prototype names ──

test('prototype names are not actions, objects, or links', () => {
  const rt = setup()
  const result = rt.execute('toString', {}, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'UNKNOWN_ACTION')
  assert.throws(() => rt.get('toString', 'x', asTest), /unknown object type/)
  assert.throws(() => rt.traverse('toString', 'x', asTest), /unknown link type/)
})

test('a storage fault is audited as READ_FAILED', () => {
  const db = new Database(':memory:')
  const rt = createRuntime(ontology, db, { writeback: noopAdapter() })
  rt.load(SNAPSHOT)
  db.prepare("UPDATE objects SET data = 'not json' WHERE pk = 'O2'").run()
  assert.throws(() => rt.execute('cancelOrder', { orderId: 'O2', reason: 'x' }, { actor: 'test' }))
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'READ_FAILED')
})

test('crashing rules are audited too — RULE_CRASHED, then the error surfaces', () => {
  const rt = setup()
  assert.throws(() => rt.execute('landmine', { orderId: 'O2' }, { actor: 'test' }), /precondition crashed/)
  assert.throws(() => rt.execute('explodingEffects', { orderId: 'O2' }, { actor: 'test' }), /effects crashed/)
  const rejected = rt.auditLog({ status: 'rejected' })
  assert.deepEqual(rejected.map((e) => e.error?.code), ['RULE_CRASHED', 'RULE_CRASHED'])
})

// ── Indexing ──

test('re-loading resets source-backed links instead of merging', () => {
  const rt = setup()
  rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  rt.load(SNAPSHOT)
  // The local echo of the reassignment is gone; the snapshot's view is back.
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

test('the indexed snapshot must keep the link and its property twin agreeing', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () =>
      rt.load({
        objects: {
          Customer: [
            { id: 'C1', name: 'A' },
            { id: 'C2', name: 'B' },
          ],
          Order: [{ id: 'O1', customerId: 'C2', status: 'pending', total: 1 }],
        },
        links: { customerOrders: [['C1', 'O1']] },
      }),
    /disagrees/,
  )
})

test('a partial re-load that breaks surviving edits is refused whole', () => {
  const rt = setup()
  rt.execute('reassignOrder', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  // Re-load Customers without C2 — the surviving edited link would dangle.
  assert.throws(() => rt.load({ objects: { Customer: [{ id: 'C1', name: 'Yamada' }] } }), /does not exist/)
  // Rolled back whole: C2 and the edited link both survive.
  assert.notEqual(rt.get('Customer', 'C2', asTest), undefined)
  assert.deepEqual(
    rt.traverse<{ id: string }>('customerOrders', 'O2', { ...asTest, direction: 'reverse' }).map((c) => c.id),
    ['C2'],
  )
})

test('indexing validates rows against the model', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(() =>
    rt.load({ objects: { Order: [{ id: 'O9', customerId: 'C1', status: 'teleported', total: 1 }] } }),
  )
})

test('a link and its viaProperty twin cannot sit on opposite sides of the authority line', () => {
  assert.throws(
    () =>
      defineOntology({
        name: 'bad',
        objects: {
          Board: defineObject({ primaryKey: 'id', properties: { id: z.string() } }),
          Card: defineObject({
            primaryKey: 'id',
            properties: { id: z.string(), boardId: z.string() },
            owned: { boardId: '' },
          }),
        },
        // Source-backed link, ontology-owned property: one fact, two owners.
        links: { boardCards: defineLink({ from: 'Board', to: 'Card', kind: 'one-to-many', viaProperty: 'boardId' }) },
        actions: {},
      }),
    /opposite sides/,
  )
})

test('indexing refuses unknown keys instead of silently stripping them', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () => rt.load({ objects: { Customer: [{ id: 'C1', name: 'A', legacy_flag: 1 }] } }),
    /unknown property "legacy_flag"/,
  )
})

// ── Aggregation ──

test('aggregation happens at query time', () => {
  const rt = setup()
  const byStatus = rt.aggregate<{ status: string; total: number }>('Order', {
    ...asTest,
    groupBy: (o) => o.status,
    sum: (o) => o.total,
  })
  assert.deepEqual(byStatus, { shipped: { count: 1, sum: 100 }, pending: { count: 1, sum: 200 } })
})

test('aggregation is immune to prototype-named groups', () => {
  const rt = setup()
  const groups = rt.aggregate<{ id: string }>('Order', {
    ...asTest,
    groupBy: (o) => (o.id === 'O1' ? '__proto__' : 'toString'),
  })
  assert.equal(Object.getOwnPropertyDescriptor(groups, '__proto__')?.value?.count, 1)
  assert.equal(Object.getOwnPropertyDescriptor(groups, 'toString')?.value?.count, 1)
  assert.equal(({} as Record<string, unknown>).count, undefined) // Object.prototype untouched
})

// ── Visibility: the read-side twin of preconditions ──

const visOntology = defineOntology({
  name: 'vis',
  objects: {
    Doc: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), owner: z.string(), title: z.string() },
      owned: { title: 'untitled' },
      visibility: ({ object, actor }) => actor === object.owner || actor === 'user:auditor',
    }),
    Comment: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), docId: z.string(), text: z.string() },
    }),
    Trap: defineObject({
      primaryKey: 'id',
      properties: { id: z.string() },
      visibility: () => {
        throw new Error('visibility crashed')
      },
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
    springTrap: defineAction({
      object: 'Trap',
      targetParam: 'trapId',
      params: { trapId: z.string() },
      preconditions: [],
      effects: () => [],
    }),
  },
})

function visSetup() {
  const rt = createRuntime(visOntology, new Database(':memory:'))
  rt.load({
    objects: {
      Doc: [
        { id: 'D1', owner: 'user:alice' },
        { id: 'D2', owner: 'user:bob' },
      ],
      Comment: [{ id: 'CM1', docId: 'D2', text: 'looks good' }],
      Trap: [{ id: 'T1' }],
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

test('a crashing visibility predicate is audited as RULE_CRASHED', () => {
  const rt = visSetup()
  assert.throws(() => rt.execute('springTrap', { trapId: 'T1' }, { actor: 'user:alice' }), /visibility crashed/)
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'RULE_CRASHED')
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
