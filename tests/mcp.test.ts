/**
 * The agent-facing surface: tools are generated from the model, writes stay
 * gated, and there is no raw SQL tool to generate in the first place.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createRuntime, type Runtime } from '../src/core.js'
import { buildMcpServer } from '../src/mcp.js'
import { createFixtures } from './helpers/tmp-fixtures.js'
import { integrate } from '../examples/orders/integrate.js'
import { orders } from '../examples/orders/ontology.js'
import { createErpAdapter } from '../examples/orders/erp-adapter.js'

async function connectedClient() {
  const legacy = createFixtures()
  let rt: Runtime
  const adapter = createErpAdapter(legacy, (pk) => rt.get('Order', pk, { actor: 'system:writeback' }))
  rt = createRuntime(orders, new Database(':memory:'), { writeback: adapter })
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
    'assign_order',
    'cancel_order',
    'get_customer',
    'get_order',
    'get_product',
    'read_audit_log',
    'search_customer',
    'search_order',
    'search_product',
    'traverse_customer_orders',
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
