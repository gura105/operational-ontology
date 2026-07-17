/**
 * Expose the orders ontology to AI agents over MCP (stdio). Run with: pnpm mcp
 *
 * Claude Code config example (.mcp.json):
 *   { "mcpServers": { "orders": { "command": "pnpm", "args": ["mcp"] } } }
 *
 * Then ask the agent to "cancel every order of Yamada Trading" and watch the
 * shipped one get refused with a machine-readable error the agent can explain.
 *
 * Over stdio all callers collapse to a single identity; set OO_AGENT to name
 * the agent this server instance serves (actor becomes `agent:<name>`).
 */
import Database from 'better-sqlite3'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createRuntime, type Runtime } from '../../src/core.js'
import { buildMcpServer } from '../../src/mcp.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { orders } from './ontology.js'
import { createErpAdapter } from './erp-adapter.js'

const legacy = createFixtures()
let rt: Runtime
const adapter = createErpAdapter(legacy, (pk) => rt.get('Order', pk, { actor: 'system:writeback' }))
rt = createRuntime(orders, new Database(':memory:'), { writeback: adapter })
rt.load(integrate(legacy))

await buildMcpServer(rt, { agent: process.env.OO_AGENT }).connect(new StdioServerTransport())
console.error('operational-ontology: orders ontology served over stdio')
