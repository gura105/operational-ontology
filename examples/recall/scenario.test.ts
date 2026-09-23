import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../../src/mcp.js'
import type { AuditEntry, ObjectInstance, ObjectSet, Runtime } from '../../src/core.js'
import type { Recall } from './ontology.js'
import {
  KEYBOARD_CANCELLED, KEYBOARD_CUSTOMERS, KEYBOARD_ORDERS, KEYBOARD_PENDING, KEYBOARD_SHIPPED, TOTAL_ORDERS,
} from './fixtures.js'
import { integrate } from './integrate.js'
import { createRecall } from './runtime.js'

const actor = 'user:cs-recall'
const ids = (objects: readonly { pk: string }[]) => objects.map((object) => object.pk)
function setup(t: TestContext) {
  const app = createRecall()
  t.after(() => app.close())
  return app
}
function discover(rt: Runtime<Recall>) {
  const product = rt.get('Product', 'ITM-101', { actor })!
  const orders = rt.traverse(product, 'orderProducts', { actor })
  const shipped = rt.filter(orders, (order) => order.properties.status === 'shipped')
  const customers = rt.pivot(shipped, 'customerOrders', { actor })
  const tickets = rt.traverse(product, 'productRecallTickets', { actor })
  const covered = rt.pivot(tickets, 'customerRecallTickets', { actor })
  return { product, orders, shipped, customers, tickets, covered, selected: rt.subtract(customers, covered) }
}
const ticketParams = (customerId: string, ticketId = `RT-ITM-101-${customerId}`) => ({
  ticketId, customerId, productId: 'ITM-101', note: 'Arrange keyboard exchange',
  recordedOn: '2026-09-10', author: 'cs-recall',
})

test('recall finds ten affected customers and subtracts three existing support tickets', (t) => {
  const { rt, sources } = setup(t)
  const { orders, shipped, customers, tickets, covered, selected } = discover(rt)
  assert.equal(rt.search('Order', { actor }).objects.length, TOTAL_ORDERS)
  assert.equal(orders.objects.length, KEYBOARD_ORDERS)
  assert.equal(shipped.objects.length, KEYBOARD_SHIPPED)
  assert.equal(rt.filter(orders, (order) => order.properties.status === 'pending').objects.length, KEYBOARD_PENDING)
  assert.equal(rt.filter(orders, (order) => order.properties.status === 'cancelled').objects.length, KEYBOARD_CANCELLED)
  assert.equal(customers.objects.length, KEYBOARD_CUSTOMERS)
  assert.equal(tickets.objects.length, 3)
  assert.deepEqual(ids(covered.objects), ['N-C01', 'N-C02', 'N-C03'])
  assert.deepEqual(ids(selected.objects), ['N-C04', 'N-C05', 'S-9001', 'S-9002', 'S-9003', 'S-9004', 'S-9005'])
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 3)
  assert.deepEqual(rt.auditLog(), [], 'loading existing support tickets is not an Action attempt')
})

test('seven customer-only requests create support tickets, reject a duplicate and reload complete coverage', (t) => {
  const { rt, sources } = setup(t)
  const { selected, covered } = discover(rt)
  for (const customer of selected.objects) {
    const params = ticketParams(customer.pk)
    assert.equal(rt.execute('createRecallTicket', params, { actor }).ok, true)
    assert.deepEqual(sources.support.prepare('SELECT * FROM tickets WHERE id = ?').get(params.ticketId), {
      id: params.ticketId, customer_id: customer.pk, product_id: params.productId,
      note: params.note, recorded_on: params.recordedOn, author: params.author,
    })
    const ticket = rt.get('RecallTicket', params.ticketId, { actor })!
    assert.deepEqual(ids(rt.traverse(ticket, 'customerRecallTickets', { actor }).objects), [customer.pk])
    assert.deepEqual(ids(rt.traverse(ticket, 'productRecallTickets', { actor }).objects), [params.productId])
  }
  const duplicate = rt.execute('createRecallTicket', ticketParams(covered.objects[0].pk, 'RT-DUPLICATE'), { actor })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'RECALL_TICKET_ALREADY_EXISTS')
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 10)
  assert.equal(rt.get('RecallTicket', 'RT-DUPLICATE', { actor }), undefined)
  assert.equal(rt.auditLog({ status: 'applied' }).length, 7)
  assert.equal(rt.auditLog({ status: 'rejected' }).length, 1)

  rt.load(integrate(sources))
  const refreshed = discover(rt)
  assert.equal(refreshed.tickets.objects.length, 10)
  assert.equal(refreshed.covered.objects.length, 10)
  assert.deepEqual(refreshed.selected.objects, [])
  assert.equal(rt.auditLog().length, 8)
})

test('the Action refuses unknown products and customers without a shipped order of the product', (t) => {
  const { rt, sources } = setup(t)
  for (const [customerId, productId, code] of [
    ['N-C04', 'ITM-999', 'UNKNOWN_PRODUCT'],
    ['N-C06', 'ITM-101', 'NO_SHIPPED_ORDER'], // pending keyboard only
    ['N-C09', 'ITM-101', 'NO_SHIPPED_ORDER'], // cancelled keyboard only
    ['N-C10', 'ITM-101', 'NO_SHIPPED_ORDER'], // no keyboard order
  ]) {
    const params = { ...ticketParams(customerId), productId }
    const result = rt.execute('createRecallTicket', params, { actor })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
    assert.equal(rt.get('RecallTicket', params.ticketId, { actor }), undefined)
  }
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 3)
  assert.equal(rt.search('RecallTicket', { actor }).objects.length, 3)
})

test('a prior selection does not bypass the Action eligibility check after an ERP refresh', (t) => {
  const { rt, sources } = setup(t)
  assert.ok(ids(discover(rt).selected.objects).includes('N-C04'))
  sources.north.prepare(`
    UPDATE tbl_order SET stat = 0 WHERE cust_cd = 'C04'
      AND order_no IN (SELECT order_no FROM tbl_order_line WHERE item_cd = 'ITM-101')
  `).run()
  rt.load(integrate(sources))
  // This customer still has a shipped non-keyboard order and pending keyboards.
  // Those two facts must not be mistaken for a shipped keyboard order.
  const customer = rt.get('Customer', 'N-C04', { actor })!
  assert.ok(rt.traverse(customer, 'customerOrders', { actor }).objects.some((order) => order.properties.status === 'shipped'))
  const result = rt.execute('createRecallTicket', ticketParams(customer.pk), { actor })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'NO_SHIPPED_ORDER')
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 3)
})

test('a ticket for another product does not exclude the customer; source updates replace indexed ticket state', (t) => {
  const { rt, sources } = setup(t)
  sources.support.prepare('INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?)')
    .run('RT-MONITOR', 'N-C04', 'ITM-100', 'Monitor exchange', '2026-09-09', 'cs-phone')
  rt.load(integrate(sources))
  const { selected } = discover(rt)
  assert.equal(selected.objects.length, 7)
  assert.ok(ids(selected.objects).includes('N-C04'))
  const params = ticketParams('N-C04')
  assert.equal(rt.execute('createRecallTicket', params, { actor }).ok, true)

  sources.support.prepare('UPDATE tickets SET note = ? WHERE id = ?').run('Support corrected this note', params.ticketId)
  rt.load(integrate(sources))
  const ticket = rt.get('RecallTicket', params.ticketId, { actor })!
  assert.equal(ticket.properties.note, 'Support corrected this note')
  assert.deepEqual(ids(rt.traverse(ticket, 'customerRecallTickets', { actor }).objects), ['N-C04'])
  assert.deepEqual(ids(rt.traverse(ticket, 'productRecallTickets', { actor }).objects), ['ITM-101'])
  assert.equal(discover(rt).selected.objects.length, 6)
})

test('the support system refuses a duplicate created after indexing without leaving a local ticket or links', (t) => {
  const { rt, sources } = setup(t)
  sources.support.prepare('INSERT INTO tickets VALUES (?, ?, ?, ?, ?, ?)')
    .run('RT-UPSTREAM', 'N-C04', 'ITM-101', 'Created by support', '2026-09-10', 'cs-phone')
  const params = ticketParams('N-C04')
  const result = rt.execute('createRecallTicket', params, { actor })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'WRITEBACK_FAILED')
  assert.equal(rt.get('RecallTicket', params.ticketId, { actor }), undefined)
  const customer = rt.get('Customer', params.customerId, { actor })!
  assert.deepEqual(rt.traverse(customer, 'customerRecallTickets', { actor }).objects, [])
  assert.equal(sources.support.prepare('SELECT * FROM tickets WHERE id = ?').get(params.ticketId), undefined)
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 4)
  assert.equal(rt.auditLog()[0].error?.code, 'WRITEBACK_FAILED')
  assert.equal(rt.auditLog()[0].edits?.length, 3)
  rt.load(integrate(sources))
  assert.deepEqual(ids(rt.traverse(customer, 'customerRecallTickets', { actor }).objects), ['RT-UPSTREAM'])
})

test('MCP clients pivot, subtract and create a support ticket without supplying order IDs', async (t) => {
  const { rt, sources } = setup(t)
  const server = buildMcpServer(rt, { agent: 'cs-agent' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'recall-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close() })
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true)
    assert.ok(Array.isArray(result.content))
    const block = result.content[0]
    assert.equal(block.type, 'text')
    return JSON.parse(block.text as string) as T
  }

  const product = await call<ObjectInstance>('get_product', { id: 'ITM-101' })
  const orders = await call<ObjectSet>('traverse_order_products', { source: product })
  const shipped = orders.objects.filter((order) => order.properties.status === 'shipped')
  const customers = await call<ObjectSet>('pivot_customer_orders', { source: { type: 'Order', pks: ids(shipped) } })
  const tickets = await call<ObjectSet>('traverse_product_recall_tickets', { source: product })
  const covered = await call<ObjectSet>('pivot_customer_recall_tickets', {
    source: { type: 'RecallTicket', pks: ids(tickets.objects) },
  })
  const selected = await call<ObjectSet>('subtract_customer', { left: ids(customers.objects), right: ids(covered.objects) })
  assert.equal(selected.objects.length, 7)
  await call('create_recall_ticket', ticketParams(selected.objects[0].pk, 'RT-MCP'))
  assert.equal(sources.support.prepare('SELECT * FROM tickets').all().length, 4)

  const refused = await client.callTool({
    name: 'create_recall_ticket', arguments: ticketParams(covered.objects[0].pk, 'RT-MCP-REFUSED'),
  })
  assert.equal(refused.isError, true)
  assert.ok(Array.isArray(refused.content))
  const refusalBlock = refused.content[0]
  assert.equal(refusalBlock.type, 'text')
  assert.equal(JSON.parse(refusalBlock.text as string).error.code, 'RECALL_TICKET_ALREADY_EXISTS')
  const audit = await call<AuditEntry[]>('read_audit_log', {})
  assert.deepEqual(audit.map((entry) => [entry.status, entry.actor]), [
    ['applied', 'agent:cs-agent'], ['rejected', 'agent:cs-agent'],
  ])
})
