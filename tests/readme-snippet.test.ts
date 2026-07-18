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
import { defineAction, defineLink, defineObject, defineOntology, modify, reject } from '../src/core.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const file of ['README.md', 'README.ja.md']) {
  test(`the showcase snippet in ${file} constructs without throwing`, () => {
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
  })
}
