/**
 * The data-layer hand-off: read both legacy systems with plain SQL and
 * normalize them into rows the ontology can index.
 *
 * In a real deployment this is a pipeline's job (in Foundry: transforms +
 * Funnel). It is kept to a few dozen lines of raw SQL here on purpose —
 * data integration is a prerequisite of the pattern, not part of it.
 */
import type { LegacyDbs } from './fixtures.js'

const NORTH_STATUS: Record<number, string> = { 0: 'pending', 1: 'shipped', 2: 'cancelled' }
const SOUTH_STATUS: Record<string, string> = { OPEN: 'pending', SHIPPED: 'shipped', CANCELLED: 'cancelled' }

export function integrate({ north, south }: LegacyDbs) {
  // Customers — prefix primary keys with the source system to avoid collisions.
  const customers = [
    ...north.prepare('SELECT cust_cd, cust_nm, pref_nm FROM tbl_cust').all().map((r: any) => ({
      id: `N-${r.cust_cd}`,
      name: r.cust_nm as string,
      region: r.pref_nm as string,
    })),
    ...south.prepare('SELECT CUST_ID, CUST_NAME, REGION FROM CUSTOMER_MASTER').all().map((r: any) => ({
      id: `S-${r.CUST_ID}`,
      name: r.CUST_NAME as string,
      region: r.REGION as string,
    })),
  ]

  // Orders — unify status encodings; keep the source system so write-back
  // knows which system of record a change belongs to. Note what is absent:
  // `assignee` is ontology-owned, and the runtime refuses a snapshot that
  // tries to supply it — the integration layer never needs to know about
  // state the sources have no authority over. The customer FK is carried
  // here only to build the customerOrders link below: in the model the
  // relationship is represented once, as a link, not also as a property.
  const orders = [
    ...north.prepare('SELECT order_no, cust_cd, stat, amt FROM tbl_order').all().map((r: any) => ({
      customerId: `N-${r.cust_cd}`,
      row: {
        id: `N-${r.order_no}`,
        status: NORTH_STATUS[r.stat as number],
        total: r.amt as number,
        sourceSystem: 'north' as const,
        sourceId: r.order_no as string,
      },
    })),
    ...south.prepare('SELECT ORDER_ID, CUST_ID, ORDER_STATUS, TOTAL_AMT FROM SALES_ORDER').all().map((r: any) => ({
      customerId: `S-${r.CUST_ID}`,
      row: {
        id: `S-${r.ORDER_ID}`,
        status: SOUTH_STATUS[r.ORDER_STATUS as string],
        total: r.TOTAL_AMT as number,
        sourceSystem: 'south' as const,
        sourceId: r.ORDER_ID as string,
      },
    })),
  ]

  // Products — the parent company's ERP owns the item master.
  const products = south
    .prepare('SELECT ITEM_ID, ITEM_NAME, STOCK_QTY FROM ITEM_MASTER')
    .all()
    .map((r: any) => ({ id: r.ITEM_ID as string, name: r.ITEM_NAME as string, stock: r.STOCK_QTY as number }))

  // Links — the FK becomes customerOrders, the join tables become orderProducts.
  // The line items' qty stays in the data layer for now: link properties are a
  // declared non-goal (see README, Non-goals).
  const customerOrders = orders.map((o): [string, string] => [o.customerId, o.row.id])
  const orderProducts: Array<[string, string]> = [
    ...north.prepare('SELECT order_no, item_cd FROM tbl_order_line').all().map((r: any): [string, string] => [
      `N-${r.order_no}`,
      r.item_cd as string,
    ]),
    ...south.prepare('SELECT ORDER_ID, ITEM_ID FROM ORDER_LINE').all().map((r: any): [string, string] => [
      `S-${r.ORDER_ID}`,
      r.ITEM_ID as string,
    ]),
  ]

  return {
    objects: { Customer: customers, Order: orders.map((o) => o.row), Product: products },
    links: { customerOrders, orderProducts },
  }
}
