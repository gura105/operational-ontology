/**
 * The agent-facing surface: tools are generated from the model, writes stay
 * gated, and there is no raw SQL tool to generate in the first place.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createRuntime, defineAction, defineObject, defineOntology } from '../src/core.js'
import { buildMcpServer } from '../src/mcp.js'
import { createFixtures } from './helpers/tmp-fixtures.js'
import { integrate } from '../examples/orders/integrate.js'
import { orders } from '../examples/orders/ontology.js'
import { createErpAdapter } from '../examples/orders/erp-adapter.js'

async function connectedClient() {
  const legacy = createFixtures()
  const rt = createRuntime(orders, new Database(':memory:'), { writeback: createErpAdapter(legacy) })
  rt.load(integrate(legacy))

  const server = buildMcpServer(rt)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, rt, legacy }
}

test('the tool surface is generated from the model — and contains no raw data access', async () => {
  const { client } = await connectedClient()
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(tools, [
    'add_order_note',
    'aggregate_customer',
    'aggregate_note',
    'aggregate_order',
    'aggregate_product',
    'assign_order',
    'cancel_order',
    'get_customer',
    'get_note',
    'get_order',
    'get_product',
    'read_audit_log',
    'search_customer',
    'search_note',
    'search_order',
    'search_product',
    'traverse_customer_orders',
    'traverse_order_notes',
    'traverse_order_products',
  ])
  for (const name of tools) {
    assert.ok(!/sql|query_raw|update_|insert_|delete_/.test(name), `unexpected raw access tool: ${name}`)
  }
})

test('an agent can read the model through search and traversal', async () => {
  const { client } = await connectedClient()
  const search = await client.callTool({ name: 'search_order', arguments: { status: 'shipped' } })
  const shipped = JSON.parse((search.content as any)[0].text)
  assert.deepEqual(shipped.map((o: any) => o.id).sort(), ['N-A-1001', 'S-SO-78'])

  const traverse = await client.callTool({
    name: 'traverse_customer_orders',
    arguments: { pk: 'N-C01', direction: 'forward' },
  })
  const ordersOfYamada = JSON.parse((traverse.content as any)[0].text)
  assert.deepEqual(ordersOfYamada.map((o: any) => o.id).sort(), ['N-A-1001', 'N-A-1002'])
})

test('an agent can aggregate through the model', async () => {
  const { client } = await connectedClient()
  const result = await client.callTool({
    name: 'aggregate_order',
    arguments: { group_by: 'status', sum: 'total' },
  })
  const groups = JSON.parse((result.content as any)[0].text)
  assert.equal(groups.pending.count, 4)
  assert.equal(groups.pending.sum, 32000)
  assert.equal(groups.shipped.count, 2)
})

test('the same business rule that gates humans gates the agent', async () => {
  const { client, rt } = await connectedClient()
  const result = await client.callTool({
    name: 'cancel_order',
    arguments: { orderId: 'N-A-1001', reason: 'agent cleanup' },
  })
  assert.equal(result.isError, true)
  const payload = JSON.parse((result.content as any)[0].text)
  assert.equal(payload.error.code, 'SHIPPED_ORDER_CANNOT_BE_CANCELLED')
  assert.equal(rt.get<{ status: string }>('Order', 'N-A-1001', { actor: 'user:hq' })!.status, 'shipped')
})

test('the system of record refuses a stale cancellation (guarded write-back)', async () => {
  const { client, rt, legacy } = await connectedClient()
  // The ERP ships the order behind the ontology's back.
  legacy.south.prepare("UPDATE SALES_ORDER SET ORDER_STATUS = 'SHIPPED' WHERE ORDER_ID = 'SO-77'").run()
  const result = await client.callTool({
    name: 'cancel_order',
    arguments: { orderId: 'S-SO-77', reason: 'stale view' },
  })
  assert.equal(result.isError, true)
  const payload = JSON.parse((result.content as any)[0].text)
  assert.equal(payload.error.code, 'WRITEBACK_FAILED')
  assert.equal(rt.get<{ status: string }>('Order', 'S-SO-77', { actor: 'user:hq' })!.status, 'pending')
})

test('aggregate rejects property names the model does not define', async () => {
  const { client } = await connectedClient()
  const result = await client.callTool({ name: 'aggregate_order', arguments: { group_by: 'nonexistent' } })
  assert.equal(result.isError, true)
})

test('wrapped numeric properties (nullable/optional/defaulted/stacked) are still summable', async () => {
  const mini = defineOntology({
    name: 'mini',
    objects: {
      Thing: defineObject({
        primaryKey: 'id',
        properties: {
          id: z.string(),
          label: z.string(),
          score: z.number().nullable(),
          bonus: z.number().default(0),
          depth: z.number().nullable().optional(),
        },
      }),
    },
    links: {},
    actions: {},
  })
  const rt = createRuntime(mini, new Database(':memory:'))
  rt.load({ objects: { Thing: [
    { id: 'T1', label: 'a', score: 5, bonus: 2, depth: 3 },
    { id: 'T2', label: 'a', score: null, bonus: 1 },
  ] } })
  const server = buildMcpServer(rt)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mini-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  for (const [property, expected] of [['score', 5], ['bonus', 3], ['depth', 3]] as const) {
    const result = await client.callTool({
      name: 'aggregate_thing',
      arguments: { group_by: 'label', sum: property },
    })
    assert.notEqual(result.isError, true, `${property} should be summable`)
    const groups = JSON.parse((result.content as any)[0].text)
    assert.equal(groups.a.count, 2)
    assert.equal(groups.a.sum, expected)
  }
})

test('an agent write creates ontology-owned state that survives re-indexing', async () => {
  const { client, rt, legacy } = await connectedClient()
  const filed = await client.callTool({
    name: 'add_order_note',
    arguments: { orderId: 'N-A-1002', noteId: 'NOTE-1', text: 'audit the north orders', author: 'agent-ops' },
  })
  assert.notEqual(filed.isError, true)
  // The pipeline runs again over the live legacy systems.
  rt.load(integrate(legacy))
  const traverse = await client.callTool({
    name: 'traverse_order_notes',
    arguments: { pk: 'N-A-1002', direction: 'forward' },
  })
  const notes = JSON.parse((traverse.content as any)[0].text)
  assert.deepEqual(notes.map((n: any) => n.id), ['NOTE-1'])
})

test('derived tool names that collide fail at build time, both origins named', () => {
  const clash = defineOntology({
    name: 'clash',
    objects: {
      Order: defineObject({ primaryKey: 'id', properties: { id: z.string() } }),
    },
    links: {},
    actions: {
      searchOrder: defineAction({
        object: 'Order',
        targetParam: 'id',
        params: { id: z.string() },
        preconditions: [],
        effects: () => [],
      }),
    },
  })
  const rt = createRuntime(clash, new Database(':memory:'))
  // Both origins are named, so the fix is findable from the error alone.
  assert.throws(() => buildMcpServer(rt), /collision.*search_order.*object type Order.*action searchOrder/)
})

test('an allowed agent write lands, is audited, and reaches the system of record', async () => {
  const { client, rt, legacy } = await connectedClient()
  const result = await client.callTool({
    name: 'cancel_order',
    arguments: { orderId: 'S-SO-77', reason: 'duplicate' },
  })
  assert.notEqual(result.isError, true)
  assert.equal(rt.get<{ status: string }>('Order', 'S-SO-77', { actor: 'user:hq' })!.status, 'cancelled')

  const row = legacy.south
    .prepare("SELECT ORDER_STATUS FROM SALES_ORDER WHERE ORDER_ID = 'SO-77'")
    .get() as { ORDER_STATUS: string }
  assert.equal(row.ORDER_STATUS, 'CANCELLED')

  const audit = await client.callTool({ name: 'read_audit_log', arguments: { status: 'applied' } })
  const entries = JSON.parse((audit.content as any)[0].text)
  assert.equal(entries.length, 1)
  assert.match(entries[0].actor, /^agent:/)
})
