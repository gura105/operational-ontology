import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../../src/mcp.js'
import { objectSet, type ObjectSet } from '../../src/core.js'
import { integrate } from './integrate.js'
import { createFactory } from './runtime.js'

const actor = 'user:factory-ops'
const ids = (objects: readonly { pk: string }[]) => objects.map((object) => object.pk)
function setup(t: TestContext) {
  const app = createFactory()
  t.after(() => app.close())
  return app
}

test('factory intersects equipment and product-history lots, then records priority shipped-line evidence', (t) => {
  const { rt, sources } = setup(t)
  const equipment = rt.filter(rt.search('Equipment', { actor }), (object) => object.properties.inspection === 'pressure-anomaly')
  assert.deepEqual(ids(equipment.objects), ['PRESS-1'])
  const equipmentLots = rt.filter(rt.pivot(equipment, 'producedOn', { actor }), (object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse('2026-09-06T00:00:00+09:00') && time < Date.parse('2026-09-07T00:00:00+09:00')
  })
  assert.deepEqual(ids(equipmentLots.objects), ['L1', 'L3'])
  assert.equal(equipmentLots.objects.every((lot) => lot.properties.releaseInspection === 'passed'), true)
  const products = rt.filter(rt.search('Product', { actor }), (object) => object.properties.pastPressureIssue === true)
  assert.deepEqual(ids(products.objects), ['P-A'])
  const productLots = rt.pivot(products, 'productLots', { actor })
  assert.deepEqual(ids(productLots.objects), ['L1', 'L2', 'L4'])
  const lots = rt.intersect(equipmentLots, productLots)
  assert.deepEqual(ids(lots.objects), ['L1'])
  assert.deepEqual(ids(rt.subtract(equipmentLots, lots).objects), ['L3'], 'not prioritized does not mean cleared of suspicion')
  const affected = rt.pivot(lots, 'lotLines', { actor })
  assert.deepEqual(ids(affected.objects), ['SL1', 'SL3', 'SL5'])
  const shipments = rt.filter(rt.pivot(affected, 'shipmentLines', { actor }), (object) => object.properties.status === 'shipped')
  const lines = rt.intersect(affected, rt.pivot(shipments, 'shipmentLines', { actor }))
  assert.deepEqual(ids(lines.objects), ['SL1', 'SL3'])
  assert.equal(lines.objects.reduce((sum, line) => sum + (line.properties.units as number), 0), 30)
  assert.deepEqual(ids(shipments.objects), ['S1', 'S2'])
  assert.equal(shipments.objects.every((s) => s.properties.status === 'shipped'), true)
  assert.deepEqual(ids(rt.pivot(shipments, 'customerShipments', { actor }).objects), ['C1'])
  const params = {
    customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'TASK1', reason: 'Prioritize contact and reinspection using pressure-related product history',
    after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00', lineIds: ids(lines.objects),
  }
  assert.deepEqual(rt.auditLog(), [])
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  // Wrong date, no matching product history, unshipped, wrong equipment, and duplicates.
  for (const lineIds of [['SL2'], ['SL4'], ['SL5'], ['SL6'], ['SL1', 'SL4'], ['SL1', 'SL1']]) {
    const result = rt.execute('createContactTask', { ...params, lineIds }, { actor })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'INVALID_EVIDENCE')
  }
  assert.equal(rt.execute('createContactTask', { ...params, customerId: 'C2' }, { actor }).ok, false)
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  assert.equal(rt.execute('createContactTask', params, { actor }).ok, true)
  rt.load(integrate(sources))
  const task = rt.get('ContactTask', 'TASK1', { actor })!
  const savedLots = rt.traverse(task, 'contactLots', { actor })
  assert.deepEqual(ids(savedLots.objects), ['L1'])
  assert.deepEqual(ids(rt.pivot(savedLots, 'productLots', { actor }).objects), ['P-A'])
  assert.deepEqual(ids(rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3'])
  assert.deepEqual(ids(rt.traverse(task, 'customerContacts', { actor }).objects), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 1)
})

test('factory exploration deduplicates converging production paths without losing shipment lines', (t) => {
  const { rt } = setup(t)
  const equipment = rt.filter(rt.search('Equipment', { actor }), (object) => ['PRESS-1', 'OVEN-1'].includes(object.properties.id as string))
  const lots = rt.pivot(equipment, 'producedOn', { actor })
  assert.deepEqual(ids(lots.objects), ['L1', 'L2', 'L3'])
  const lines = rt.pivot(lots, 'lotLines', { actor })
  assert.deepEqual(ids(lines.objects), ['SL1', 'SL3', 'SL5', 'SL2', 'SL4'])
  assert.equal(lines.objects.reduce((sum, line) => sum + (line.properties.units as number), 0), 75)
  assert.deepEqual(rt.auditLog(), [])
})

for (const status of ['pending', 'held']) {
  test(`factory excludes ${status} shipments before calculating impact and proposing contact evidence`, (t) => {
    const { rt, sources } = setup(t)
    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S2')
    rt.load(integrate(sources))
    const lots = objectSet('Lot', [rt.get('Lot', 'L1', { actor })!])
    const affected = rt.pivot(lots, 'lotLines', { actor })
    const shipments = rt.filter(rt.pivot(affected, 'shipmentLines', { actor }), (object) => object.properties.status === 'shipped')
    const evidence = rt.intersect(affected, rt.pivot(shipments, 'shipmentLines', { actor }))
    assert.deepEqual(ids(evidence.objects), ['SL1'], 'exclude unshipped lines and unrelated L4 packed in S1')
    assert.equal(evidence.objects[0].properties.units, 10)
    const request = {
      customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'CONTACT', reason: 'Review affected shipped products',
      after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00',
      lineIds: ids(evidence.objects),
    }
    assert.equal(rt.execute('createContactTask', request, { actor }).ok, true)
    assert.deepEqual(ids(rt.traverse(rt.get('ContactTask', 'CONTACT', { actor })!, 'contactLines', { actor }).objects), ['SL1'])

    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S1')
    rt.load(integrate(sources))
    const stale = rt.execute('createContactTask', { ...request, taskId: 'STALE' }, { actor })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error.code, 'INVALID_EVIDENCE')
    assert.equal(rt.get('ContactTask', 'STALE', { actor }), undefined)
  })
}

test('factory rechecks product history and lot-to-product links when a saved selection becomes stale', (t) => {
  const { rt, sources } = setup(t)
  const params = {
    customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'STALE', reason: 'Prioritize reinspection',
    after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00', lineIds: ['SL1', 'SL3'],
  }
  // The selected line IDs stay the same; the evidence on the catalog route changes.
  sources.mes.prepare("UPDATE product SET past_pressure_issue = 0 WHERE id = 'P-A'").run()
  rt.load(integrate(sources))
  assert.equal(rt.execute('createContactTask', params, { actor }).ok, false)
  sources.mes.prepare("UPDATE product SET past_pressure_issue = 1 WHERE id = 'P-A'").run()
  sources.mes.prepare("UPDATE lot SET product_id = 'P-B' WHERE id = 'L1'").run()
  rt.load(integrate(sources))
  assert.equal(rt.execute('createContactTask', params, { actor }).ok, false)
  assert.equal(rt.get('ContactTask', 'STALE', { actor }), undefined)
  assert.equal(rt.traverse(rt.get('Customer', 'C1', { actor })!, 'customerContacts', { actor }).objects.length, 0)
  assert.deepEqual(rt.auditLog().map((entry) => entry.status), ['rejected', 'rejected'])
})

test('MCP clients intersect independent equipment/catalog routes and preserve the remaining investigation scope', async (t) => {
  const app = setup(t)
  const server = buildMcpServer(app.rt, { agent: 'investigator' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'factory-test', version: '0.0.0' })
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
  const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
  const allEquipment = await call<ObjectSet>('search_equipment', {})
  // These predicates run in the client; selected IDs return to the server.
  const equipment = allEquipment.objects.filter((object) => object.properties.inspection === 'pressure-anomaly')
  const produced = await call<ObjectSet>('pivot_produced_on', { source: { type: 'Equipment', pks: ids(equipment) } })
  const equipmentLots = produced.objects.filter((object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse(window.after) && time < Date.parse(window.before)
  })
  const catalog = await call<ObjectSet>('search_product', {})
  const products = catalog.objects.filter((object) => object.properties.pastPressureIssue === true)
  const productLots = await call<ObjectSet>('pivot_product_lots', { source: { type: 'Product', pks: ids(products) } })
  assert.deepEqual(ids(equipmentLots), ['L1', 'L3'])
  assert.deepEqual(ids(productLots.objects), ['L1', 'L2', 'L4'])
  const lots = await call<ObjectSet>('intersect_lot', { left: ids(equipmentLots), right: ids(productLots.objects) })
  assert.deepEqual(ids(lots.objects), ['L1'])
  const remaining = await call<ObjectSet>('subtract_lot', { left: ids(equipmentLots), right: ids(lots.objects) })
  assert.deepEqual(ids(remaining.objects), ['L3'])
  const lines = await call<ObjectSet>('pivot_lot_lines', { source: { type: 'Lot', pks: ids(lots.objects) } })
  const allShipments = await call<ObjectSet>('pivot_shipment_lines', { source: { type: 'ShipmentLine', pks: ids(lines.objects) } })
  const shipments = allShipments.objects.filter((object) => object.properties.status === 'shipped')
  const customers = await call<ObjectSet>('pivot_customer_shipments', { source: { type: 'Shipment', pks: ids(shipments) } })
  assert.deepEqual(ids(customers.objects), ['C1'])
  const packed = await call<ObjectSet>('pivot_shipment_lines', { source: { type: 'Shipment', pks: ids(shipments) } })
  const evidence = await call<ObjectSet>('intersect_shipment_line', { left: ids(lines.objects), right: ids(packed.objects) })
  assert.deepEqual(ids(evidence.objects), ['SL1', 'SL3'])
  assert.equal(evidence.objects.reduce((sum, line) => sum + (line.properties.units as number), 0), 30)
  assert.deepEqual(app.rt.auditLog(), [])
  await call('create_contact_task', {
    customerId: customers.objects[0].pk, equipmentId: equipment[0].pk, taskId: 'MCP-CONTACT', ...window,
    lineIds: ids(evidence.objects), reason: 'Prioritize reinspection using equipment and product-history evidence',
  })
  const task = app.rt.get('ContactTask', 'MCP-CONTACT', { actor })!
  assert.deepEqual(ids(app.rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3'])
  assert.deepEqual(app.rt.auditLog().map((entry) => [entry.status, entry.actor]), [['applied', 'agent:investigator']])
})
