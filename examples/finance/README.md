**English** | [日本語](./README.ja.md)

# Finance: find shared recipients and retain the evidence

Run `pnpm demo:finance`. All accounts and transfers are fictional, and each run resets them.

On the morning of September 8, a financial institution's transaction monitoring team notices an unusually high number of deposits arriving in business accounts A, B and C over a short period and asks an investigator to review them. The deposit count alone does not explain the activity. The investigator examines that afternoon's outgoing transfers to ask: **Do all three accounts send to a common recipient, and what business transactions explain those payments?**

The demo compares recipients, narrows down the accounts and transfers to examine, and creates an investigation case for checking invoices and payment purposes. The morning deposit report is a premise of the story; the implementation does not include those deposit records or an anomaly detector.

**[▶ Ontology: Investigative Analysis Explained | Finance (English narration, 6:36)](https://www.youtube.com/watch?v=4urBRngmnuA)**

<a href="https://www.youtube.com/watch?v=4urBRngmnuA">
  <img src="https://i.ytimg.com/vi/4urBRngmnuA/maxresdefault.jpg" alt="Ontology: Investigative Analysis Explained | Finance" width="640">
</a>

<img src="./assets/ontology-overview.png" alt="Finance ontology: Account has separate outgoing and incoming links to Transfer. recipientSummary computes scoped recipient metrics and evidence. openInvestigation records an ontology-owned Investigation linked to the target account, origin accounts and evidence transfers.">

Gray: source-backed state. Orange: ontology-owned state. The diagram shows all object and link types, with selected properties. [Editable SVG](./assets/ontology-overview.svg).

`outgoing` and `incoming` are separate Account → Transfer links. Transfer is an object with an ID, timestamp and integer yen amount, so repeated transfers and their timing survive until the investigator chooses to pivot to accounts.

The demo follows outgoing transfers from each origin, filters September 8 afternoon, and pivots to recipients:

| Origin | Recipients |
| --- | --- |
| A | X, Y, W |
| B | X, W |
| C | X, Z |

Intersecting all three sets yields X. X was not specified as a target at the start: comparing A, B and C's recipients reveals it as the one shared by all three. A model Function, `recipientSummary`, provides the complementary aggregate route:

| Recipient | Distinct senders | Transfers | Total yen |
| --- | --- | --- | --- |
| X | 3 | 4 | 5,100,000 |
| Y | 1 | 1 | 100,000 |
| Z | 1 | 1 | 200,000 |
| W | 2 | 2 | 110,000 |

A's 1,700,000 yen to X is split into two transfers. This makes transaction count and sender count visibly different. Additional records before the time window and from D must not inflate the totals. The model uses a half-open interval: `after <= occurredAt < before`.

```ts
const summary = rt.run('recipientSummary', {
  originIds: ['A', 'B', 'C'],
  after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00',
}, { actor })
const selected = rt.filter(summary.aggregation, [{ property: 'senderCount', op: 'gte', value: 2 }])
// selected.set contains Accounts X and W; values retain their metrics.
```

The Function returns an account aggregation, per-account evidence transfer/sender sets, and the input scope. Aggregation row `pks` identify recipient accounts. Evidence is kept separately at transfer grain. The caller can inspect the selected account's original records without confusing a deduplicated account count with an amount or a transaction count.

Filtering for at least two senders retains X and W, but the investigator chooses to examine X, the recipient shared by all three origins. X received four transfers totalling 5,100,000 yen. Its registered context suggests it could be a shared payment provider: the three businesses may simply use the same payment service.

The investigator uses `openInvestigation` to create `CASE-X`, linking recipient X, origins A, B and C, and evidence transfers T1a, T1b, T3 and T4. The case records the time window and a reason: request invoices and payment purposes for the shared recipient. The investigator's next task is to obtain the documents corresponding to these four transfers and decide whether they explain the payments to the provider or warrant further investigation. Links back to the original transfers make it clear which payments need checking when the work is handed over.

The Action checks that every selected transfer still comes from the supplied origins, falls in the time window and reaches the selected recipient. It creates an ontology-owned case and links; a preview writes nothing. Source refresh preserves the case and links, but does not freeze source record contents as historical evidence snapshots.

## Scope and code

Shared recipients identify leads, not wrongdoing. The ordering of deposits and withdrawals does not uniquely establish that the same funds moved. Requesting documents, obtaining them and reviewing responses are outside the demo. No account is frozen, no source financial state is changed, and there is no multi-hop funds attribution, automated fraud score or causal inference.

Start with [`demo.ts`](./demo.ts), then [`ontology.ts`](./ontology.ts) for the summary Function and Action. `fixtures.ts` supplies ledger records, `integrate.ts` turns reference fields into links, and `runtime.ts` wires typed reads. The example assumes one writer and visibility of all relevant facts.

Run `pnpm mcp:finance`, or connect from the repository root:

```sh
claude --strict-mcp-config --mcp-config examples/finance/.mcp.json
```

Agents can combine generated filter/pivot/set tools with `recipient_summary`, pass its `aggregation` to `filter_account`, and then invoke `open_investigation` with the selected evidence. The Action checks evidence independently of caller-supplied metrics. See [IMPLEMENTATION.md](../../IMPLEMENTATION.md) for the common contracts.
