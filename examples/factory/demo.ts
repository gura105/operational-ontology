/** Run: pnpm demo:factory. Source databases and the store are reset in memory. */
import { createFactory } from './runtime.js'
import { heading as h, log, showObjects, trace } from '../demo-output.js'

const app = createFactory()
const { rt } = app
const actor = 'user:factory-ops'
const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
try {
  h('1. Read: an inspection finding sets the investigation scope')
  log('Goal: prioritize lots using equipment findings and product history, then record a customer contact/reinspection task.')
  log('September 8: an inspection found a pressure anomaly. Release inspections had passed; goods shipped September 7.')
  log('September 6 is the supplied investigation window, not an inferred failure interval.')
  log('Catalog history concerns earlier lots with pressure-related issues. Product specifications are unchanged in this example.')
  const allEquipment = rt.search('Equipment', { actor })
  trace('Search Equipment: inspect the recorded findings', {}, allEquipment)
  console.table(allEquipment.objects.map(({ pk, properties }) => ({ equipment: pk, inspection: properties.inspection })))
  const equipment = rt.filter(allEquipment, (object) => object.properties.inspection === 'pressure-anomaly')
  trace('Filter inspection = pressure-anomaly: choose the investigation origin', { allEquipment }, equipment)

  h('2. Read: follow two independent routes to Lot sets')
  const produced = rt.pivot(equipment, 'producedOn', { actor })
  trace('Pivot producedOn (forward): Equipment → Lot', { equipment }, produced)
  console.table(produced.objects.map(({ pk, properties }) => ({ lot: pk, manufacturedAt: properties.manufacturedAt })))
  const equipmentLots = rt.filter(produced, (object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse(window.after) && time < Date.parse(window.before)
  })
  trace(`Filter manufacturing time: ${window.after} <= time < ${window.before}`, { produced }, equipmentLots)
  showObjects('Set A: lots made on the anomalous equipment in the investigation window', equipmentLots)
  log('L2 falls outside the supplied manufacturing window.')
  const catalog = rt.search('Product', { actor })
  trace('Search Product: start the independent catalog route', {}, catalog)
  console.table(catalog.objects.map(({ pk, properties }) => ({ product: pk, name: properties.name, pastPressureIssue: properties.pastPressureIssue })))
  const products = rt.filter(catalog, (object) => object.properties.pastPressureIssue === true)
  trace('Filter pastPressureIssue = true: select product numbers with relevant history', { catalog }, products)
  const productLots = rt.pivot(products, 'productLots', { actor })
  trace('Pivot productLots (forward): Product → Lot', { products }, productLots)
  showObjects('Set B: lots of products with past pressure-related issues', productLots)

  h('3. Transform: intersect the two routes to prioritize investigation')
  const lots = rt.intersect(equipmentLots, productLots)
  trace('Intersect A ∩ B: equipment/window lots ∩ product-history lots', { A: equipmentLots, B: productLots }, lots)
  log('L1 meets both conditions. L2 is outside the window; L4 was made on another press.')
  const remaining = rt.subtract(equipmentLots, lots)
  trace('Subtract A − priority: keep the remaining equipment-related investigation scope', { A: equipmentLots, priority: lots }, remaining)
  log('L3 remains under review. No recorded product history does not mean the lot is safe; L1 is prioritized, not confirmed defective.')

  h('4. Read: trace priority lots to shipped evidence and customers')
  const lines = rt.pivot(lots, 'lotLines', { actor })
  trace('Pivot lotLines (forward): Lot → ShipmentLine', { lots }, lines)
  showObjects('Priority-lot lines, including unshipped goods', lines)
  const allShipments = rt.pivot(lines, 'shipmentLines', { actor })
  trace('Pivot shipmentLines (reverse): ShipmentLine → Shipment', { lines }, allShipments)
  console.table(allShipments.objects.map(({ pk, properties }) => ({ shipment: pk, status: properties.status })))
  const shipments = rt.filter(allShipments, (object) => object.properties.status === 'shipped')
  trace('Filter status = shipped: keep goods already sent', { allShipments }, shipments)
  const packedLines = rt.pivot(shipments, 'shipmentLines', { actor })
  trace('Pivot shipmentLines (forward): return to the shipped contents', { shipments }, packedLines)
  showObjects('Shipped contents, including lots outside the priority set', packedLines)
  const evidence = rt.intersect(lines, packedLines)
  trace('Intersect priority-lot lines ∩ shipped contents: retain the contact evidence', { lines, packedLines }, evidence)
  log('Exclude unshipped SL5, SL4 from remaining L3, and SL6 from another press. Evidence: SL1 and SL3.')
  const customers = rt.pivot(shipments, 'customerShipments', { actor })
  trace('Pivot customerShipments (reverse): Shipment → Customer', { shipments }, customers)
  log('S1 and S2 converge on C1. C2 received out-of-window L2; C3 has only an unshipped part of L1.')
  log('\n  Aggregate: sum units on the retained ShipmentLine records')
  showObjects('input', evidence)
  console.table(evidence.objects.map(({ pk, properties }) => ({ line: pk, units: properties.units })))
  const priorityUnits = evidence.objects.reduce((sum, line) => sum + (line.properties.units as number), 0)
  log('Units in evidence:', priorityUnits)
  log('These are 30 shipped units: 10 + 20. L1 has 40 units including 10 unshipped; S1 and S2 contain 55 including 25 from other lots.')

  h('5. Write: record a priority customer contact task with its evidence')
  const customer = customers.objects[0]
  log('Contact summary:', { customer: customer.pk, lots: lots.objects.map((lot) => lot.pk), shipments: shipments.objects.length, lines: evidence.objects.length, priorityUnits })
  // This is the same evidence set we just intersected and summed.
  const request = {
    customerId: customer.pk, equipmentId: equipment.objects[0].pk, taskId: 'CONTACT-C1', ...window,
    lineIds: evidence.objects.map((line) => line.pk),
    reason: 'Prioritize contact and reinspection: pressure anomaly and product history overlap. Defects are unconfirmed; other equipment-related lots remain under review.',
  }
  log('Selected customer and evidence:', request)
  log('Tasks before execution:', rt.search('ContactTask', { actor }).objects.length)
  log('Execution rechecks the pressure anomaly, window, product history, customer and shipped-line evidence against current records.')
  log('Create task:', rt.execute('createContactTask', request, { actor }))
  log('Task creation sends no message and does not try to hold already shipped products.')

  h('6. Read: inspect the saved task and both sources of evidence')
  const task = rt.get('ContactTask', 'CONTACT-C1', { actor })!
  log('Saved contact task:', task)
  for (const link of ['customerContacts', 'contactEquipment', 'contactLots', 'contactLines']) {
    trace(`Traverse ${link}: task → saved evidence`, { task }, rt.traverse(task, link, { actor }))
  }
  const savedLots = rt.traverse(task, 'contactLots', { actor })
  trace('Pivot productLots (reverse): saved lots → product catalog history', { savedLots }, rt.pivot(savedLots, 'productLots', { actor }))
  log('Next: review contact/reinspection for L1 and continue investigating L3. No causal conclusion or safety clearance has been made.')

  h('7. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
