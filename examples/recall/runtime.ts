import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { createRecallOntology, type Recall } from './ontology.js'

export function createRecall() {
  const sources = createFixtures()
  const store = new Database(':memory:')
  // Rules read through this getter after rt has been assigned.
  let rt: Runtime<Recall>
  const ontology = createRecallOntology(() => rt)
  rt = createRuntime(ontology, store)
  rt.load(integrate(sources))

  const actor = 'user:cs-phone'
  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  const seededCustomers = rt.pivot(shipped, 'customerOrders', { actor }).objects.slice(0, 3)
  // Owned objects cannot come from a snapshot (load refuses owned types), so
  // executing the Action is the only correct way to seed them. Tests and the
  // MCP server share this starting state.
  for (const [index, customer] of seededCustomers.entries()) {
    const customerOrders = rt.traverse(customer, 'customerOrders', { actor })
    const evidence = rt.intersect(
      rt.filter(customerOrders, (order) => order.properties.status === 'shipped'),
      keyboardOrders,
    )
    const result = rt.execute('createRecallTask', {
      taskId: `RT-PHONE-${index + 1}`, customerId: customer.pk, productId: product.pk,
      orderIds: evidence.objects.map((order) => order.pk),
      note: 'Customer phoned about keyboard defect; exchange arranged',
      recordedOn: '2026-09-09', author: 'cs-phone',
    }, { actor })
    if (!result.ok) throw new Error(`failed to seed ${customer.pk}: ${result.error.code}`)
  }
  return {
    rt, sources, seededCustomerIds: seededCustomers.map((customer) => customer.pk),
    close() { store.close(); sources.north.close(); sources.south.close() },
  }
}
