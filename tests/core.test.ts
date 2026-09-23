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
  unlink,
  type WritebackAdapter,
} from '../src/core.js'

const objects = {
  Customer: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), name: z.string() },
  }),
  Order: defineObject({
    primaryKey: 'id',
    properties: {
      id: z.string(),
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
}

const ontology = defineOntology({
  name: 'test',
  objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
    orderTasks: defineLink({ from: 'Order', to: 'Task', kind: 'one-to-many', owned: true }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [
        ({ object }) =>
          object.properties.status === 'shipped'
            ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.pk} has already shipped`)
            : undefined,
      ],
      effects: ({ object }) => [modify(object, { status: 'cancelled' })],
      writeback: true,
    }),
    setAssignee: defineAction(objects, {
      // Pure ontology-owned change: no write-back, survives re-indexing.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), assignee: z.string().nullable() },
      preconditions: [],
      effects: ({ object, params }) => [modify(object, { assignee: params.assignee })],
    }),
    reassignOrder: defineAction(objects, {
      // Rewires the graph itself: unlink + link, atomically. The link is
      // source-backed, so the plan declares write-back.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), fromCustomerId: z.string(), toCustomerId: z.string() },
      preconditions: [
        ({ object }) =>
          object.properties.status === 'shipped'
            ? reject('SHIPPED_ORDER_CANNOT_BE_REASSIGNED', `order ${object.pk} has already shipped`)
            : undefined,
      ],
      effects: ({ object, params }) => [
        unlink('customerOrders', params.fromCustomerId, object.pk),
        link('customerOrders', params.toCustomerId, object.pk),
      ],
      writeback: true,
    }),
    sloppyReassign: defineAction(objects, {
      // Forgets the unlink — the runtime's cardinality check must catch it.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), toCustomerId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [
        link('customerOrders', params.toCustomerId, object.pk),
      ],
      writeback: true,
    }),
    sneakyCancel: defineAction(objects, {
      // Touches source-backed state without declaring write-back — the
      // shadow copy the fourth property forbids.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { status: 'cancelled' })],
    }),
    vainWriteback: defineAction(objects, {
      // Declares write-back but changes nothing a source owns.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { assignee: 'nobody' })],
      writeback: true,
    }),
    mixedTouch: defineAction(objects, {
      // One edit straddling the authority line.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { status: 'cancelled', assignee: 'x' })],
      writeback: true,
    }),
    mixedPlan: defineAction(objects, {
      // Two edits on opposite sides of the authority line.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [
        modify(object, { status: 'cancelled' }),
        modify(object, { assignee: 'x' }),
      ],
      writeback: true,
    }),
    mixedCreate: defineAction(objects, {
      // Source-backed existence and explicit owned values cannot share an edit,
      // even when an owned value equals its declared default.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [create('Order', 'N1', { id: 'N1', status: 'pending', total: 1, assignee: null })],
      writeback: true,
    }),
    corruptOrder: defineAction(objects, {
      // Deliberately produces an edit that violates the Order schema —
      // used to prove the plan is refused before write-back ever runs.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { status: 'bogus' })],
      writeback: true,
    }),
    typoOrder: defineAction(objects, {
      // A typo'd property — must be refused, not silently stripped.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { vaporware: 1 })],
      writeback: true,
    }),
    conjureNoise: defineAction(objects, {
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [create('Order', 'N1', { id: 'N1', status: 'pending', total: 1, ghost: true })],
      writeback: true,
    }),
    protoOrder: defineAction(objects, {
      // Prototype-chain names must not masquerade as model properties.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { toString: 'gotcha' })],
      writeback: true,
    }),
    hollowModify: defineAction(objects, {
      // A modify that changes nothing — not an edit, refused.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, {})],
    }),
    idleWriteback: defineAction(objects, {
      // Declares write-back but produces an empty plan — nothing to route.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [],
      writeback: true,
    }),
    landmine: defineAction(objects, {
      // A crashing rule — must be audited as EXECUTION_CRASHED, not lost.
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
    explodingEffects: defineAction(objects, {
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => {
        throw new Error('effects crashed')
      },
    }),
    conjureOrder: defineAction(objects, {
      // Creates with a pk that disagrees with the data — the runtime must refuse.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [create('Order', 'CLAIMED', { id: 'ACTUAL', status: 'pending', total: 1, assignee: null })],
    }),
    mangleId: defineAction(objects, {
      // Tries to rewrite the primary key — the runtime must refuse.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { id: 'HIJACKED' })],
    }),
    sneakyCorrupt: defineAction(objects, {
      // Two flaws at once — an invalid edit AND an undeclared source write.
      // Pins the declared refusal order: validity precedes authority.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: ({ object }) => [modify(object, { status: 'bogus' })],
    }),
    sloppierReassign: defineAction(objects, {
      // A cardinality violation AND an undeclared source write — same order.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), toCustomerId: z.string() },
      preconditions: [],
      effects: ({ object, params }) => [
        link('customerOrders', params.toCustomerId, object.pk),
      ],
    }),
    protoUnlink: defineAction(objects, {
      // An unlink whose "link type" is a prototype name — unknown, refused.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string() },
      preconditions: [],
      effects: () => [unlink('toString', 'a', 'b')],
    }),
    openTask: defineAction(objects, {
      // Creates an ontology-owned object and wires it to its order in one
      // atomic plan, behind the order's gate.
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), taskId: z.string().min(1), title: z.string().min(1) },
      preconditions: [],
      effects: ({ object, params }) => [
        create('Task', params.taskId, { id: params.taskId, title: params.title }),
        link('orderTasks', object.pk, params.taskId),
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
      { id: 'O1', status: 'shipped', total: 100 },
      { id: 'O2', status: 'pending', total: 200 },
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

const noopAdapter = (): WritebackAdapter => ({ apply: () => {} })

// ─── The declared answers, enumerable at runtime ───

test('the implementation declares its four answers as one enumerable value', () => {
  const rt = setup()
  assert.deepEqual(rt.declarations, {
    authority: 'model-declared-runtime-checked',
    failureSemantics: 'write-back-first',
    reindexing: 'replace-base-reapply-owned-overlay',
    visibilityDefault: 'fail-open',
  })
})

// ─── Properties 2 & 3 · the gate: named actions, machine-readable refusals, audited attempts ───

test('a business rule refuses the write with a machine-readable error', () => {
  const rt = setup()
  const result = rt.execute('cancelOrder', { orderId: 'O1', reason: 'changed mind' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'SHIPPED_ORDER_CANNOT_BE_CANCELLED')
  assert.equal(rt.get('Order', 'O1', asTest)!.properties.status, 'shipped') // unchanged
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
  const before = rt.get('Order', 'O2', asTest)!
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'cancelled')
  assert.equal(before.properties.status, 'pending', 'an earlier read remains a snapshot')
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

test('unknown Actions are refused and audited; call never executes an Action', () => {
  const rt = setup()
  assert.throws(() => rt.call('cancelOrder', { orderId: 'O2', reason: 'x' }, asTest), /unknown function/)
  const expected = { ok: false, error: { code: 'UNKNOWN_ACTION', message: 'no action named "dropAllTables"' } }
  assert.deepEqual(rt.auditLog(), [])
  assert.deepEqual(rt.execute('dropAllTables', {}, asTest), expected)
  assert.deepEqual(rt.auditLog().map((entry) => entry.error?.code), ['UNKNOWN_ACTION'])
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending')
})

test('action attempts with invalid params are audited before the rules run', () => {
  const rt = setup()
  rt.execute('cancelOrder', { orderId: 'O2', reason: '' }, { actor: 'test' })
  const rejected = rt.auditLog({ status: 'rejected' })
  assert.deepEqual(rejected.map((e) => e.error?.code), ['INVALID_PARAMS'])
  assert.equal(rejected[0].target, 'Order/O2')
})

test('params the audit log cannot hold are refused — and still audited', () => {
  const rt = setup()
  // A BigInt survives no JSON round trip: the params are refused before the
  // model runs, and the audit write records a placeholder instead of crashing.
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 10n }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_PARAMS')
  // Unknown names are rejected before inspecting even unserializable params.
  assert.equal(rt.execute('dropAllTables', { n: 10n }, { actor: 'test' }).ok, false)
  const rejected = rt.auditLog({ status: 'rejected' })
  assert.deepEqual(rejected.map((e) => e.error?.code), ['INVALID_PARAMS', 'UNKNOWN_ACTION'])
  assert.deepEqual(rejected[1].params, { $unserializable: '[object Object]' })
  assert.deepEqual(rejected[0].params, { $unserializable: '[object Object]' })
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending')
})

// ─── Property 4 · write-back and its declared failure semantics ───

test('write-back-first ordering: adapter failure blocks the ontology edit', () => {
  const calls: string[] = []
  const failing: WritebackAdapter = {
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
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending') // …but nothing changed here
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
  // The plan that already left for the source is on the record — the
  // adapter may have partially applied it before throwing.
  const rejected = rt.auditLog({ status: 'rejected' })[0]
  assert.equal(rejected?.error?.code, 'WRITEBACK_FAILED')
  assert.deepEqual(rejected?.edits, [{ op: 'modify', object: 'Order', pk: 'O2', changes: { status: 'cancelled' } }])
})

test('an action that requires write-back refuses without an adapter', () => {
  const rt = createRuntime(ontology, new Database(':memory:')) // no adapter configured
  rt.load(SNAPSHOT)
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'NO_WRITEBACK_ADAPTER')
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending')
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'NO_WRITEBACK_ADAPTER')
})

test('the adapter receives its routing material: the target as the runtime loaded it', () => {
  let seen: Parameters<WritebackAdapter['apply']>[1]['target'] | undefined
  const probe: WritebackAdapter = {
    apply: (_edits, meta) => {
      seen = meta.target
    },
  }
  const rt = setup(probe)
  assert.equal(rt.execute('cancelOrder', { orderId: 'O2', reason: 'x' }, { actor: 'test' }).ok, true)
  assert.deepEqual(seen, {
    type: 'Order',
    pk: 'O2',
    properties: { id: 'O2', status: 'pending', total: 200, assignee: null }, // pre-edit state
  })
})

test('invalid edits are refused before the adapter ever runs', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { apply: () => calls.push('adapter') && undefined }
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
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending')
  assert.equal(rt.auditLog({ status: 'rejected' }).length, 4)
})

test('the preflight is the single gate: store-level violations are refused before the adapter runs', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // A link to a customer that does not exist — provable only against the
  // store, and still refused before anything leaves the process.
  const result = rt.execute(
    'reassignOrder',
    { orderId: 'O2', fromCustomerId: 'C1', toCustomerId: 'GHOST' },
    { actor: 'test' },
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /does not exist/)
  }
  assert.deepEqual(calls, []) // the plan never reached the system of record
  // The dry run left no trace: the unlink that "ran" before the failing
  // link is rolled back with everything else.
  assert.deepEqual(rt.traverse(rt.get('Customer', 'C1', asTest)!, 'customerOrders', asTest).objects.map((o) => o.pk), ['O1', 'O2'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('one-to-many cardinality is enforced at the write gate, before write-back', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  // Linking O2 to C2 without unlinking C1 first would give the order two customers.
  const result = rt.execute('sloppyReassign', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /one-to-many/)
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(rt.traverse(rt.get('Order', 'O2', asTest)!, 'customerOrders', { ...asTest, direction: 'reverse' }).objects.map((c) => c.pk), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 0)
})

test('a commit failure after write-back is the declared divergence — audited with its edits', () => {
  const db = new Database(':memory:')
  // An adapter that succeeds against the source but sabotages the local
  // store — the mechanical stand-in for the declared reverse failure
  // (adapter succeeded, local commit failed).
  const saboteur: WritebackAdapter = {
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

test('an empty plan calls no adapter — there is nothing to write back', () => {
  const calls: string[] = []
  const spy: WritebackAdapter = { apply: () => calls.push('adapter') && undefined }
  const rt = setup(spy)
  const result = rt.execute('idleWriteback', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 1) // the attempt is still on the record
})

test('the committed plan is the validated plan — an adapter cannot mutate it', () => {
  const meddling: WritebackAdapter = {
    apply: (edits) => {
      // A misbehaving adapter rewrites the plan it was handed.
      const first = edits[0]
      if (first.op === 'modify') first.changes.status = 'shipped'
      edits.push({ op: 'modify', object: 'Order', pk: 'O1', changes: { status: 'pending' } })
    },
  }
  const rt = setup(meddling)
  const result = rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, { actor: 'test' })
  assert.equal(result.ok, true)
  // The adapter mutated its own copy; the validated plan is what committed.
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'cancelled')
  assert.equal(rt.get('Order', 'O1', asTest)!.properties.status, 'shipped')
  assert.deepEqual(rt.auditLog({ status: 'applied' })[0]?.edits, [
    { op: 'modify', object: 'Order', pk: 'O2', changes: { status: 'cancelled' } },
  ])
})

// ─── Property 4 · the authority line: declared homes, checked ───

test('an undeclared write to source-backed state is refused as a shadow copy', () => {
  const rt = setup()
  const result = rt.execute('sneakyCancel', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'UNDECLARED_SOURCE_WRITE')
  assert.equal(rt.get('Order', 'O2', asTest)!.properties.status, 'pending')
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

test('a source-backed create cannot explicitly supply owned properties', () => {
  const rt = setup()
  const result = rt.execute('mixedCreate', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'MIXED_AUTHORITY')
  assert.equal(rt.get('Order', 'N1', asTest), undefined)
})

test('validity precedes the authority line — a broken plan is INVALID_EDITS, whatever else it is', () => {
  const rt = setup()
  // An invalid value AND an undeclared source write: the plan fails as a plan first.
  const bogus = rt.execute('sneakyCorrupt', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(bogus.ok, false)
  if (!bogus.ok) assert.equal(bogus.error.code, 'INVALID_EDITS')
  // A cardinality violation AND an undeclared source write: same order.
  const sloppy = rt.execute('sloppierReassign', { orderId: 'O2', toCustomerId: 'C2' }, { actor: 'test' })
  assert.equal(sloppy.ok, false)
  if (!sloppy.ok) {
    assert.equal(sloppy.error.code, 'INVALID_EDITS')
    assert.match(sloppy.error.message, /one-to-many/)
  }
})

// ─── Declared · re-indexing vs edits: the base refreshes, owned state survives ───

test('ontology-owned state survives a re-index; source-backed state refreshes', () => {
  const rt = setup()
  rt.execute('setAssignee', { orderId: 'O2', assignee: 'alice' }, { actor: 'test' })
  // The source moved on: O2 shipped upstream.
  const moved = structuredClone(SNAPSHOT)
  moved.objects.Order[1] = { id: 'O2', status: 'shipped', total: 200 }
  rt.load(moved)
  const o2 = rt.get('Order', 'O2', asTest)!
  assert.equal(o2.properties.status, 'shipped') // the source spoke, the base refreshed
  assert.equal(o2.properties.assignee, 'alice') // the ontology's own state survived
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
  const o2 = rt.get('Order', 'O2', asTest)!
  assert.equal(o2.properties.assignee, 'alice')
})

test('a source snapshot cannot supply ontology-owned properties', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () =>
      rt.load({
        objects: {
          Order: [{ id: 'O9', status: 'pending', total: 1, assignee: 'smuggled' }],
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
  rt.execute('openTask', { orderId: 'O2', taskId: 'T1', title: 'call the customer' }, { actor: 'test' })
  rt.load(SNAPSHOT) // full re-index of everything a source supplies
  assert.equal(rt.get('Task', 'T1', asTest)!.properties.title, 'call the customer')
  assert.deepEqual(rt.traverse(rt.get('Order', 'O2', asTest)!, 'orderTasks', asTest).objects.map((t) => t.pk), ['T1'])
})

test('a model that stops owning a property refuses to load over its edits', () => {
  const db = new Database(':memory:')
  const widget = (owned: boolean) => {
    const widgetObjects = {
      Widget: defineObject({
        primaryKey: 'id',
        properties: { id: z.string(), note: z.string() },
        ...(owned ? { owned: { note: '' } } : {}),
      }),
    }

    return defineOntology({
      name: 'w',
      objects: widgetObjects,
      links: {},
      actions: {
        setNote: defineAction(widgetObjects, {
          object: 'Widget',
          targetParam: 'id',
          params: { id: z.string(), note: z.string() },
          preconditions: [],
          effects: ({ object, params }) => [modify(object, { note: params.note })],
        }),
      },
    })
  }
  const v1 = createRuntime(widget(true), db)
  v1.load({ objects: { Widget: [{ id: 'W1' }] } })
  assert.equal(v1.execute('setNote', { id: 'W1', note: 'keep me' }, { actor: 'test' }).ok, true)
  // The model evolves: `note` is no longer ontology-owned, but the overlay
  // still carries an edit for it. A refresh must not decide that state's
  // fate — schema evolution must, explicitly.
  const v2 = createRuntime(widget(false), db)
  assert.throws(() => v2.load({ objects: { Widget: [{ id: 'W1', note: 'fresh' }] } }), /no longer declares/)
})

// ─── Property 1 · objects and links: creation, rewiring, traversal ───

test('an action can create an ontology-owned object and wire it, atomically', () => {
  const rt = setup()
  const result = rt.execute('openTask', { orderId: 'O2', taskId: 'T1', title: 'triage the backlog' }, { actor: 'test' })
  assert.equal(result.ok, true)
  assert.equal(rt.get('Task', 'T1', asTest)!.properties.title, 'triage the backlog')
  assert.deepEqual(rt.traverse(rt.get('Order', 'O2', asTest)!, 'orderTasks', asTest).objects.map((t) => t.pk), ['T1'])
  assert.equal(rt.auditLog({ status: 'applied' })[0]?.target, 'Order/O2')
  // A second creation with the same pk collides in the store.
  const dup = rt.execute('openTask', { orderId: 'O2', taskId: 'T1', title: 'again' }, { actor: 'test' })
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.equal(dup.error.code, 'INVALID_EDITS')
})

// ─── Mechanics · the storable boundary and transaction ownership ───

test('every stored row must be plain JSON — whichever door it came through', () => {
  // Through an action: an ontology-owned type whose schema emits a Date.
  const clocksObjects = {
    Job: defineObject({ primaryKey: 'id', properties: { id: z.string() } }),
    Stamp: defineObject({ primaryKey: 'id', owned: true, properties: { id: z.string(), at: z.date() } }),
  }

  const clocks = defineOntology({
    name: 'clocks',
    objects: clocksObjects,
    links: {},
    actions: {
      mark: defineAction(clocksObjects, {
        object: 'Job',
        targetParam: 'jobId',
        params: { jobId: z.string(), id: z.string() },
        preconditions: [],
        effects: ({ params }) => [create('Stamp', params.id, { id: params.id, at: new Date(0) })],
      }),
    },
  })
  const rt = createRuntime(clocks, new Database(':memory:'))
  rt.load({ objects: { Job: [{ id: 'J1' }] } })
  const result = rt.execute('mark', { jobId: 'J1', id: 'S1' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /plain JSON/)
  }
  // Through the pipeline: a source-backed schema that coerces into a Date.
  const feeds = defineOntology({
    name: 'feeds',
    objects: {
      Event: defineObject({ primaryKey: 'id', properties: { id: z.string(), at: z.coerce.date() } }),
    },
    links: {},
    actions: {},
  })
  const rt2 = createRuntime(feeds, new Database(':memory:'))
  assert.throws(() => rt2.load({ objects: { Event: [{ id: 'E1', at: '2020-01-01' }] } }), /plain JSON/)
})

test('an owned default that is not plain JSON is refused at definition', () => {
  // A Date is not plain JSON — it would come back from the store as
  // something else entirely.
  assert.throws(
    () =>
      defineObject({
        primaryKey: 'id',
        properties: { id: z.string(), at: z.date() },
        owned: { at: new Date(0) },
      }),
    /plain JSON/,
  )
})

test('a hole and a named property cannot cancel out in an array', () => {
  // new Array(2) with one element and one named prop: JSON would emit
  // [null,"x"] and drop the prop — two silent rewrites in one value.
  const compensated = new Array(2) as unknown[] & { meta?: boolean }
  compensated[1] = 'x'
  compensated.meta = true
  assert.throws(
    () =>
      defineObject({
        primaryKey: 'id',
        properties: { id: z.string(), bag: z.any() },
        owned: { bag: compensated },
      }),
    /plain JSON/,
  )
})

test('an empty modify is not an edit', () => {
  const rt = setup()
  const result = rt.execute('hollowModify', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'INVALID_EDITS')
    assert.match(result.error.message, /changes nothing/)
  }
})

test('execute() and load() refuse to run inside a caller-owned transaction', () => {
  const db = new Database(':memory:')
  const rt = createRuntime(ontology, db, { writeback: noopAdapter() })
  rt.load(SNAPSHOT)
  assert.throws(
    () => db.transaction(() => rt.execute('setAssignee', { orderId: 'O2', assignee: 'x' }, { actor: 'test' }))(),
    /open transaction/,
  )
  assert.throws(() => db.transaction(() => rt.load(SNAPSHOT))(), /open transaction/)
  // Nothing leaked out of the refused attempts.
  assert.equal(rt.get('Order', 'O2', { actor: 'test' })!.properties.assignee, null)
})

test('prune compares structurally — key order cannot hide "back at default"', () => {
  const miniObjects = {
    Widget: defineObject({
      primaryKey: 'id',
      properties: { id: z.string(), flags: z.object({ a: z.boolean(), b: z.boolean() }) },
      owned: { flags: { b: false, a: true } }, // declared in one key order…
    }),
  }

  const mini = defineOntology({
    name: 'mini',
    objects: miniObjects,
    links: {},
    actions: {
      setFlags: defineAction(miniObjects, {
        object: 'Widget',
        targetParam: 'id',
        params: { id: z.string(), a: z.boolean(), b: z.boolean() },
        preconditions: [],
        effects: ({ object, params }) => [
          modify(object, { flags: { a: params.a, b: params.b } }), // …edited in another
        ],
      }),
    },
  })
  const rt = createRuntime(mini, new Database(':memory:'))
  rt.load({ objects: { Widget: [{ id: 'W1' }] } })
  rt.execute('setFlags', { id: 'W1', a: false, b: false }, { actor: 'test' }) // a real edit
  rt.execute('setFlags', { id: 'W1', a: true, b: false }, { actor: 'test' }) // back to the default
  // The obligation is gone: a re-index that drops W1 goes through.
  rt.load({ objects: { Widget: [] } })
  assert.equal(rt.get('Widget', 'W1', { actor: 'test' }), undefined)
})

test('actions can rewire the graph itself — links are edits too', () => {
  const rt = setup()
  const result = rt.execute(
    'reassignOrder',
    { orderId: 'O2', fromCustomerId: 'C1', toCustomerId: 'C2' },
    { actor: 'test' },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(rt.traverse(rt.get('Customer', 'C1', asTest)!, 'customerOrders', asTest).objects.map((o) => o.pk), ['O1'])
  assert.deepEqual(rt.traverse(rt.get('Customer', 'C2', asTest)!, 'customerOrders', asTest).objects.map((o) => o.pk), ['O2'])
})

test('links infer direction from tagged instances and reject invalid sources or directions', () => {
  const rt = setup()
  const customer = rt.get('Customer', 'C1', asTest)!
  assert.deepEqual(customer, { type: 'Customer', pk: 'C1', properties: { id: 'C1', name: 'Yamada' } })
  const orders = rt.traverse(customer, 'customerOrders', asTest)
  assert.deepEqual(orders.objects.map((o) => o.pk), ['O1', 'O2'])
  assert.deepEqual(rt.traverse(orders.objects[0], 'customerOrders', asTest).objects, [customer])
  assert.throws(() => rt.traverse(customer, 'customerOrders', { ...asTest, direction: 'reverse' }), /invalid direction/)
  assert.throws(() => rt.traverse(customer, 'orderTasks', asTest), /does not connect/)
  // @ts-expect-error an instance must include its properties
  assert.throws(() => rt.traverse({ type: 'Customer', pk: 'C1' }, 'customerOrders', asTest), /requires an object instance/)
  // @ts-expect-error runtime callers can still supply an invalid direction
  assert.throws(() => rt.traverse(customer, 'customerOrders', { ...asTest, direction: null }), /invalid direction/)
  assert.deepEqual(rt.traverse({ ...customer, pk: 'missing' }, 'customerOrders', asTest).objects, [])
})

test('same-type links require direction even at an endpoint with only incoming or outgoing edges', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  const rt = createRuntime(defineOntology({
    name: 'employees',
    objects: { Employee: defineObject({ primaryKey: 'id', properties: { id: z.string() } }) },
    links: { manages: defineLink({ from: 'Employee', to: 'Employee', kind: 'one-to-many' }) },
    actions: {},
  }), db)
  rt.load({ objects: { Employee: [{ id: 'E1' }, { id: 'E2' }, { id: 'E3' }] },
    links: { manages: [['E1', 'E2'], ['E2', 'E3']] } })
  const middle = rt.get('Employee', 'E2', asTest)!
  assert.deepEqual(rt.traverse(middle, 'manages', { ...asTest, direction: 'reverse' }).objects.map((o) => o.pk), ['E1'])
  assert.deepEqual(rt.traverse(middle, 'manages', { ...asTest, direction: 'forward' }).objects.map((o) => o.pk), ['E3'])
  for (const employee of rt.search('Employee', asTest).objects) {
    assert.throws(() => rt.traverse(employee, 'manages', asTest), /requires a direction/)
  }
})

test('identity does not collide with business properties or primary keys in another type', (t) => {
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
  const db = new Database(':memory:')
  t.after(() => db.close())
  const rt = createRuntime(model, db)
  const actor = { actor: 'test' }
  const properties = { code: 'same', type: 'business type', pk: 'business pk', properties: 'business value' }
  rt.load({ objects: { Left: [properties], Right: [{ key: 'same' }] }, links: { pair: [['same', 'same']] } })
  const left = rt.get('Left', 'same', actor)!
  const right = rt.get('Right', 'same', actor)!
  assert.deepEqual(left, { type: 'Left', pk: 'same', properties })
  assert.deepEqual(rt.traverse(left, 'pair', actor).objects, [right])
  assert.deepEqual(rt.traverse(right, 'pair', actor).objects, [left])
  assert.deepEqual(rt.search('Left', { ...actor, filter: (object) => object.properties.type === 'business type' }).objects, [left])
  assert.deepEqual(modify(left, { type: 'new business type' }), {
    op: 'modify', object: 'Left', pk: 'same', changes: { type: 'new business type' },
  })
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

// ─── Mechanics · crashes are audited attempts too ───

test('prototype names are not operations, objects, or links', () => {
  const rt = setup()
  assert.equal(rt.execute('toString', {}, { actor: 'test' }).ok, false)
  assert.throws(() => rt.get('toString', 'x', asTest), /unknown object type/)
  assert.throws(() => rt.traverse(rt.get('Customer', 'C1', asTest)!, 'toString', asTest).objects, /unknown link type/)
  // …and not link types inside an edit plan either — refused before the
  // adapter could ever see the plan.
  const viaEffects = rt.execute('protoUnlink', { orderId: 'O2' }, { actor: 'test' })
  assert.equal(viaEffects.ok, false)
  if (!viaEffects.ok) {
    assert.equal(viaEffects.error.code, 'INVALID_EDITS')
    assert.match(viaEffects.error.message, /unknown link type/)
  }
})

test('a storage fault is an audited attempt too — EXECUTION_CRASHED', () => {
  const db = new Database(':memory:')
  const rt = createRuntime(ontology, db, { writeback: noopAdapter() })
  rt.load(SNAPSHOT)
  db.prepare("UPDATE objects SET data = 'not json' WHERE pk = 'O2'").run()
  assert.throws(() => rt.execute('cancelOrder', { orderId: 'O2', reason: 'x' }, { actor: 'test' }))
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'EXECUTION_CRASHED')
})

test('crashing rules are audited too — EXECUTION_CRASHED, then the error surfaces', () => {
  const rt = setup()
  assert.throws(() => rt.execute('landmine', { orderId: 'O2' }, { actor: 'test' }), /precondition crashed/)
  assert.throws(() => rt.execute('explodingEffects', { orderId: 'O2' }, { actor: 'test' }), /effects crashed/)
  const rejected = rt.auditLog({ status: 'rejected' })
  assert.deepEqual(rejected.map((e) => e.error?.code), ['EXECUTION_CRASHED', 'EXECUTION_CRASHED'])
})

// ─── Property 1 · indexing: the snapshot must satisfy the model ───

test('re-loading resets source-backed links instead of merging', () => {
  const rt = setup()
  rt.execute('reassignOrder', { orderId: 'O2', fromCustomerId: 'C1', toCustomerId: 'C2' }, { actor: 'test' })
  rt.load(SNAPSHOT)
  // The local echo of the reassignment is gone; the snapshot's view is back.
  assert.deepEqual(
    rt.traverse(rt.get('Order', 'O2', asTest)!, 'customerOrders', { ...asTest, direction: 'reverse' }).objects.map((c) => c.pk),
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
          Order: [{ id: 'O1', status: 'pending', total: 1 }],
        },
        links: { customerOrders: [['C1', 'O1'], ['C2', 'O1']] },
      }),
    /one-to-many/,
  )
})

test('a partial re-load that breaks surviving edits is refused whole', () => {
  const rt = setup()
  rt.execute('reassignOrder', { orderId: 'O2', fromCustomerId: 'C1', toCustomerId: 'C2' }, { actor: 'test' })
  // Re-load Customers without C2 — the surviving edited link would dangle.
  assert.throws(() => rt.load({ objects: { Customer: [{ id: 'C1', name: 'Yamada' }] } }), /does not exist/)
  // Rolled back whole: C2 and the edited link both survive.
  assert.notEqual(rt.get('Customer', 'C2', asTest), undefined)
  assert.deepEqual(
    rt.traverse(rt.get('Order', 'O2', asTest)!, 'customerOrders', { ...asTest, direction: 'reverse' }).objects.map((c) => c.pk),
    ['C2'],
  )
})

test('indexing validates rows against the model', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(() => rt.load({ objects: { Order: [{ id: 'O9', status: 'teleported', total: 1 }] } }))
})

test('indexing refuses unknown keys instead of silently stripping them', () => {
  const rt = createRuntime(ontology, new Database(':memory:'))
  assert.throws(
    () => rt.load({ objects: { Customer: [{ id: 'C1', name: 'A', legacy_flag: 1 }] } }),
    /unknown property "legacy_flag"/,
  )
})

// ─── Derived state: computed at query time, never written ───

test('aggregation happens at query time', () => {
  const rt = setup()
  const orders = rt.search('Order', asTest)
  const byStatus = rt.aggregate(orders, { groupBy: 'status', sum: 'total' })
  assert.deepEqual(byStatus.values.map(({ key, metrics }) => ({ key, ...metrics })), [
    { key: 'shipped', count: 1, sum: 100 }, { key: 'pending', count: 1, sum: 200 },
  ])
  assert.deepEqual(byStatus.set, orders)
})

test('aggregation is immune to prototype-named groups', () => {
  const rt = setup()
  const orders = rt.search('Order', asTest)
  orders.objects[0].properties.id = '__proto__'
  orders.objects[1].properties.id = 'toString'
  const groups = rt.aggregate(orders, { groupBy: 'id' })
  assert.deepEqual(groups.values.map(({ key, metrics }) => [key, metrics.count]), [['__proto__', 1], ['toString', 1]])
  assert.equal(({} as Record<string, unknown>).count, undefined)
})

// ─── Declared · visibility: fail-open, attached to the model ───

const visOntologyObjects = {
  Doc: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), owner: z.string(), title: z.string() },
    owned: { title: 'untitled' },
    visibility: ({ object, actor }) => actor === object.properties.owner || actor === 'user:auditor',
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
}

const visOntology = defineOntology({
  name: 'vis',
  objects: visOntologyObjects,
  links: {
    docComments: defineLink({ from: 'Doc', to: 'Comment', kind: 'one-to-many' }),
  },
  actions: {
    renameDoc: defineAction(visOntologyObjects, {
      object: 'Doc',
      targetParam: 'docId',
      params: { docId: z.string(), title: z.string().min(1) },
      preconditions: [],
      effects: ({ object, params }) => [modify(object, { title: params.title })],
    }),
    springTrap: defineAction(visOntologyObjects, {
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
  assert.deepEqual(rt.search('Doc', { actor: 'user:alice' }).objects.map((d) => d.pk), ['D1'])
  assert.deepEqual(rt.search('Doc', { actor: 'user:auditor' }).objects.map((d) => d.pk), ['D1', 'D2'])
})

test('a crashing visibility predicate is audited as EXECUTION_CRASHED', () => {
  const rt = visSetup()
  assert.throws(() => rt.execute('springTrap', { trapId: 'T1' }, { actor: 'user:alice' }), /visibility crashed/)
  assert.equal(rt.auditLog({ status: 'rejected' })[0]?.error?.code, 'EXECUTION_CRASHED')
})

test('traversal rechecks stored visibility at both ends, ignoring caller-supplied properties', () => {
  const rt = visSetup()
  const doc = rt.get('Doc', 'D2', { actor: 'user:auditor' })!
  doc.properties.owner = 'user:alice' // the stored owner is still bob
  assert.deepEqual(rt.traverse(doc, 'docComments', { actor: 'user:alice' }).objects, [])
  const comments = rt.traverse(doc, 'docComments', { actor: 'user:bob' }).objects
  assert.deepEqual(comments.map((o) => o.pk), ['CM1'])
  assert.deepEqual(rt.traverse(comments[0], 'docComments', { actor: 'user:alice' }).objects, [], 'hidden destination')
  assert.deepEqual(rt.traverse(comments[0], 'docComments', { actor: 'user:bob' }).objects,
    [rt.get('Doc', 'D2', { actor: 'user:bob' })])
})

test('a hidden object is indistinguishable from a nonexistent one — even as an action target', () => {
  const rt = visSetup()
  assert.equal(rt.get('Doc', 'D2', { actor: 'user:alice' }), undefined)
  assert.deepEqual(rt.auditLog(), [])
  const result = rt.execute('renameDoc', { docId: 'D2', title: 'x' }, { actor: 'user:alice' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TARGET_NOT_FOUND') // no existence leak
  // The owner performs the same action without friction.
  assert.equal(rt.execute('renameDoc', { docId: 'D2', title: 'x' }, { actor: 'user:bob' }).ok, true)
})
