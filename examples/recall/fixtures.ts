/**
 * Two legacy order systems left over from an acquisition. Their schemas and
 * status encodings differ; in-memory databases keep every run isolated.
 */
import Database from 'better-sqlite3'

export const SEED = 20260910
export const TOTAL_ORDERS = 300
export const KEYBOARD_ORDERS = 48
export const KEYBOARD_SHIPPED = 31
export const KEYBOARD_PENDING = 14
export const KEYBOARD_CANCELLED = 3
export const KEYBOARD_CUSTOMERS = 27

const PRODUCTS = [
  ['ITM-100', 'Monitor 27"', 30, 26_000],
  ['ITM-101', 'Keyboard', 12, 8_000],
  ['ITM-102', 'Mouse', 55, 4_000],
  ['ITM-103', 'Webcam', 24, 11_000],
  ['ITM-104', 'Headset', 38, 9_000],
  ['ITM-105', 'USB-C Dock', 19, 15_000],
] as const
const NON_KEYBOARD = PRODUCTS.filter(([id]) => id !== 'ITM-101')
const NORTH_STATUS = { pending: 0, shipped: 1, cancelled: 2 } as const
const SOUTH_STATUS = { pending: 'OPEN', shipped: 'SHIPPED', cancelled: 'CANCELLED' } as const
type Status = keyof typeof NORTH_STATUS

const NORTH_CUSTOMERS = [
  ['C01', 'Yamada Trading', 'Tokyo'],
  ['C02', 'Suzuki Industries', 'Osaka'],
  ['C03', 'Takahashi Manufacturing', 'Aichi'],
  ['C04', 'Ito Retail', 'Chiba'],
  ['C05', 'Watanabe Systems', 'Kanagawa'],
  ['C06', 'Nakamura Foods', 'Hokkaido'],
  ['C07', 'Kobayashi Electric', 'Kyoto'],
  ['C08', 'Kato Medical', 'Hyogo'],
  ['C09', 'Yoshida Transport', 'Saitama'],
  ['C10', 'Yamamoto Construction', 'Miyagi'],
  ['C11', 'Saito Services', 'Hiroshima'],
  ['C12', 'Matsumoto Textiles', 'Nagano'],
  ['C13', 'Inoue Chemicals', 'Shizuoka'],
  ['C14', 'Kimura Precision', 'Tochigi'],
  ['C15', 'Hayashi Packaging', 'Gunma'],
  ['C16', 'Shimizu Printing', 'Niigata'],
  ['C17', 'Yamasaki Supply', 'Okayama'],
  ['C18', 'Moriya Labs', 'Ibaraki'],
  ['C19', 'Abe Commerce', 'Fukushima'],
  ['C20', 'Ikeda Works', 'Ehime'],
] as const

const SOUTH_CUSTOMERS = [
  ['9001', 'Sato Logistics', 'Tokyo'],
  ['9002', 'Tanaka Foods', 'Fukuoka'],
  ['9003', 'Mori Electronics', 'Osaka'],
  ['9004', 'Hashimoto Pharma', 'Kanagawa'],
  ['9005', 'Yamashita Motors', 'Aichi'],
  ['9006', 'Ishikawa Design', 'Kyoto'],
  ['9007', 'Nakajima Office', 'Chiba'],
  ['9008', 'Maeda Materials', 'Hyogo'],
  ['9009', 'Fujita Networks', 'Saitama'],
  ['9010', 'Ogawa Hotels', 'Okinawa'],
  ['9011', 'Goto Equipment', 'Miyagi'],
  ['9012', 'Okada Market', 'Hiroshima'],
  ['9013', 'Hasegawa Tools', 'Shizuoka'],
  ['9014', 'Murakami Ceramics', 'Ishikawa'],
  ['9015', 'Kondo Apparel', 'Gifu'],
  ['9016', 'Ishii Energy', 'Nagano'],
  ['9017', 'Sakamoto Marine', 'Kagoshima'],
  ['9018', 'Endo Security', 'Ibaraki'],
  ['9019', 'Aoki Produce', 'Kumamoto'],
  ['9020', 'Fujii Hardware', 'Nara'],
] as const

const northKeyboard: Array<{ customer: string; status: Status }> = [
  ...NORTH_CUSTOMERS.slice(0, 14).map(([customer]) => ({ customer, status: 'shipped' as const })),
  { customer: 'C01', status: 'shipped' }, { customer: 'C02', status: 'shipped' },
  { customer: 'C01', status: 'pending' }, { customer: 'C03', status: 'pending' },
  { customer: 'C04', status: 'pending' }, { customer: 'C05', status: 'pending' },
  { customer: 'C06', status: 'pending' }, { customer: 'C07', status: 'pending' },
  { customer: 'C08', status: 'pending' }, { customer: 'C09', status: 'cancelled' },
]

const southKeyboard: Array<{ customer: string; status: Status }> = [
  ...SOUTH_CUSTOMERS.slice(0, 13).map(([customer]) => ({ customer, status: 'shipped' as const })),
  { customer: '9001', status: 'shipped' }, { customer: '9002', status: 'shipped' },
  { customer: '9001', status: 'pending' }, { customer: '9003', status: 'pending' },
  { customer: '9004', status: 'pending' }, { customer: '9005', status: 'pending' },
  { customer: '9006', status: 'pending' }, { customer: '9007', status: 'pending' },
  { customer: '9008', status: 'pending' }, { customer: '9009', status: 'cancelled' },
  { customer: '9010', status: 'cancelled' },
]

function mulberry32(seed: number) {
  let value = seed
  return () => {
    value = (value + 0x6d2b79f5) | 0
    let result = Math.imul(value ^ (value >>> 15), 1 | value)
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

export function createFixtures() {
  const north = new Database(':memory:')
  north.exec(`
    CREATE TABLE tbl_cust (cust_cd TEXT PRIMARY KEY, cust_nm TEXT, pref_nm TEXT);
    CREATE TABLE tbl_order (order_no TEXT PRIMARY KEY, cust_cd TEXT, stat INTEGER, amt INTEGER);
    -- stat: 0 = open, 1 = shipped, 2 = cancelled
    CREATE TABLE tbl_order_line (order_no TEXT, item_cd TEXT, qty INTEGER);
  `)
  const south = new Database(':memory:')
  south.exec(`
    CREATE TABLE CUSTOMER_MASTER (CUST_ID TEXT PRIMARY KEY, CUST_NAME TEXT, REGION TEXT);
    CREATE TABLE SALES_ORDER (ORDER_ID TEXT PRIMARY KEY, CUST_ID TEXT, ORDER_STATUS TEXT, TOTAL_AMT INTEGER);
    -- ORDER_STATUS: 'OPEN' | 'SHIPPED' | 'CANCELLED'
    CREATE TABLE ORDER_LINE (ORDER_ID TEXT, ITEM_ID TEXT, QTY INTEGER);
    CREATE TABLE ITEM_MASTER (ITEM_ID TEXT PRIMARY KEY, ITEM_NAME TEXT, STOCK_QTY INTEGER);
  `)

  const random = mulberry32(SEED)
  north.transaction(() => {
    const customer = north.prepare('INSERT INTO tbl_cust VALUES (?, ?, ?)')
    const order = north.prepare('INSERT INTO tbl_order VALUES (?, ?, ?, ?)')
    const line = north.prepare('INSERT INTO tbl_order_line VALUES (?, ?, ?)')
    for (const row of NORTH_CUSTOMERS) customer.run(...row)
    // Keyboard orders are explicit so their status and customer counts cannot drift.
    for (const [index, plan] of northKeyboard.entries()) {
      const orderId = `A-${1001 + index}`
      const extra = NON_KEYBOARD[index % NON_KEYBOARD.length]
      order.run(orderId, plan.customer, NORTH_STATUS[plan.status], 8_000 + extra[3])
      line.run(orderId, 'ITM-101', 1)
      line.run(orderId, extra[0], 1)
    }
    // The first filler order is fixed: C04 also has a pending keyboard order, so it
    // gives scenario.test.ts a shipped order without the product for INVALID_EVIDENCE.
    for (let index = northKeyboard.length; index < 150; index++) {
      const orderId = `A-${1001 + index}`
      const customerId = index === northKeyboard.length
        ? 'C04'
        : NORTH_CUSTOMERS[Math.floor(random() * NORTH_CUSTOMERS.length)][0]
      const status: Status = index === northKeyboard.length
        ? 'shipped'
        : (['pending', 'shipped', 'cancelled'] as const)[Math.floor(random() * 3)]
      const count = 1 + Math.floor(random() * 3)
      const start = Math.floor(random() * NON_KEYBOARD.length)
      let total = 0
      for (let offset = 0; offset < count; offset++) {
        const product = NON_KEYBOARD[(start + offset) % NON_KEYBOARD.length]
        const quantity = 1 + Math.floor(random() * 4)
        total += product[3] * quantity
        line.run(orderId, product[0], quantity)
      }
      order.run(orderId, customerId, NORTH_STATUS[status], total)
    }
  })()

  south.transaction(() => {
    const customer = south.prepare('INSERT INTO CUSTOMER_MASTER VALUES (?, ?, ?)')
    const order = south.prepare('INSERT INTO SALES_ORDER VALUES (?, ?, ?, ?)')
    const line = south.prepare('INSERT INTO ORDER_LINE VALUES (?, ?, ?)')
    const product = south.prepare('INSERT INTO ITEM_MASTER VALUES (?, ?, ?)')
    for (const row of SOUTH_CUSTOMERS) customer.run(...row)
    for (const [id, name, stock] of PRODUCTS) product.run(id, name, stock)
    // The second legacy system contributes the other half of the keyboard orders.
    for (const [index, plan] of southKeyboard.entries()) {
      const orderId = `SO-${77 + index}`
      const extra = NON_KEYBOARD[(index + 2) % NON_KEYBOARD.length]
      order.run(orderId, plan.customer, SOUTH_STATUS[plan.status], 8_000 + extra[3])
      line.run(orderId, 'ITM-101', 1)
      line.run(orderId, extra[0], 1)
    }
    for (let index = southKeyboard.length; index < 150; index++) {
      const orderId = `SO-${77 + index}`
      const customerId = SOUTH_CUSTOMERS[Math.floor(random() * SOUTH_CUSTOMERS.length)][0]
      const status = (['pending', 'shipped', 'cancelled'] as const)[Math.floor(random() * 3)]
      const count = 1 + Math.floor(random() * 3)
      const start = Math.floor(random() * NON_KEYBOARD.length)
      let total = 0
      for (let offset = 0; offset < count; offset++) {
        const item = NON_KEYBOARD[(start + offset) % NON_KEYBOARD.length]
        const quantity = 1 + Math.floor(random() * 4)
        total += item[3] * quantity
        line.run(orderId, item[0], quantity)
      }
      order.run(orderId, customerId, SOUTH_STATUS[status], total)
    }
  })()

  return { north, south }
}

export type RecallDbs = ReturnType<typeof createFixtures>
