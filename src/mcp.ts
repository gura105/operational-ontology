/**
 * operational-ontology · MCP surface
 *
 * Generates an MCP server from an ontology definition. Because the model is
 * data, the agent-facing tool surface is derived, not hand-written:
 *
 *   - per object type:  search_<object>, get_<object>
 *   - per link type:    traverse_<link> (forward and reverse)
 *   - per action:       <action>, guarded by the same preconditions as
 *                       every other caller
 *   - plus:             read_audit_log
 *
 * There is intentionally no raw SQL tool and no generic update tool.
 * The absence is the point: the operation space an agent gets is exactly
 * the operation space the model defines.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Runtime } from './core.js'

export function buildMcpServer(rt: Runtime, opts: { agent?: string } = {}): McpServer {
  const server = new McpServer({ name: `operational-ontology:${rt.ontology.name}`, version: '0.1.0' })
  // Over stdio there is no session id, so every caller collapses to one
  // identity — pass opts.agent to name the agent this server serves.
  const actorOf = (extra?: { sessionId?: string }) => `agent:${extra?.sessionId ?? opts.agent ?? 'mcp'}`
  const asJson = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  })

  for (const [typeName, def] of Object.entries(rt.ontology.objects)) {
    const filterShape = Object.fromEntries(
      Object.entries(def.properties).map(([key, schema]) => [key, (schema as z.ZodType).optional()]),
    )
    server.registerTool(
      `search_${snake(typeName)}`,
      {
        description:
          `Search ${typeName} objects${def.description ? ` (${def.description})` : ''}. ` +
          'All filter fields are optional and match by equality. ' +
          'Results are scoped by the model-attached visibility policy for this session.',
        inputSchema: filterShape,
      },
      async (filter: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(rt.search(typeName, { actor: actorOf(extra), filter: prune(filter) })),
    )
    server.registerTool(
      `get_${snake(typeName)}`,
      {
        description: `Fetch a single ${typeName} by primary key (${def.primaryKey}).`,
        inputSchema: { [def.primaryKey]: z.string() },
      },
      async (args: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(rt.get(typeName, String(args[def.primaryKey]), { actor: actorOf(extra) }) ?? null),
    )
    server.registerTool(
      `aggregate_${snake(typeName)}`,
      {
        description:
          `Group ${typeName} objects by a property, counting each group and optionally summing ` +
          'a numeric property. Query-time aggregation — nothing is precomputed.',
        inputSchema: {
          group_by: z.string(),
          sum: z.string().optional(),
          filter: z.record(z.string(), z.any()).optional(),
        },
      },
      async (
        args: { group_by: string; sum?: string; filter?: Record<string, unknown> },
        extra: { sessionId?: string },
      ) =>
        asJson(
          rt.aggregate(typeName, {
            actor: actorOf(extra),
            filter: args.filter ? prune(args.filter) : undefined,
            groupBy: (o: Record<string, unknown>) => String(o[args.group_by]),
            ...(args.sum ? { sum: (o: Record<string, unknown>) => Number(o[args.sum!] ?? 0) } : {}),
          }),
        ),
    )
  }

  for (const [linkName, link] of Object.entries(rt.ontology.links)) {
    server.registerTool(
      `traverse_${snake(linkName)}`,
      {
        description:
          `Traverse the ${link.from} → ${link.to} link "${linkName}" (${link.kind}). ` +
          `direction=forward: pass a ${link.from} pk, get linked ${link.to} objects. ` +
          `direction=reverse: pass a ${link.to} pk, get linked ${link.from} objects.`,
        inputSchema: {
          pk: z.string(),
          direction: z.enum(['forward', 'reverse']).default('forward'),
        },
      },
      async (args: { pk: string; direction: 'forward' | 'reverse' }, extra: { sessionId?: string }) =>
        asJson(rt.traverse(linkName, args.pk, { actor: actorOf(extra), direction: args.direction })),
    )
  }

  for (const [actionName, action] of Object.entries(rt.ontology.actions)) {
    server.registerTool(
      snake(actionName),
      {
        description:
          `${action.description ?? `Action on ${action.object}.`} ` +
          'Writes are gated: if a business rule rejects this call, the error is ' +
          'machine-readable ({ code, message }) and the attempt is recorded in the audit log.',
        inputSchema: action.params,
      },
      async (params: Record<string, unknown>, extra: { sessionId?: string }) => {
        const result = rt.execute(actionName, params, { actor: actorOf(extra) })
        if (!result.ok) {
          return { ...asJson({ error: result.error }), isError: true }
        }
        return asJson({ applied: result.edits })
      },
    )
  }

  server.registerTool(
    'read_audit_log',
    {
      description:
        'Read the append-only audit log: every applied and rejected action, with actor and params. ' +
        'This is an unscoped administrative view — entries are not filtered by visibility (fail-open, declared).',
      inputSchema: {
        action: z.string().optional(),
        status: z.enum(['applied', 'rejected']).optional(),
        target: z.string().optional(),
      },
    },
    async (filter) => asJson(rt.auditLog(prune(filter))),
  )

  return server
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const prune = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
