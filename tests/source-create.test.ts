import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  create, createRuntime, defineAction, defineLink, defineObject, defineOntology,
  link, modify, type Edit, type WritebackAdapter,
} from '../src/core.js'

const asTest = { actor: 'test' }
const objects = {
  Customer: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), name: z.string() },
  }),
  Ticket: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), title: z.string(), assignee: z.string().nullable() },
    owned: { assignee: null },
  }),
}

const openTicket = defineAction(objects, {
  object: 'Customer',
  targetParam: 'customerId',
  params: { customerId: z.string(), ticketId: z.string(), title: z.string() },
  preconditions: [],
  effects: ({ object, params }) => [
    create('Ticket', params.ticketId, { id: params.ticketId, title: params.title }),
    link('customerTickets', object.pk, params.ticketId),
  ],
  writeback: true,
})

// A real system of record, separate from the ontology database. Its adapter
// handles the complete plan in one source transaction, including new links.
function setup(t: TestContext, action = openTicket, withAdapter = true) {
  const source = new Database(':memory:')
  const store = new Database(':memory:')
  t.after(() => {
    source.close()
    store.close()
  })
  source.exec(`
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id)
    );
    INSERT INTO customers VALUES ('C1', 'Alice');
  `)
  const calls: Edit[][] = []
  const adapter: WritebackAdapter = {
    apply: (edits) => {
      calls.push(structuredClone(edits))
      source.transaction(() => {
        for (const edit of edits) {
          if (edit.op === 'create' && edit.object === 'Ticket') {
            source.prepare('INSERT INTO tickets (id, title) VALUES (?, ?)').run(edit.pk, edit.data.title)
          } else if (edit.op === 'create' && edit.object === 'Customer') {
            source.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(edit.pk, edit.data.name)
          } else if (edit.op === 'link' && edit.link === 'customerTickets') {
            const result = source.prepare('UPDATE tickets SET customer_id = ? WHERE id = ?').run(edit.from, edit.to)
            if (result.changes !== 1) throw new Error('ticket missing at source')
          } else {
            throw new Error('unsupported source edit')
          }
        }
      })()
    },
  }
  const model = defineOntology({
    name: 'source-create',
    objects,
    links: { customerTickets: defineLink({ from: 'Customer', to: 'Ticket', kind: 'one-to-many' }) },
    actions: {
      openTicket: action,
      assignTicket: defineAction(objects, {
        object: 'Ticket',
        targetParam: 'ticketId',
        params: { ticketId: z.string(), assignee: z.string() },
        preconditions: [],
        effects: ({ object, params }) => [modify(object, { assignee: params.assignee })],
      }),
    },
  })
  const rt = createRuntime(model, store, withAdapter ? { writeback: adapter } : {})
  const snapshot = () => ({
    objects: {
      Customer: source.prepare('SELECT id, name FROM customers').all() as Array<{ id: string; name: string }>,
      Ticket: source.prepare('SELECT id, title FROM tickets').all() as Array<{ id: string; title: string }>,
    },
    links: {
      customerTickets: source.prepare('SELECT customer_id, id FROM tickets WHERE customer_id IS NOT NULL')
        .raw().all() as Array<[string, string]>,
    },
  })
  rt.load(snapshot())
  return { rt, source, store, calls, snapshot }
}

const params = { customerId: 'C1', ticketId: 'T1', title: 'Contact customer' }
const plan = [
  create('Ticket', 'T1', { id: 'T1', title: params.title }),
  link('customerTickets', 'C1', 'T1'),
]

test('source creation writes the record and link, then re-indexes with owned state preserved', (t) => {
  const { rt, source, calls, snapshot } = setup(t)
  assert.deepEqual(rt.execute('openTicket', params, asTest), { ok: true, edits: plan })
  assert.deepEqual(source.prepare('SELECT * FROM tickets').get(), {
    id: 'T1', title: params.title, customer_id: 'C1',
  })
  assert.deepEqual(rt.get('Ticket', 'T1', asTest)?.properties, {
    id: 'T1', title: params.title, assignee: null,
  })
  assert.deepEqual(calls, [plan], 'owned defaults never enter the adapter payload')
  assert.deepEqual(rt.auditLog()[0].edits, plan)
  assert.equal(rt.auditLog()[0].status, 'applied')

  rt.load(snapshot())
  assert.equal(rt.get('Ticket', 'T1', asTest)?.properties.assignee, null)
  assert.equal(rt.execute('assignTicket', { ticketId: 'T1', assignee: 'Bob' }, asTest).ok, true)
  source.prepare('UPDATE tickets SET title = ? WHERE id = ?').run('Contacted', 'T1')
  rt.load(snapshot())
  assert.deepEqual(rt.get('Ticket', 'T1', asTest)?.properties, {
    id: 'T1', title: 'Contacted', assignee: 'Bob',
  })
  assert.deepEqual(rt.traverse(rt.get('Customer', 'C1', asTest)!, 'customerTickets', asTest).objects.map((o) => o.pk), ['T1'])
  assert.equal(calls.length, 1, 'assigning an owned property needs no write-back')
})

test('a type without owned properties can also be created at the source', (t) => {
  const { rt, source } = setup(t, {
    ...openTicket,
    effects: () => [create('Customer', 'C2', { id: 'C2', name: 'Bob' })],
  })
  assert.equal(rt.execute('openTicket', params, asTest).ok, true)
  assert.deepEqual(source.prepare('SELECT * FROM customers WHERE id = ?').get('C2'), { id: 'C2', name: 'Bob' })
  assert.deepEqual(rt.get('Customer', 'C2', asTest)?.properties, { id: 'C2', name: 'Bob' })
})

test('source creates require both a write-back declaration and an adapter', (t) => {
  for (const [writeback, withAdapter, code] of [
    [false, true, 'UNDECLARED_SOURCE_WRITE'],
    [true, false, 'NO_WRITEBACK_ADAPTER'],
  ] as const) {
    const { rt, source, calls } = setup(t, { ...openTicket, writeback }, withAdapter)
    const result = rt.execute('openTicket', params, asTest)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
    assert.equal(rt.get('Ticket', 'T1', asTest), undefined)
    assert.equal(source.prepare('SELECT * FROM tickets').get(), undefined)
    assert.equal(calls.length, 0)
  }
})

test('an invalid creation plan never reaches the source', (t) => {
  for (const edits of [
    [create('Ticket', 'T1', { id: 'T1' })], // required source property missing
    [create('Ticket', 'T1', { id: 'other', title: 'x' })],
    [create('Ticket', 'T1', { id: 'T1', title: 'x', typo: true })],
    [plan[0], link('customerTickets', 'missing', 'T1')],
    [plan[0], plan[0]], // duplicate within the same plan
  ]) {
    const { rt, source, calls } = setup(t, { ...openTicket, effects: () => edits })
    const result = rt.execute('openTicket', params, asTest)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_EDITS')
    assert.equal(calls.length, 0)
    assert.equal(source.prepare('SELECT * FROM tickets').get(), undefined)
    assert.equal(rt.get('Ticket', 'T1', asTest), undefined)
  }
})

test('repeating a committed creation is refused before another source write', (t) => {
  const { rt, calls } = setup(t)
  assert.equal(rt.execute('openTicket', params, asTest).ok, true)
  const result = rt.execute('openTicket', params, asTest)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_EDITS')
  assert.equal(calls.length, 1)
  assert.deepEqual(rt.auditLog().map((entry) => entry.status), ['applied', 'rejected'])
})

test('a source conflict rolls back the source plan and leaves no local record or link', (t) => {
  const { rt, source } = setup(t, {
    ...openTicket,
    effects: () => [plan[0], plan[1], create('Ticket', 'T2', { id: 'T2', title: 'New' })],
  })
  // Arrives upstream after indexing: preflight cannot know about the conflict.
  source.prepare('INSERT INTO tickets (id, title) VALUES (?, ?)').run('T2', 'Already exists')
  const result = rt.execute('openTicket', params, asTest)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'WRITEBACK_FAILED')
  assert.deepEqual(source.prepare('SELECT id, title FROM tickets').all(), [{ id: 'T2', title: 'Already exists' }])
  assert.equal(rt.get('Ticket', 'T1', asTest), undefined)
  assert.equal(rt.traverse(rt.get('Customer', 'C1', asTest)!, 'customerTickets', asTest).objects.length, 0)
  assert.equal(rt.auditLog()[0].status, 'rejected')
  assert.equal(rt.auditLog()[0].edits?.length, 3)
})

test('a local failure after source creation records the plan for reconciliation', (t) => {
  const { rt, source, store, snapshot } = setup(t)
  store.exec(`
    CREATE TRIGGER refuse_applied_audit BEFORE INSERT ON audit_log
    WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'local failure'); END;
  `)
  assert.throws(() => rt.execute('openTicket', params, asTest), /local failure/)
  assert.equal(rt.get('Ticket', 'T1', asTest), undefined)
  assert.equal(rt.traverse(rt.get('Customer', 'C1', asTest)!, 'customerTickets', asTest).objects.length, 0)
  assert.deepEqual(source.prepare('SELECT * FROM tickets').get(), {
    id: 'T1', title: params.title, customer_id: 'C1',
  })
  assert.equal(rt.auditLog()[0].error?.code, 'COMMIT_FAILED')
  assert.deepEqual(rt.auditLog()[0].edits, plan)
  rt.load(snapshot())
  assert.equal(rt.get('Ticket', 'T1', asTest)?.properties.assignee, null)
})
