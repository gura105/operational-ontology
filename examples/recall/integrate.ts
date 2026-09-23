/** Data-layer hand-off: normalize two ERPs and support tickets into one snapshot. */
import type { RecallDbs } from './fixtures.js'

const NORTH_STATUS: Record<number, string> = { 0: 'pending', 1: 'shipped', 2: 'cancelled' }
const SOUTH_STATUS: Record<string, string> = { OPEN: 'pending', SHIPPED: 'shipped', CANCELLED: 'cancelled' }

export function integrate({ north, south, support }: RecallDbs) {
  const customers = [
    ...north.prepare('SELECT cust_cd, cust_nm, pref_nm FROM tbl_cust').all().map((r: any) => ({
      id: `N-${r.cust_cd}`, name: r.cust_nm as string, region: r.pref_nm as string,
    })),
    ...south.prepare('SELECT CUST_ID, CUST_NAME, REGION FROM CUSTOMER_MASTER').all().map((r: any) => ({
      id: `S-${r.CUST_ID}`, name: r.CUST_NAME as string, region: r.REGION as string,
    })),
  ]
  const orders = [
    ...north.prepare('SELECT order_no, cust_cd, stat, amt FROM tbl_order').all().map((r: any) => ({
      customerId: `N-${r.cust_cd}`,
      row: {
        id: `N-${r.order_no}`, status: NORTH_STATUS[r.stat as number], total: r.amt as number,
        sourceSystem: 'north' as const, sourceId: r.order_no as string,
      },
    })),
    ...south.prepare('SELECT ORDER_ID, CUST_ID, ORDER_STATUS, TOTAL_AMT FROM SALES_ORDER').all().map((r: any) => ({
      customerId: `S-${r.CUST_ID}`,
      row: {
        id: `S-${r.ORDER_ID}`, status: SOUTH_STATUS[r.ORDER_STATUS as string], total: r.TOTAL_AMT as number,
        sourceSystem: 'south' as const, sourceId: r.ORDER_ID as string,
      },
    })),
  ]
  const products = south.prepare('SELECT ITEM_ID, ITEM_NAME, STOCK_QTY FROM ITEM_MASTER').all().map((r: any) => ({
    id: r.ITEM_ID as string, name: r.ITEM_NAME as string, stock: r.STOCK_QTY as number,
  }))
  const customerOrders = orders.map((order): [string, string] => [order.customerId, order.row.id])
  const orderProducts: Array<[string, string]> = [
    ...north.prepare('SELECT order_no, item_cd FROM tbl_order_line').all().map((r: any): [string, string] => [
      `N-${r.order_no}`, r.item_cd as string,
    ]),
    ...south.prepare('SELECT ORDER_ID, ITEM_ID FROM ORDER_LINE').all().map((r: any): [string, string] => [
      `S-${r.ORDER_ID}`, r.ITEM_ID as string,
    ]),
  ]
  const tickets = support.prepare('SELECT id, customer_id, product_id, note, recorded_on, author FROM tickets')
    .all() as Array<{
      id: string; customer_id: string; product_id: string; note: string; recorded_on: string; author: string
    }>
  return {
    objects: {
      Customer: customers, Order: orders.map((order) => order.row), Product: products,
      RecallTicket: tickets.map((ticket) => ({
        id: ticket.id, note: ticket.note, recordedOn: ticket.recorded_on, author: ticket.author,
      })),
    },
    links: {
      customerOrders, orderProducts,
      customerRecallTickets: tickets.map((ticket): [string, string] => [ticket.customer_id, ticket.id]),
      productRecallTickets: tickets.map((ticket): [string, string] => [ticket.product_id, ticket.id]),
    },
  }
}
