export {
  defineObject,
  defineLink,
  defineAction,
  defineOntology,
  createRuntime,
  Runtime,
  reject,
  modify,
  create,
  remove,
} from './core.js'
export type {
  ObjectTypeDef,
  LinkTypeDef,
  ActionDef,
  ActionCtx,
  OntologyDef,
  Violation,
  Edit,
  ActionResult,
  AuditEntry,
  WritebackAdapter,
} from './core.js'
export { buildMcpServer } from './mcp.js'
