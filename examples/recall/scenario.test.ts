import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../../src/mcp.js'
import type { AuditEntry, ObjectInstance, ObjectSet } from '../../src/core.js'
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

test('recall starts with yesterday\'s calls and finds the exact shipped keyboard population', (t) => {
  const { rt } = setup(t)
  assert.equal(rt.search('Order', { actor }).objects.length, TOTAL_ORDERS)
  assert.equal(rt.search('RecallTask', { actor }).objects.length, 3)
  assert.deepEqual(rt.auditLog().map((entry) => [entry.status, entry.actor]), [
    ['applied', 'user:cs-phone'],
    ['applied', 'user:cs-phone'],
    ['applied', 'user:cs-phone'],
  ])

  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  assert.equal(keyboardOrders.objects.length, KEYBOARD_ORDERS)
  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  const pending = rt.filter(keyboardOrders, (order) => order.properties.status === 'pending')
  const cancelled = rt.filter(keyboardOrders, (order) => order.properties.status === 'cancelled')
  assert.equal(shipped.objects.length, KEYBOARD_SHIPPED)
  assert.equal(pending.objects.length, KEYBOARD_PENDING)
  assert.equal(cancelled.objects.length, KEYBOARD_CANCELLED)
  assert.equal(rt.pivot(shipped, 'customerOrders', { actor }).objects.length, KEYBOARD_CUSTOMERS)
})

test('recall records one task per affected customer and preserves each task\'s order evidence', (t) => {
  const { rt, seededCustomerIds } = setup(t)
  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  const customers = rt.pivot(shipped, 'customerOrders', { actor })
  const applied: string[] = []
  const rejected: string[] = []
  for (const customer of customers.objects) {
    const evidence = rt.intersect(
      rt.filter(rt.traverse(customer, 'customerOrders', { actor }), (order) => order.properties.status === 'shipped'),
      keyboardOrders,
    )
    const result = rt.execute('createRecallTask', {
      taskId: `RT-${customer.pk}`, customerId: customer.pk, productId: product.pk,
      orderIds: ids(evidence.objects), note: 'Arrange keyboard exchange',
      recordedOn: '2026-09-10', author: 'cs-recall',
    }, { actor })
    if (result.ok) applied.push(customer.pk)
    else {
      assert.equal(result.error.code, 'RECALL_TASK_ALREADY_EXISTS')
      rejected.push(customer.pk)
    }
  }
  assert.equal(applied.length, 7)
  assert.equal(rejected.length, 3)
  assert.deepEqual(rejected, seededCustomerIds)

  for (const customer of customers.objects) {
    assert.ok(rt.traverse(customer, 'customerRecallTasks', { actor }).objects.length >= 1)
  }
  for (const customerId of applied) {
    const customer = rt.get('Customer', customerId, { actor })!
    const expected = rt.intersect(
      rt.filter(rt.traverse(customer, 'customerOrders', { actor }), (order) => order.properties.status === 'shipped'),
      keyboardOrders,
    )
    const task = rt.get('RecallTask', `RT-${customerId}`, { actor })!
    assert.deepEqual(ids(rt.traverse(task, 'recallTaskOrders', { actor }).objects), ids(expected.objects))
  }
  assert.equal(rt.traverse(product, 'productRecallTasks', { actor }).objects.length, KEYBOARD_CUSTOMERS)
  assert.equal(rt.auditLog().length, 13)
  assert.equal(rt.auditLog({ status: 'applied' }).length, 10)
  assert.equal(rt.auditLog({ status: 'rejected' }).length, 3)
})

test('recall refuses unknown products, duplicate tasks and invalid order evidence', (t) => {
  const { rt, seededCustomerIds } = setup(t)
  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  const keyboardIds = new Set(ids(keyboardOrders.objects))
  const shippedKeyboard = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  const customers = rt.pivot(shippedKeyboard, 'customerOrders', { actor })

  let selected: {
    customer: ObjectInstance
    valid: ObjectSet
    pending: ObjectSet
    shippedNonKeyboard: ObjectSet
  } | undefined
  for (const customer of customers.objects) {
    if (seededCustomerIds.includes(customer.pk)) continue
    const orders = rt.traverse(customer, 'customerOrders', { actor })
    const valid = rt.intersect(
      rt.filter(orders, (order) => order.properties.status === 'shipped'),
      keyboardOrders,
    )
    const pending = rt.intersect(
      rt.filter(orders, (order) => order.properties.status === 'pending'),
      keyboardOrders,
    )
    const shippedNonKeyboard = rt.filter(
      orders,
      (order) => order.properties.status === 'shipped' && !keyboardIds.has(order.pk),
    )
    if (valid.objects.length && pending.objects.length && shippedNonKeyboard.objects.length) {
      selected = { customer, valid, pending, shippedNonKeyboard }
      break
    }
  }
  assert.ok(selected, 'fixture supplies one fresh customer with every invalid-evidence shape')
  const otherCustomerOrder = shippedKeyboard.objects.find((order) => !selected.valid.objects.some((own) => own.pk === order.pk))!
  const base = {
    customerId: selected.customer.pk, productId: product.pk,
    note: 'Arrange keyboard exchange', recordedOn: '2026-09-10', author: 'cs-recall',
  }
  const invalid = [
    ['REJECT-PENDING', [selected.pending.objects[0].pk]],
    ['REJECT-OTHER-CUSTOMER', [otherCustomerOrder.pk]],
    ['REJECT-NON-KEYBOARD', [selected.shippedNonKeyboard.objects[0].pk]],
    ['REJECT-DUPLICATED-ORDER', [selected.valid.objects[0].pk, selected.valid.objects[0].pk]],
  ] as const
  for (const [taskId, orderIds] of invalid) {
    const result = rt.execute('createRecallTask', { ...base, taskId, orderIds }, { actor })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_EVIDENCE')
    assert.equal(rt.get('RecallTask', taskId, { actor }), undefined)
  }

  const unknown = rt.execute('createRecallTask', {
    ...base, taskId: 'REJECT-UNKNOWN', productId: 'ITM-999', orderIds: ids(selected.valid.objects),
  }, { actor })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.equal(unknown.error.code, 'UNKNOWN_PRODUCT')
  assert.equal(rt.get('RecallTask', 'REJECT-UNKNOWN', { actor }), undefined)

  assert.equal(rt.execute('createRecallTask', {
    ...base, taskId: 'APPLIED', orderIds: ids(selected.valid.objects),
  }, { actor }).ok, true)
  const duplicate = rt.execute('createRecallTask', {
    ...base, taskId: 'REJECT-DUPLICATE-TASK', orderIds: ids(selected.valid.objects),
  }, { actor })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'RECALL_TASK_ALREADY_EXISTS')
  assert.equal(rt.get('RecallTask', 'REJECT-DUPLICATE-TASK', { actor }), undefined)
})

test('recall tasks and their owned links survive re-indexing', (t) => {
  const { rt, sources, seededCustomerIds } = setup(t)
  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  const customer = rt.pivot(shipped, 'customerOrders', { actor }).objects.find(
    (candidate) => !seededCustomerIds.includes(candidate.pk),
  )!
  const evidence = rt.intersect(
    rt.filter(rt.traverse(customer, 'customerOrders', { actor }), (order) => order.properties.status === 'shipped'),
    keyboardOrders,
  )
  assert.equal(rt.execute('createRecallTask', {
    taskId: 'RT-REINDEX', customerId: customer.pk, productId: product.pk,
    orderIds: ids(evidence.objects), note: 'Arrange keyboard exchange',
    recordedOn: '2026-09-10', author: 'cs-recall',
  }, { actor }).ok, true)

  rt.load(integrate(sources))
  const task = rt.get('RecallTask', 'RT-REINDEX', { actor })!
  assert.deepEqual(ids(rt.traverse(task, 'customerRecallTasks', { actor }).objects), [customer.pk])
  assert.deepEqual(ids(rt.traverse(task, 'productRecallTasks', { actor }).objects), [product.pk])
  assert.deepEqual(ids(rt.traverse(task, 'recallTaskOrders', { actor }).objects), ids(evidence.objects))
  assert.equal(rt.search('RecallTask', { actor }).objects.length, 4)
})

test('MCP clients find recall customers and receive machine-readable refusals for duplicate tasks', async (t) => {
  const app = setup(t)
  const server = buildMcpServer(app.rt, { agent: 'cs-agent' })
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
  const keyboardOrders = await call<ObjectSet>('traverse_order_products', { source: product })
  assert.equal(keyboardOrders.objects.length, KEYBOARD_ORDERS)
  const shipped = keyboardOrders.objects.filter((order) => order.properties.status === 'shipped')
  const customers = await call<ObjectSet>('pivot_customer_orders', {
    source: { type: 'Order', pks: ids(shipped) },
  })
  assert.equal(customers.objects.length, KEYBOARD_CUSTOMERS)
  const fresh = customers.objects.find((customer) => !app.seededCustomerIds.includes(customer.pk))!
  const seeded = customers.objects.find((customer) => app.seededCustomerIds.includes(customer.pk))!
  const shippedIds = new Set(ids(shipped))
  async function evidence(customer: ObjectInstance) {
    const orders = await call<ObjectSet>('traverse_customer_orders', { source: customer })
    return orders.objects.filter((order) => shippedIds.has(order.pk)).map((order) => order.pk)
  }
  await call('create_recall_task', {
    taskId: 'RT-MCP', customerId: fresh.pk, productId: product.pk, orderIds: await evidence(fresh),
    note: 'Arrange keyboard exchange', recordedOn: '2026-09-10', author: 'cs-agent',
  })
  const refused = await client.callTool({
    name: 'create_recall_task',
    arguments: {
      taskId: 'RT-MCP-REFUSED', customerId: seeded.pk, productId: product.pk, orderIds: await evidence(seeded),
      note: 'Arrange keyboard exchange', recordedOn: '2026-09-10', author: 'cs-agent',
    },
  })
  assert.equal(refused.isError, true)
  assert.ok(Array.isArray(refused.content))
  const refusalBlock = refused.content[0]
  assert.equal(refusalBlock.type, 'text')
  assert.equal(JSON.parse(refusalBlock.text as string).error.code, 'RECALL_TASK_ALREADY_EXISTS')

  const audit = await call<AuditEntry[]>('read_audit_log', {})
  assert.ok(audit.some((entry) =>
    entry.status === 'rejected' && entry.actor === 'agent:cs-agent' && entry.error?.code === 'RECALL_TASK_ALREADY_EXISTS'))
})
