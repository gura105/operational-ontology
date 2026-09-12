/**
 * Doc-test: the showcase snippet in the README must actually construct.
 * A document that brags "the definition is validated data" cannot afford a
 * hero example that fails its own validation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { createRuntime, defineAction, defineLink, defineObject, defineOntology, modify, reject } from '../src/core.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const file of ['README.md', 'README.ja.md']) {
  test(`the showcase snippet in ${file} constructs and enforces its rule`, () => {
    const markdown = readFileSync(join(root, file), 'utf8')
    const match = markdown.match(/```ts\n([\s\S]*?)```/)
    assert.ok(match, `no \`\`\`ts code block found in ${file}`)
    const build = new Function(
      'z',
      'defineOntology',
      'defineObject',
      'defineLink',
      'defineAction',
      'reject',
      'modify',
      `"use strict";\n${match![1]}\nreturn ontology`,
    )
    const ontology = build(z, defineOntology, defineObject, defineLink, defineAction, reject, modify)
    assert.equal(ontology.name, 'orders')
    assert.ok('cancelOrder' in ontology.actions)
    // Money stays in integer minor units — a float regression must fail here.
    const total = (ontology.objects.Order.properties as Record<string, z.ZodType>).total
    assert.equal(total.safeParse(0.5).success, false, 'money must be integer minor units')
    const rt = createRuntime(ontology, new Database(':memory:'), { writeback: { apply: () => {} } })
    const actor = { actor: 'user:test' }
    rt.load({ objects: { Order: [
      { id: 'O1', status: 'pending', total: 100 },
      { id: 'O2', status: 'shipped', total: 200 },
    ] } })
    assert.equal(rt.execute('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor).ok, true)
    assert.equal(rt.get('Order', 'O1', actor)!.properties.status, 'cancelled')
    assert.equal(rt.execute('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, actor).ok, false)
  })
}
