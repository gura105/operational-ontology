/**
 * End-to-end, deterministic demo. Run with: pnpm demo
 *
 *   physical data (2 legacy systems) → integrate → index into the ontology
 *   → read through the model → write through actions → watch a business rule
 *   refuse a write → watch an allowed write reach the system of record.
 */
import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { orders } from './ontology.js'
import { createErpAdapter } from './erp-adapter.js'

const h = (title: string) => console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`)

// ── 1. The physical layer exists first ──────────────────────────────────
h('1. Physical data (before any ontology)')
const legacy = createFixtures()
console.log('north.tbl_order:      ', legacy.north.prepare('SELECT * FROM tbl_order').all())
console.log('south.SALES_ORDER:    ', legacy.south.prepare('SELECT * FROM SALES_ORDER').all())

// ── 2. Integrate + index (the data-layer hand-off) ──────────────────────
h('2. Integrate and index into the ontology store')
const snapshot = integrate(legacy)
let rt: Runtime
const adapter = createErpAdapter(legacy, (pk) => rt.get('Order', pk, { actor: 'system:writeback' }))
rt = createRuntime(orders, new Database(':memory:'), { writeback: adapter })
rt.load(snapshot)
console.log(
  `indexed: ${snapshot.objects.Customer.length} customers, ` +
    `${snapshot.objects.Order.length} orders, ${snapshot.objects.Product.length} products, ` +
    `${snapshot.links.customerOrders.length + snapshot.links.orderProducts.length} link rows`,
)

// ── 3. Read side: query the model, not the tables — always as someone ───
h('3. Read: traverse links, aggregate at query time')
const hq = { actor: 'user:hq' }
const yamada = rt.get<{ id: string; name: string }>('Customer', 'N-C01', hq)!
console.log(`orders of ${yamada.name}:`)
for (const o of rt.traverse<{ id: string; status: string; total: number }>('customerOrders', yamada.id, hq)) {
  console.log(`  ${o.id}  ${o.status.padEnd(9)} ¥${o.total}`)
}
console.log('who ordered Keyboard (reverse traversal):',
  rt.traverse<{ id: string }>('orderProducts', 'ITM-101', { ...hq, direction: 'reverse' }).map((o) => o.id))
console.log('pending order value by region:',
  rt.aggregate<{ status: string; total: number; customerId: string }>('Order', {
    ...hq,
    filter: { status: 'pending' },
    groupBy: (o) => rt.get<{ region: string }>('Customer', o.customerId, hq)?.region ?? 'unknown',
    sum: (o) => o.total,
  }))
console.log('same search, different actors (visibility lives in the model):')
console.log('  as user:north-sales:', rt.search<{ id: string }>('Order', { actor: 'user:north-sales' }).map((o) => o.id))
console.log('  as user:hq:         ', rt.search<{ id: string }>('Order', hq).map((o) => o.id))

// ── 4. Write side: every change is an action ────────────────────────────
h('4. Write: an allowed action')
console.log('assignOrder(N-A-1002 → alice):', rt.execute('assignOrder', { orderId: 'N-A-1002', assignee: 'alice' }, { actor: 'user:hq' }))

h('5. Write: a business rule refuses')
const refused = rt.execute('cancelOrder', { orderId: 'N-A-1001', reason: 'customer changed their mind' }, { actor: 'user:hq' })
console.log('cancelOrder(N-A-1001) →', JSON.stringify(refused, null, 2))
console.log('(N-A-1001 already shipped — the rule lives in the model, so no caller can bypass it)')

h('6. Write: an allowed cancel reaches the system of record')
const before = legacy.south.prepare("SELECT ORDER_ID, ORDER_STATUS FROM SALES_ORDER WHERE ORDER_ID = 'SO-77'").get()
console.log('south.SALES_ORDER before:', before)
console.log('cancelOrder(S-SO-77):', rt.execute('cancelOrder', { orderId: 'S-SO-77', reason: 'duplicate order' }, { actor: 'user:hq' }).ok ? 'applied' : 'rejected')
const after = legacy.south.prepare("SELECT ORDER_ID, ORDER_STATUS FROM SALES_ORDER WHERE ORDER_ID = 'SO-77'").get()
console.log('south.SALES_ORDER after: ', after, ' ← write-back reached the legacy system')

// ── 7. Everything is on the record ──────────────────────────────────────
h('7. Audit log (applied AND rejected attempts)')
for (const e of rt.auditLog()) {
  console.log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
}

console.log('\nThe business rule lives in the ontology, not in the prompt.')
