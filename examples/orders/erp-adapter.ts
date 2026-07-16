/**
 * Write-back adapter for the two legacy systems. Routes each Order edit to
 * the system of record it came from, translating back into that system's
 * own encoding (integer codes for north, text statuses for south).
 *
 * Runs BEFORE the ontology store commits (write-back-first ordering): if the
 * system of record refuses the change, the ontology does not change either.
 */
import type { Edit, WritebackAdapter } from '../../src/core.js'
import type { LegacyDbs } from './fixtures.js'

const NORTH_CODE: Record<string, number> = { pending: 0, shipped: 1, cancelled: 2 }

export function createErpAdapter(
  dbs: LegacyDbs,
  lookupOrder: (pk: string) => { sourceSystem: string; sourceId: string } | undefined,
): WritebackAdapter {
  return {
    name: 'legacy-erp',
    apply(edits: Edit[]) {
      for (const edit of edits) {
        if (edit.op !== 'modify' || edit.object !== 'Order') continue
        const status = edit.changes.status as string | undefined
        if (!status) continue // only status changes exist in the legacy schemas

        const order = lookupOrder(edit.pk)
        if (!order) throw new Error(`order ${edit.pk} not found in the ontology store`)

        if (order.sourceSystem === 'north') {
          const res = dbs.north
            .prepare('UPDATE tbl_order SET stat = ? WHERE order_no = ?')
            .run(NORTH_CODE[status], order.sourceId)
          if (res.changes !== 1) throw new Error(`north system rejected update of ${order.sourceId}`)
        } else {
          const res = dbs.south
            .prepare('UPDATE SALES_ORDER SET ORDER_STATUS = ? WHERE ORDER_ID = ?')
            .run(status.toUpperCase(), order.sourceId)
          if (res.changes !== 1) throw new Error(`south system rejected update of ${order.sourceId}`)
        }
      }
    },
  }
}
