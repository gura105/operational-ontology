**English** | [日本語](./README.ja.md)

# Recall: from a defective product to contact tasks

Run `pnpm demo:recall` from the repository root. The demo uses synthetic north and south order databases and an in-memory ontology store; each run starts fresh.

On September 10, 2026, the manufacturer reports that keyboard ITM-101 has a defective key switch; affected units need to be exchanged. This example takes the customer-support (CS) view only. Stopping sales belongs to storefront administration, holding unshipped orders belongs to the warehouse, and contacting customers with shipped orders belongs to CS; this example covers task creation for the last responsibility. Three customers phoned CS on September 9, and a recall task was recorded for each.

The model reuses the orders example's Customer, Order and Product, with the unused `assignee` property and `visibility` function omitted. It adds the ontology-owned RecallTask and three ontology-owned links: `customerRecallTasks`, `productRecallTasks` and `recallTaskOrders`.

| Step | Result |
| --- | --- |
| Find orders containing keyboard ITM-101 | 48 of 300 orders |
| Filter by fulfilment status | 31 shipped (14 pending, 3 cancelled) |
| Pivot shipped orders to customers | 27 customers |
| Execute `createRecallTask` once per customer | 24 applied, 3 refused with `RECALL_TASK_ALREADY_EXISTS` |
| Verify recall tasks | 27/27 customers have a task |
| Read the audit log | 30 entries |

The `createRecallTask` Action checks the current indexed state: that the product exists (`UNKNOWN_PRODUCT`), that the customer does not already have a task for the product (`RECALL_TASK_ALREADY_EXISTS`), and that every supplied order is distinct, shipped to that customer and contains the product (`INVALID_EVIDENCE`). It creates the task and its evidence links atomically, but sends no message and does not change orders or stock. Re-indexing source data preserves the ontology-owned tasks and links.

A task records planned follow-up, not completed contact or exchange. It is stored in the ontology; this example does not register tasks in an external CRM. Evidence links retain the selected record identities, and the audit log records Action attempts. They do not preserve source record snapshots, exploration history or the reasons other customers were excluded.

> This demo calls the action once per customer, 27 times. As a minimal reference implementation it favors one invocation per audit entry. In production, a bulk action that validates every target before applying any, or that stops at the first refusal, is often the more realistic design. Either way the properties stay the same: refusals are named, and every attempt is recorded.

## Code and MCP

Start with [`demo.ts`](./demo.ts), then the Action and its rules in [`ontology.ts`](./ontology.ts). `fixtures.ts` creates the two synthetic legacy databases, `integrate.ts` normalizes their rows and links, and `runtime.ts` connects model reads to the runtime. `runtime.ts` also seeds yesterday's tasks through the Action because ontology-owned objects cannot come from a snapshot. Source write-back is covered in [orders](../orders/ontology.ts), set-intersection evidence in [factory](../factory/README.md), candidate Functions in [hospital](../hospital/README.md), and shared recipients in [finance](../finance/README.md).

Run `pnpm mcp:recall`, or connect from the repository root with:

```sh
claude --strict-mcp-config --mcp-config examples/recall/.mcp.json
```

The server generates tools including `get_product`, `traverse_order_products`, `pivot_customer_orders`, `create_recall_task` and `read_audit_log`. Agents filter returned objects in their own code execution environment and pass selected IDs to the next tool. The MCP test in `scenario.test.ts` follows the same exploration, applies one task and checks a refusal for a duplicate task. Runtime contracts are in [IMPLEMENTATION.md](../../docs/IMPLEMENTATION.md). This example assumes one writer and visibility of all resources relevant to a decision.
