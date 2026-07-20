/**
 * operational-ontology · MCP surface
 *
 * Generates an MCP server from an ontology definition. Because the model is
 * data, the agent-facing tool surface is derived, not hand-written:
 *
 *   - per object type:  search_<object>, get_<object>, aggregate_<object>
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
  const server = new McpServer({ name: `operational-ontology:${rt.ontology.name}`, version: '0.2.0' })
  // Tool names are derived from model names, so two model names can collide
  // after snake-casing (object `Order` ⇒ search_order, action `searchOrder`
  // ⇒ search_order). Fail at build time with both origins named.
  const claimed = new Map<string, string>()
  const toolName = (name: string, origin: string): string => {
    const holder = claimed.get(name)
    if (holder !== undefined) {
      throw new Error(`MCP tool name collision: "${name}" is derived from both ${holder} and ${origin} — rename one`)
    }
    claimed.set(name, origin)
    return name
  }
  // Over stdio there is no session id, so every caller collapses to one
  // identity — pass opts.agent to name the agent this server serves.
  const actorOf = (extra?: { sessionId?: string }) => `agent:${extra?.sessionId ?? opts.agent ?? 'mcp'}`
  const asJson = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  })
  // Every handler — reads included — surfaces crashes in the same
  // machine-readable shape as refusals. No stack dumps in an agent's context.
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R | (ReturnType<typeof asJson> & { isError: true })> => {
      try {
        return await fn(...args)
      } catch (e) {
        return {
          ...asJson({ error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
          isError: true as const,
        }
      }
    }
  // A wrapped numeric (optional / nullable / defaulted) is still numeric.
  const innerType = (schema: z.ZodType): z.ZodType => {
    let s: unknown = schema
    for (;;) {
      const candidate = s as { unwrap?: () => unknown; def?: { innerType?: unknown } }
      if (typeof candidate.unwrap === 'function') {
        s = candidate.unwrap()
        continue
      }
      if (candidate.def?.innerType) {
        s = candidate.def.innerType
        continue
      }
      return s as z.ZodType
    }
  }

  for (const [typeName, def] of Object.entries(rt.ontology.objects)) {
    const filterShape = Object.fromEntries(
      Object.entries(def.properties).map(([key, schema]) => [key, (schema as z.ZodType).optional()]),
    )
    server.registerTool(
      toolName(`search_${snake(typeName)}`, `object type ${typeName}`),
      {
        description:
          `Search ${typeName} objects${def.description ? ` (${def.description})` : ''}. ` +
          'All filter fields are optional and match by equality. ' +
          'Results are scoped by the model-attached visibility policy for this session.',
        inputSchema: filterShape,
      },
      guarded(async (filter: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(rt.search(typeName, { actor: actorOf(extra), filter: prune(filter) }))),
    )
    server.registerTool(
      toolName(`get_${snake(typeName)}`, `object type ${typeName}`),
      {
        description: `Fetch a single ${typeName} by primary key (${def.primaryKey}).`,
        inputSchema: { [def.primaryKey]: z.string() },
      },
      guarded(async (args: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(rt.get(typeName, String(args[def.primaryKey]), { actor: actorOf(extra) }) ?? null)),
    )
    // Aggregate inputs are model-derived too: property names come from the
    // definition, and only numeric properties are summable.
    const propertyKeys = Object.keys(def.properties) as [string, ...string[]]
    const numericKeys = Object.entries(def.properties)
      .filter(([, schema]) => innerType(schema as z.ZodType) instanceof z.ZodNumber)
      .map(([key]) => key)
    const aggregateShape: Record<string, z.ZodType> = {
      group_by: z.enum(propertyKeys),
      filter: z.object(filterShape).optional(),
    }
    if (numericKeys.length > 0) aggregateShape.sum = z.enum(numericKeys as [string, ...string[]]).optional()
    server.registerTool(
      toolName(`aggregate_${snake(typeName)}`, `object type ${typeName}`),
      {
        description:
          `Group ${typeName} objects by a property, counting each group and optionally summing ` +
          'a numeric property. Query-time aggregation — nothing is precomputed.',
        inputSchema: aggregateShape,
      },
      guarded(async (rawArgs: Record<string, unknown>, extra: { sessionId?: string }) => {
        const args = rawArgs as { group_by: string; sum?: string; filter?: Record<string, unknown> }
        return asJson(
          rt.aggregate(typeName, {
            actor: actorOf(extra),
            filter: args.filter ? prune(args.filter) : undefined,
            groupBy: (o: Record<string, unknown>) => String(o[args.group_by]),
            ...(args.sum ? { sum: (o: Record<string, unknown>) => Number(o[args.sum!] ?? 0) } : {}),
          }),
        )
      }),
    )
  }

  for (const [linkName, link] of Object.entries(rt.ontology.links)) {
    server.registerTool(
      toolName(`traverse_${snake(linkName)}`, `link type ${linkName}`),
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
      guarded(async (args: { pk: string; direction: 'forward' | 'reverse' }, extra: { sessionId?: string }) =>
        asJson(rt.traverse(linkName, args.pk, { actor: actorOf(extra), direction: args.direction }))),
    )
  }

  for (const [actionName, action] of Object.entries(rt.ontology.actions)) {
    server.registerTool(
      toolName(snake(actionName), `action ${actionName}`),
      {
        description:
          `${action.description ?? `Action on ${action.object}.`} ` +
          'Writes are gated: if a business rule rejects this call, the error is ' +
          'machine-readable ({ code, message }) and the attempt is recorded in the audit log.',
        inputSchema: action.params,
      },
      guarded(async (params: Record<string, unknown>, extra: { sessionId?: string }) => {
        const result = rt.execute(actionName, params, { actor: actorOf(extra) })
        if (!result.ok) {
          return { ...asJson({ error: result.error }), isError: true }
        }
        return asJson({ applied: result.edits })
      }),
    )
  }

  server.registerTool(
    toolName('read_audit_log', 'the built-in audit view'),
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
    guarded(async (filter: Record<string, unknown>) =>
      asJson(rt.auditLog(prune(filter) as Parameters<typeof rt.auditLog>[0]))),
  )

  return server
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const prune = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
