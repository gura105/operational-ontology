/** Run: pnpm demo:recall. Each run starts with fresh ERP and support data. */
import { createRecall } from './runtime.js'
import { integrate } from './integrate.js'
import { heading as h, log, trace } from '../demo-output.js'

const app = createRecall()
const { rt, sources } = app
const actor = 'user:cs-recall'
try {
  log('2026-09-10: Our keyboard supplier reports a defective key switch in ITM-101.')
  log('Customer support must arrange exchanges for customers with shipped orders.')

  h('1. Find shipped orders containing the recalled keyboard')
  const product = rt.get('Product', 'ITM-101', { actor })!
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  trace('Traverse orderProducts (reverse): Product → Order', { product }, keyboardOrders)
  log(`${keyboardOrders.objects.length} of ${rt.search('Order', { actor }).objects.length} orders contain ${product.pk}.`)

  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  trace('Filter: status = shipped', { keyboardOrders }, shipped)
  const pending = rt.filter(keyboardOrders, (order) => order.properties.status === 'pending')
  const cancelled = rt.filter(keyboardOrders, (order) => order.properties.status === 'cancelled')
  log(`${shipped.objects.length} shipped; exclude ${pending.objects.length} pending and ${cancelled.objects.length} cancelled.`)

  h('2. Find customers who still need a ticket')
  const customers = rt.pivot(shipped, 'customerOrders', { actor })
  trace('Pivot customerOrders (reverse): Order → Customer', { shipped }, customers)
  log(`${shipped.objects.length} orders belong to ${customers.objects.length} customers. Repeat purchases collapse to one customer.`)

  const existingTickets = rt.traverse(product, 'productRecallTickets', { actor })
  trace('Traverse productRecallTickets: Product → RecallTicket', { product }, existingTickets)
  log('These three tickets were recorded in the support system after yesterday\'s phone calls.')
  const coveredCustomers = rt.pivot(existingTickets, 'customerRecallTickets', { actor })
  trace('Pivot customerRecallTickets (reverse): RecallTicket → Customer', { existingTickets }, coveredCustomers)
  const toContact = rt.subtract(customers, coveredCustomers)
  trace('Subtract: affected customers − customers with a ticket for this product', { customers, coveredCustomers }, toContact)

  h('3. Create a support ticket for each selected customer')
  // Selection is complete. Pass the customer and product; the Action rechecks
  // eligibility and duplicates. No per-customer order list is needed here.
  for (const customer of toContact.objects) {
    const ticketId = `RT-${product.pk}-${customer.pk}`
    const result = rt.execute('createRecallTicket', {
      ticketId, customerId: customer.pk, productId: product.pk,
      note: 'Contact customer to arrange exchange of keyboard with defective key switch',
      recordedOn: '2026-09-10', author: 'cs-recall',
    }, { actor })
    if (!result.ok) throw new Error(`${customer.pk}: ${result.error.code} — ${result.error.message}`)
    log(`  ${customer.pk} → ${ticketId}: created in support`)
  }
  log(`${toContact.objects.length} new tickets created.`)
  log('Support database after write-back:')
  console.table(sources.support.prepare('SELECT id, customer_id, product_id, recorded_on FROM tickets ORDER BY id').all())

  h('4. Verify duplicate refusal and coverage after re-indexing')
  const alreadyCovered = coveredCustomers.objects[0]
  const duplicate = rt.execute('createRecallTicket', {
    ticketId: 'RT-DUPLICATE-CHECK', customerId: alreadyCovered.pk, productId: product.pk,
    note: 'Retry exchange-contact ticket creation', recordedOn: '2026-09-10', author: 'cs-recall',
  }, { actor })
  log(`Try another ticket for ${alreadyCovered.pk}:`, duplicate)
  if (duplicate.ok || duplicate.error.code !== 'RECALL_TICKET_ALREADY_EXISTS') {
    throw new Error('expected duplicate ticket refusal')
  }

  rt.load(integrate(sources))
  const refreshedProduct = rt.get('Product', product.pk, { actor })!
  const refreshedOrders = rt.traverse(refreshedProduct, 'orderProducts', { actor })
  const refreshedCustomers = rt.pivot(
    rt.filter(refreshedOrders, (order) => order.properties.status === 'shipped'), 'customerOrders', { actor },
  )
  const tickets = rt.traverse(refreshedProduct, 'productRecallTickets', { actor })
  trace('Re-index, then traverse Product → RecallTicket', { product: refreshedProduct }, tickets)
  const ticketedCustomers = rt.pivot(tickets, 'customerRecallTickets', { actor })
  trace('Pivot RecallTicket → Customer', { tickets }, ticketedCustomers)
  const missing = rt.subtract(refreshedCustomers, ticketedCustomers)
  trace('Subtract: affected customers − ticketed customers', { customers: refreshedCustomers, ticketedCustomers }, missing)
  if (missing.objects.length) throw new Error('some affected customers still need a ticket')
  log(`${refreshedCustomers.objects.length}/${refreshedCustomers.objects.length} affected customers have a ticket after re-indexing.`)

  const audit = rt.auditLog()
  console.table(audit.map((entry) => ({
    action: entry.action, target: entry.target, status: entry.status, error: entry.error?.code ?? '',
  })))
  log(`${audit.length} Action attempts: ${audit.filter((entry) => entry.status === 'applied').length} applied, ${audit.filter((entry) => entry.status === 'rejected').length} rejected.`)
  log('The three existing phone-intake tickets came from support; they are not new ontology Action attempts.')
  log('Ticket creation is complete. Customer contact and exchange completion are not recorded by this demo.')
} finally {
  app.close()
}
