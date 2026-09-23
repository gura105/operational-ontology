import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { createRecallOntology, type Recall } from './ontology.js'
import { createSupportAdapter } from './support-adapter.js'

export function createRecall() {
  const sources = createFixtures()
  const store = new Database(':memory:')
  // Rules read through this getter after rt has been assigned.
  let rt: Runtime<Recall>
  const ontology = createRecallOntology(() => rt)
  rt = createRuntime(ontology, store, { writeback: createSupportAdapter(sources.support) })
  rt.load(integrate(sources))
  return {
    rt, sources,
    close() { store.close(); sources.north.close(); sources.south.close(); sources.support.close() },
  }
}
