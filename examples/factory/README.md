**English** | [日本語](./README.ja.md)

# Factory: from an inspection finding to customer contact

Run `pnpm demo:factory` from the repository root. The demo uses synthetic MES and WMS databases and an in-memory ontology store; each run starts fresh.

On September 8, an equipment inspection identifies an anomaly on PRESS-1. Release inspections had passed, and shipments left on September 7. The investigation is given September 6 as its manufacturing window. It is looking for potentially affected products, not explaining why known defective goods were shipped or estimating when the fault began.

**[▶ Ontology: Investigative Analysis Explained | Factory (English narration, 6:02)](https://www.youtube.com/watch?v=kQFvOResIvI)**

<a href="https://www.youtube.com/watch?v=kQFvOResIvI">
  <img src="https://i.ytimg.com/vi/kQFvOResIvI/maxresdefault.jpg" alt="Ontology: Investigative Analysis Explained | Factory" width="640">
</a>

<img src="./assets/ontology-overview.png" alt="Factory ontology with Equipment, Lot, ShipmentLine, Shipment, Customer and ontology-owned ContactTask. customerImpact summarizes shipped-line evidence; createContactTask validates the selection and records the task and evidence links.">

Gray: source-backed state. Orange: ontology-owned state. The diagram shows all object and link types, with selected properties. [Editable SVG](./assets/ontology-overview.svg).

`demo.ts` uses the runtime's filter and pivot operations directly:

| Step | Result |
| --- | --- |
| Filter equipment by inspection anomaly | PRESS-1 |
| Pivot to production history | L1, L2, L3 |
| Filter the supplied manufacturing window | L1, L3 |
| Pivot to shipment lines | SL1, SL3, SL5, SL4 |
| Pivot to shipments and filter shipped status | S1, S2 |
| Pivot to customers | C1 (Aoba), once |

C1 is found because it received the selected lots. C2 is excluded because its L2 was made September 5. The remaining 10 units of L1 destined for C3 are excluded because they have not shipped. L1 appears in shipped S1 and S2; set membership deduplicates identities at every step.

The model's `customerImpact` Function retains only shipped lines from the selected lots and summarizes affected units per customer. When pivoting back from shipments to lines, it intersects with the original affected lines to exclude the unrelated L4 packed in S1. The remaining evidence is SL1, SL3 and SL4: C1 has 50 affected shipped units across two shipments. This is different from the 60 manufactured units in L1 and L3, which the demo also aggregates by product family. Quantity belongs to each shipment-line record, not to the deduplicated customer set.

The operator previews and runs `createContactTask`. The Action checks the equipment finding, manufacturing window, customer and shipped-line evidence, then atomically creates an ontology-owned task with links to the customer, equipment, lots and lines. It sends no message and does not attempt to hold goods already shipped. Re-indexing preserves the task and evidence links; those links identify source records rather than freezing their historical contents.

## Code and MCP

Start with [`demo.ts`](./demo.ts), then the rules and Functions in [`ontology.ts`](./ontology.ts). `fixtures.ts` and `integrate.ts` supply existing source facts, `runtime.ts` wires model reads to the runtime. Source write-back is covered in [orders](../orders/ontology.ts), candidates and allocation in [hospital](../hospital/README.md), and shared recipients in [finance](../finance/README.md). No separate array-based set helpers are needed.

Run `pnpm mcp:factory`, or connect from the repository root with:

```sh
claude --strict-mcp-config --mcp-config examples/factory/.mcp.json
```

The server generates filter/pivot/set/aggregate tools, model Functions and Actions from the same definition. For example, `customer_impact` returns its aggregation and evidence, and `create_contact_task` rechecks that evidence. Runtime contracts are in [IMPLEMENTATION.md](../../IMPLEMENTATION.md). This example assumes one writer and visibility of all resources relevant to a decision.
