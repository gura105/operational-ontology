/**
 * End-to-end, deterministic demo. Run with: pnpm demo
 *
 *   physical data (2 legacy systems) → integrate → index into the ontology
 *   → read through the model → write through actions → watch a business rule
 *   refuse a write → watch an allowed write reach the system of record.
 */
import Database from 'better-sqlite3'
import { createRuntime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { orders } from './ontology.js'
import { createErpAdapter } from './erp-adapter.js'

// OO_DEMO_PACE=<ms> pauses before each section so terminal recordings stay readable
const pace = Number(process.env.OO_DEMO_PACE ?? 0)
const pause = () => { if (pace) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pace) }
const h = (title: string) => { pause(); console.log(`\n━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`) }

// ── 1. The physical layer exists first ──────────────────────────────────
h('1. Physical data (before any ontology)')
const legacy = createFixtures()
console.log('north.tbl_order:      ', legacy.north.prepare('SELECT * FROM tbl_order').all())
console.log('south.SALES_ORDER:    ', legacy.south.prepare('SELECT * FROM SALES_ORDER').all())

// ── 2. Integrate + index (the data-layer hand-off) ──────────────────────
h('2. Integrate and index into the ontology store')
const snapshot = integrate(legacy)
const rt = createRuntime(orders, new Database(':memory:'), { writeback: createErpAdapter(legacy) })
rt.load(snapshot)
console.log(
  `indexed: ${snapshot.objects.Customer.length} customers, ` +
    `${snapshot.objects.Order.length} orders, ${snapshot.objects.Product.length} products, ` +
    `${snapshot.links.customerOrders.length + snapshot.links.orderProducts.length} link rows`,
)
console.log('declared semantics:', rt.declarations)

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
  rt.aggregate<{ id: string; status: string; total: number }>('Order', {
    ...hq,
    filter: { status: 'pending' },
    // The customer relationship lives in the link, so the region comes from
    // a reverse traversal — not from a duplicated FK property.
    groupBy: (o) =>
      rt.traverse<{ region: string }>('customerOrders', o.id, { ...hq, direction: 'reverse' })[0]?.region ?? 'unknown',
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
console.log('(N-A-1001 already shipped — the rule lives in the model, so every caller meets the same refusal)')

h('6. Write: an allowed cancel reaches the system of record')
const before = legacy.south.prepare("SELECT ORDER_ID, ORDER_STATUS FROM SALES_ORDER WHERE ORDER_ID = 'SO-77'").get()
console.log('south.SALES_ORDER before:', before)
console.log('cancelOrder(S-SO-77):', rt.execute('cancelOrder', { orderId: 'S-SO-77', reason: 'duplicate order' }, { actor: 'user:hq' }).ok ? 'applied' : 'rejected')
const after = legacy.south.prepare("SELECT ORDER_ID, ORDER_STATUS FROM SALES_ORDER WHERE ORDER_ID = 'SO-77'").get()
console.log('south.SALES_ORDER after: ', after, ' ← write-back reached the legacy system')

// ── 7. Failure semantics: write-back-first, observable ──────────────────
h('7. Write: the source refuses a stale write (write-back-first)')
legacy.south.prepare("UPDATE SALES_ORDER SET ORDER_STATUS = 'SHIPPED' WHERE ORDER_ID = 'SO-79'").run()
const stale = rt.execute('cancelOrder', { orderId: 'S-SO-79', reason: 'no longer needed' }, { actor: 'user:hq' })
console.log("the ERP shipped SO-79 behind the ontology's back; cancelOrder(S-SO-79) →", JSON.stringify(stale, null, 2))
console.log(`status here is still "${rt.get<{ status: string }>('Order', 'S-SO-79', hq)!.status}" — write-back ran first, the source refused, nothing changed locally`)

// ── 8. Re-indexing: the sources move on, the ontology's own state survives ──
h('8. Re-index: ontology-owned state survives, source truth refreshes')
rt.execute('addOrderNote', { orderId: 'N-A-1002', noteId: 'NOTE-1', text: 'audit all N- orders before the north system sunsets', author: 'hq-ops' }, { actor: 'user:hq' })
rt.load(integrate(legacy)) // the pipeline runs again over the live legacy systems
const reindexed = rt.get<{ assignee: string | null; status: string }>('Order', 'N-A-1002', hq)!
console.log(`assignee of N-A-1002:  ${reindexed.assignee}  ← ontology-owned, survived the re-index`)
console.log('notes on N-A-1002:    ', rt.traverse<{ text: string }>('orderNotes', 'N-A-1002', hq).map((n) => n.text))
console.log(`status of S-SO-77:     ${rt.get<{ status: string }>('Order', 'S-SO-77', hq)!.status}  ← source-backed, refreshed from the ERP (where the cancellation held)`)
console.log(`status of S-SO-79:     ${rt.get<{ status: string }>('Order', 'S-SO-79', hq)!.status}  ← the truth the source defended in step 7, arriving with the re-index`)

// ── 9. Everything is on the record ──────────────────────────────────────
h('9. Audit log (applied AND rejected attempts)')
for (const e of rt.auditLog()) {
  console.log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
}

pause()
console.log('\nThe business rule lives in the ontology, not in the prompt.')
