/** Test isolation: build the legacy fixtures in a unique temp directory. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixtures as base, type LegacyDbs } from '../../examples/orders/fixtures.js'

export function createFixtures(): LegacyDbs {
  return base(mkdtempSync(join(tmpdir(), 'oo-fixtures-')))
}
