/** Run: pnpm demo:recall. Source databases and the store are reset in memory. */
import { createRecall } from './runtime.js'
import { heading as h, log, pause, showObjects, trace } from '../demo-output.js'

const app = createRecall()
const { rt, seededCustomerIds } = app
const actor = 'user:cs-recall'
try {
  h('0. Yesterday: three customers already phoned')
  const yesterdayTasks = rt.search('RecallTask', { actor })
  trace('Search RecallTask: read the phone-intake records', {}, yesterdayTasks)
  console.table(yesterdayTasks.objects.map((task) => {
    const customer = rt.traverse(task, 'customerRecallTasks', { actor })
    trace(`Traverse customerRecallTasks (reverse): ${task.pk} → Customer`, { task }, customer)
    return {
      task: task.pk, customer: customer.objects[0].pk,
      recordedOn: task.properties.recordedOn, author: task.properties.author,
    }
  }))
  const yesterdayAudit = rt.auditLog().filter((entry) => entry.actor === 'user:cs-phone')
  for (const entry of yesterdayAudit) {
    log(`  #${entry.seq} ${entry.status.padEnd(8)} ${entry.action}(${entry.target}) by ${entry.actor}`)
  }
  log(`${yesterdayTasks.objects.length} tasks and ${yesterdayAudit.length} audit entries were recorded yesterday.`)
  log('Seeded customers:', seededCustomerIds)

  h('1. Read: which orders contain the recalled product?')
  const product = rt.get('Product', 'ITM-101', { actor })!
  showObjects('Get Product: recalled item', product)
  const keyboardOrders = rt.traverse(product, 'orderProducts', { actor })
  trace('Traverse orderProducts (reverse): Product → Order', { product }, keyboardOrders)
  const allOrders = rt.search('Order', { actor })
  trace('Search Order: count the complete order population', {}, allOrders)
  log(`${keyboardOrders.objects.length} of ${allOrders.objects.length} orders contain ${product.pk}.`)

  h('2. Filter: keep orders that already shipped')
  const shipped = rt.filter(keyboardOrders, (order) => order.properties.status === 'shipped')
  trace('Filter status = shipped', { keyboardOrders }, shipped)
  const pending = rt.filter(keyboardOrders, (order) => order.properties.status === 'pending')
  trace('Filter status = pending', { keyboardOrders }, pending)
  const cancelled = rt.filter(keyboardOrders, (order) => order.properties.status === 'cancelled')
  trace('Filter status = cancelled', { keyboardOrders }, cancelled)
  log(`shipped ${shipped.objects.length}, pending ${pending.objects.length}, cancelled ${cancelled.objects.length}`)

  h('3. Pivot: collapse shipped orders to customers')
  const customers = rt.pivot(shipped, 'customerOrders', { actor })
  trace('Pivot customerOrders (reverse): Order → Customer', { shipped }, customers)
  log(`${shipped.objects.length} orders collapsed to ${customers.objects.length} customers.`)

  h('4. Write: record one exchange-contact task per customer')
  let applied = 0
  let rejected = 0
  // This demo calls the action once per customer, 10 times. As a minimal reference
  // implementation it favors one invocation per audit entry. In production, a bulk
  // action that validates every target before applying any, or that stops at the
  // first refusal, is often the more realistic design. Either way the properties
  // stay the same: refusals are named, and every attempt is recorded.
  // Evidence per customer: their shipped orders ∩ the shipped keyboard orders from step 2.
  for (const customer of customers.objects) {
    const customerOrders = rt.traverse(customer, 'customerOrders', { actor })
    const evidence = rt.intersect(rt.filter(customerOrders, (order) => order.properties.status === 'shipped'), shipped)
    const result = rt.execute('createRecallTask', {
      taskId: `RT-${customer.pk}`, customerId: customer.pk, productId: product.pk,
      orderIds: evidence.objects.map((order) => order.pk),
      note: 'Contact customer to arrange exchange of keyboard with defective key switch',
      recordedOn: '2026-09-10', author: 'cs-recall',
    }, { actor })
    const outcome = result.ok ? 'applied' : `${result.error.code} — ${result.error.message}`
    log(`  ${customer.pk.padEnd(8)} evidence [${evidence.objects.map((order) => order.pk).join(', ')}] → ${outcome}`)
    if (result.ok) applied++
    else rejected++
  }
  log(`applied ${applied}, rejected ${rejected}`)

  h('5. Verify: every affected customer has a recall task')
  const uncovered = customers.objects.filter((customer) => rt.traverse(customer, 'customerRecallTasks', { actor }).objects.length === 0)
  log('Traverse customerRecallTasks (forward) from each customer; yesterday\'s three tasks count too.')
  if (uncovered.length) log('  without a task:', uncovered.map((customer) => customer.pk))
  log(`${customers.objects.length - uncovered.length}/${customers.objects.length} customers have a recall task.`)

  log('Task coverage only; customer contact and exchange completion are not recorded.')

  h('6. Audit log (applied AND rejected attempts)')
  const audit = rt.auditLog()
  for (const entry of audit) {
    log(`  #${entry.seq} ${entry.status.padEnd(8)} ${entry.action}(${entry.target}) by ${entry.actor}${entry.error ? ` — ${entry.error.code}` : ''}`)
  }
  log(`${audit.length} audit entries: applied ${audit.filter((entry) => entry.status === 'applied').length}, rejected ${audit.filter((entry) => entry.status === 'rejected').length}.`)

  pause()
  log('\nThe check for existing tasks lives in the ontology, so the tenth call meets the same rule as the first.')
} finally {
  app.close()
}
