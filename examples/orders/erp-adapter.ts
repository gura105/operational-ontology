/**
 * Write-back adapter for the two legacy systems. Routes the status change to
 * the system of record the target order came from — `meta.target` carries
 * the order as the runtime loaded it — translating back into that system's
 * own encoding (integer codes for north, text statuses for south).
 *
 * Runs BEFORE the ontology store commits (write-back-first ordering): if the
 * system of record refuses the change, the ontology does not change either.
 * An edit this adapter does not know how to write back is an error, not a
 * shrug — silently skipping one would strand the change locally, the shadow
 * copy the fourth property forbids.
 */
import type { Edit, WritebackAdapter } from '../../src/core.js'
import type { LegacyDbs } from './fixtures.js'

const NORTH_CODE: Record<string, number> = { pending: 0, shipped: 1, cancelled: 2 }

export function createErpAdapter(dbs: LegacyDbs): WritebackAdapter {
  return {
    name: 'legacy-erp',
    apply(edits: Edit[], meta) {
      for (const edit of edits) {
        if (edit.op !== 'modify' || edit.object !== 'Order' || edit.pk !== meta.target.pk) {
          throw new Error(`legacy-erp cannot write back ${edit.op} on ${'object' in edit ? edit.object : edit.link}`)
        }
        const status = edit.changes.status as string | undefined
        if (!status || Object.keys(edit.changes).length !== 1) {
          throw new Error('legacy-erp can only write back Order.status changes')
        }

        const order = meta.target.object as { sourceSystem: string; sourceId: string }

        // The system of record re-verifies its own invariant on cancellation:
        // a guarded UPDATE lets the ERP refuse a stale cancel even when the
        // ontology's view of the order was out of date (see "Preconditions
        // and freshness" in the README).
        if (order.sourceSystem === 'north') {
          const res = dbs.north
            .prepare(`UPDATE tbl_order SET stat = ? WHERE order_no = ?${status === 'cancelled' ? ' AND stat != 1' : ''}`)
            .run(NORTH_CODE[status], order.sourceId)
          if (res.changes !== 1) throw new Error(`north system refused update of ${order.sourceId}`)
        } else {
          const res = dbs.south
            .prepare(
              `UPDATE SALES_ORDER SET ORDER_STATUS = ? WHERE ORDER_ID = ?${status === 'cancelled' ? " AND ORDER_STATUS != 'SHIPPED'" : ''}`,
            )
            .run(status.toUpperCase(), order.sourceId)
          if (res.changes !== 1) throw new Error(`south system refused update of ${order.sourceId}`)
        }
      }
    },
  }
}
