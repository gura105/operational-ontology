/**
 * The physical layer: two legacy order systems left over from an acquisition.
 * Different schemas, different naming conventions, different status encodings.
 * This data exists BEFORE the ontology — that is the whole premise.
 *
 *   north — the acquired company's homegrown system (cryptic Japanese-era
 *           column names, integer status codes)
 *   south — the parent company's ERP (SHOUTING_CASE, text statuses,
 *           also owns the item master)
 */
import Database from 'better-sqlite3'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '.data')

export interface LegacyDbs {
  north: Database.Database
  south: Database.Database
}

/** (Re)create both legacy databases with deterministic seed data. */
export function createFixtures(dir: string = DATA_DIR): LegacyDbs {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const north = new Database(join(dir, 'legacy_north.db'))
  north.exec(`
    CREATE TABLE tbl_cust (cust_cd TEXT PRIMARY KEY, cust_nm TEXT, pref_nm TEXT);
    CREATE TABLE tbl_order (order_no TEXT PRIMARY KEY, cust_cd TEXT, stat INTEGER, amt INTEGER);
    -- stat: 0 = open, 1 = shipped, 2 = cancelled
    CREATE TABLE tbl_order_line (order_no TEXT, item_cd TEXT, qty INTEGER);
  `)
  north.exec(`
    INSERT INTO tbl_cust VALUES
      ('C01', 'Yamada Trading', 'Tokyo'),
      ('C02', 'Suzuki Industries', 'Osaka');
    INSERT INTO tbl_order VALUES
      ('A-1001', 'C01', 1, 12000),
      ('A-1002', 'C01', 0, 3000),
      ('A-1003', 'C02', 0, 8000);
    INSERT INTO tbl_order_line VALUES
      ('A-1001', 'ITM-100', 2),
      ('A-1001', 'ITM-101', 1),
      ('A-1002', 'ITM-101', 3),
      ('A-1003', 'ITM-102', 1);
  `)

  const south = new Database(join(dir, 'legacy_south.db'))
  south.exec(`
    CREATE TABLE CUSTOMER_MASTER (CUST_ID TEXT PRIMARY KEY, CUST_NAME TEXT, REGION TEXT);
    CREATE TABLE SALES_ORDER (ORDER_ID TEXT PRIMARY KEY, CUST_ID TEXT, ORDER_STATUS TEXT, TOTAL_AMT INTEGER);
    -- ORDER_STATUS: 'OPEN' | 'SHIPPED' | 'CANCELLED'
    CREATE TABLE ORDER_LINE (ORDER_ID TEXT, ITEM_ID TEXT, QTY INTEGER);
    CREATE TABLE ITEM_MASTER (ITEM_ID TEXT PRIMARY KEY, ITEM_NAME TEXT, STOCK_QTY INTEGER);
  `)
  south.exec(`
    INSERT INTO CUSTOMER_MASTER VALUES
      ('9001', 'Sato Logistics', 'Tokyo'),
      ('9002', 'Tanaka Foods', 'Fukuoka');
    INSERT INTO SALES_ORDER VALUES
      ('SO-77', '9001', 'OPEN',    15000),
      ('SO-78', '9001', 'SHIPPED',  4000),
      ('SO-79', '9002', 'OPEN',     6000);
    INSERT INTO ORDER_LINE VALUES
      ('SO-77', 'ITM-100', 1),
      ('SO-77', 'ITM-102', 2),
      ('SO-78', 'ITM-101', 1),
      ('SO-79', 'ITM-100', 1);
    INSERT INTO ITEM_MASTER VALUES
      ('ITM-100', 'Monitor 27"', 30),
      ('ITM-101', 'Keyboard',    12),
      ('ITM-102', 'Mouse',       55);
  `)

  return { north, south }
}
