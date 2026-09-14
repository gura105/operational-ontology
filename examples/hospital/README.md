**English** | [日本語](./README.ja.md)

# Hospital: explore facts, evaluate candidates, record a provisional allocation

Run `pnpm demo:hospital`. The source records are synthetic and all state resets on each run. Equipment K and staffing slots are fictional teaching rules, not medical decision criteria.

The admission planner follows Hospital H to waiting patients, then their admission confirmations. Filtering approved confirmations and pivoting back yields P1 and P4, not every patient. P2 is still awaiting confirmation; P3 is already admitted. Every waiting patient has complete input requirements. P4 is an additional confirmed patient so resource consumption can be observed separately from P1's own allocation status.

**[▶ Ontology: Investigative Analysis Explained | Hospital (English narration, 5:48)](https://www.youtube.com/watch?v=cXEIbE-2abs)**

[![Ontology: Investigative Analysis Explained | Hospital](https://i.ytimg.com/vi/cXEIbE-2abs/mqdefault.jpg)](https://www.youtube.com/watch?v=cXEIbE-2abs)

<img src="./assets/ontology-overview.png" alt="Hospital ontology: Hospital links to Patient, Bed and Nurse; Patient links to Admission. bedSearch and nurseSearch evaluate candidates. allocate rechecks the selection and creates an ontology-owned Allocation with patient, bed and nurse links.">

Gray: source-backed state. Orange: ontology-owned state. The diagram shows all object and link types, with selected properties. [Editable SVG](./assets/ontology-overview.svg).

The orange allocation links are absent initially. They are created by the allocation Action, not by candidate search.

For P1, `bedSearch` returns a Bed ObjectSet plus assessments of all beds in the same hospital:

| Bed | Assessment |
| --- | --- |
| B101 | Eligible: ready, equipment K, area A, no reservation. |
| B102 | Cleaning. |
| B103 | Missing equipment K. |
| B104 | Already reserved at the source. |

After selecting B101, `nurseSearch` returns N1. N2 has no slot; N3 is on the night shift. Both Functions return `{ set, assessments }`; each assessment includes the object and all applicable `{ code, message }` reasons. Selection and Function calls do not create links, reserve resources or write audit entries.

```ts
const beds = rt.run('bedSearch', { patientId: 'P1' }, { actor })
const bed = beds.set.objects[0]
const nurses = rt.run('nurseSearch', { patientId: 'P1', bedId: bed.pk }, { actor })
```

The model shares its patient, bed and nurse evaluation functions with `allocate`. A complete Action can be previewed, then executed. It rechecks the selected combination and commits one ontology-owned Allocation plus its three links atomically. Patient/bed/nurse references are represented by those links, not duplicated in foreign-key properties.

The source patient remains `waiting`, the bed remains source-ready, and N1's source slot count remains 1. The stored plan is additional operational state. Candidate evaluation combines source reservations/readiness with existing plans: a planned bed is unavailable, and each plan consumes a nurse slot. Re-running `bedSearch` returns no bed for P1 because it has a plan, and no bed for P4 because the resource has been consumed. P1 and P4 can each pass preview for the same resources before either plan is applied. Once P1 is allocated, running the previously previewed plan for P4 is refused. A previously obtained candidate or preview is not a reservation. Source refresh preserves the plan and its links.

## Scope and code

Start with [`demo.ts`](./demo.ts), then [`ontology.ts`](./ontology.ts). `fixtures.ts` and `integrate.ts` model source facts; `runtime.ts` connects the model's typed reads without adding methods to Action contexts.

This is one fixed September 8 day-shift planning window, with one writer and all relevant resources visible. There is no multi-patient optimizer, schedule overlap calculation, plan cancellation, source admission write-back or reconciliation after a source accepts a plan. Revalidation uses the currently indexed snapshot, not a live hospital query. Real admission remains a separate source-system workflow.

Run `pnpm mcp:hospital`, or connect from the repository root:

```sh
claude --strict-mcp-config --mcp-config examples/hospital/.mcp.json
```

The model supplies `bed_search`, `nurse_search` and `allocate` alongside generated exploration tools. The caller supplies patient/bed choices; it does not implement eligibility rules. See [IMPLEMENTATION.md](../../IMPLEMENTATION.md) for the shared API and failure contracts.
