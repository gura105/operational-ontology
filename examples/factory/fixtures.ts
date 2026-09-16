/** Two synthetic source systems. In-memory databases keep each run isolated. */
import Database from 'better-sqlite3'

export function createFixtures() {
  const mes = new Database(':memory:')
  mes.exec(`
    CREATE TABLE equipment (id TEXT PRIMARY KEY,
      inspection TEXT DEFAULT 'clear', inspected_at TEXT DEFAULT '2026-09-08T09:00:00+09:00');
    CREATE TABLE product (id TEXT PRIMARY KEY, name TEXT, past_pressure_issue INTEGER);
    CREATE TABLE lot (id TEXT PRIMARY KEY, product_id TEXT, units INTEGER, manufactured_at TEXT,
      release_inspection TEXT DEFAULT 'passed');
    CREATE TABLE production (equipment_id TEXT, lot_id TEXT, PRIMARY KEY (equipment_id, lot_id));
    INSERT INTO equipment (id) VALUES ('PRESS-1'), ('PRESS-3'), ('OVEN-1');
    UPDATE equipment SET inspection = 'pressure-anomaly' WHERE id = 'PRESS-1';
    -- Catalog history concerns earlier lots of the same, unchanged product specification.
    INSERT INTO product VALUES ('P-A', 'Bracket A', 1), ('P-B', 'Bracket B', 0);
    -- Release inspections passed; the later equipment finding makes these lots suspect, not proven defective.
    INSERT INTO lot (id, product_id, units, manufactured_at) VALUES
      ('L1', 'P-A', 40, '2026-09-06T09:00:00+09:00'),
      ('L2', 'P-A', 30, '2026-09-05T14:00:00+09:00'),
      ('L3', 'P-B', 20, '2026-09-06T11:00:00+09:00'),
      ('L4', 'P-A', 50, '2026-09-06T09:00:00+09:00');
    -- A lot can visit several machines. These are historical production links.
    INSERT INTO production VALUES
      ('PRESS-1', 'L1'), ('OVEN-1', 'L1'),
      ('PRESS-1', 'L2'), ('PRESS-1', 'L3'), ('PRESS-3', 'L4');
  `)
  const wms = new Database(':memory:')
  wms.exec(`
    CREATE TABLE customer (id TEXT PRIMARY KEY, name TEXT, region TEXT);
    CREATE TABLE shipment (id TEXT PRIMARY KEY, customer_id TEXT, status TEXT, shipped_at TEXT);
    CREATE TABLE shipment_line (id TEXT PRIMARY KEY, shipment_id TEXT, lot_id TEXT, units INTEGER);
    INSERT INTO customer VALUES
      ('C1', 'Aoba', 'east'), ('C2', 'Koyo', 'west'), ('C3', 'Mori', 'east');
    INSERT INTO shipment VALUES
      ('S1', 'C1', 'shipped', '2026-09-07T10:00:00+09:00'), ('S2', 'C1', 'shipped', '2026-09-07T11:00:00+09:00'),
      ('S3', 'C2', 'shipped', '2026-09-07T12:00:00+09:00'), ('S4', 'C3', 'pending', NULL);
    INSERT INTO shipment_line VALUES
      ('SL1', 'S1', 'L1', 10), ('SL2', 'S3', 'L2', 15),
      ('SL3', 'S2', 'L1', 20), ('SL4', 'S2', 'L3', 20),
      -- L1 also has unshipped units; L4 shares a shipment but is outside the affected lots.
      ('SL5', 'S4', 'L1', 10), ('SL6', 'S1', 'L4', 5);
  `)
  return { mes, wms }
}

export type FactoryDbs = ReturnType<typeof createFixtures>
