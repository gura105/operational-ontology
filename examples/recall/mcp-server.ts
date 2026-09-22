/** Run from the repository root: pnpm mcp:recall. Each start resets the synthetic data. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildMcpServer } from '../../src/mcp.js'
import { createRecall } from './runtime.js'

const { rt } = createRecall()
await buildMcpServer(rt, { agent: process.env.OO_AGENT }).connect(new StdioServerTransport())
console.error('operational-ontology: recall ontology served over stdio')
