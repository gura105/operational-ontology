/**
 * The ontology: the business, modeled once, on top of data that already
 * exists. Objects are nouns, links are relationships, actions are the verbs —
 * with the business rules attached to the verbs.
 */
import { z } from 'zod'
import { create, defineAction, defineLink, defineObject, defineOntology, link, modify, reject } from '../../src/core.js'

export const orders = defineOntology({
  name: 'orders',

  objects: {
    Customer: defineObject({
      description: 'A customer of the merged company',
      primaryKey: 'id',
      properties: {
        id: z.string(),
        name: z.string(),
        region: z.string(),
      },
      source: 'north.tbl_cust ∪ south.CUSTOMER_MASTER',
    }),

    Order: defineObject({
      description: 'A sales order, unified across both legacy systems',
      primaryKey: 'id',
      // Row-level visibility, attached to the model: a sales rep sees only
      // the orders of their own legacy system; hq, agents, and infrastructure
      // see everything. Types without a visibility slot are visible to all
      // (fail-open — declared in the README).
      visibility: ({ object, actor }) =>
        actor === `user:${String(object.sourceSystem)}-sales` ||
        actor === 'user:hq' ||
        actor.startsWith('agent:') ||
        actor.startsWith('system:'),
      properties: {
        id: z.string(),
        // Source-backed: both legacy systems master this value.
        status: z.enum(['pending', 'shipped', 'cancelled']),
        total: z.number().int(), // minor units — money is not a float
        assignee: z.string().nullable(),
        // Which system of record this order lives in — write-back routes on this.
        sourceSystem: z.enum(['north', 'south']),
        sourceId: z.string(),
      },
      // Authority, declared property by property: neither legacy system has
      // an assignee column, so the ontology owns it — it starts null, no
      // snapshot may supply it, and it survives re-indexing. Every other
      // property is source-backed: the snapshot speaks, write-back governs.
      owned: { assignee: null },
      source: 'north.tbl_order ∪ south.SALES_ORDER',
    }),

    Product: defineObject({
      description: 'An item from the ERP item master',
      primaryKey: 'id',
      properties: {
        id: z.string(),
        name: z.string(),
        stock: z.number(),
      },
      source: 'south.ITEM_MASTER',
    }),

    Note: defineObject({
      description: 'A triage note — state no source system has a table for',
      primaryKey: 'id',
      // The whole type is ontology-owned, existence included: no source
      // supplies notes, actions create them, and they survive re-indexing.
      owned: true,
      properties: {
        id: z.string(),
        text: z.string(),
        author: z.string(),
      },
    }),
  },

  links: {
    customerOrders: defineLink({
      from: 'Customer',
      to: 'Order',
      kind: 'one-to-many',
      // The foreign key lives in the legacy schemas; here the relationship
      // is represented once, as a link — not duplicated as a property.
      via: 'foreign key (north.tbl_order.cust_cd ∪ south.SALES_ORDER.CUST_ID)',
    }),
    orderProducts: defineLink({
      from: 'Order',
      to: 'Product',
      kind: 'many-to-many',
      via: 'join tables (north.tbl_order_line ∪ south.ORDER_LINE)',
    }),
    orderNotes: defineLink({
      from: 'Order',
      to: 'Note',
      kind: 'one-to-many',
      // Ontology-owned, like the notes themselves: no source supplies these
      // links, and they survive re-indexing.
      owned: true,
    }),
  },

  actions: {
    /**
     * The verb this whole repository exists to demonstrate. The rule
     * "a shipped order cannot be cancelled" is a domain invariant — no
     * permission system can express it, and every caller of the API meets
     * the same gate. Cancellation is written back to the originating legacy
     * system.
     */
    cancelOrder: defineAction({
      description: 'Cancel an order. Shipped orders cannot be cancelled.',
      object: 'Order',
      targetParam: 'orderId',
      params: {
        orderId: z.string(),
        reason: z.string().min(1),
      },
      preconditions: [
        ({ object }) =>
          object.status === 'shipped'
            ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.id} has already shipped`)
            : undefined,
        ({ object }) =>
          object.status === 'cancelled'
            ? reject('ORDER_ALREADY_CANCELLED', `order ${object.id} is already cancelled`)
            : undefined,
      ],
      effects: ({ object }) => [modify('Order', object.id as string, { status: 'cancelled' })],
      writeback: true,
    }),

    /**
     * A purely ontology-owned decision: neither legacy system has an assignee
     * column, so the ontology's own store is the system of record for it.
     * Note what this action does NOT touch — `status` is source-backed, and
     * assignment has no business changing it. Reassignment overwrites the
     * previous assignee; every attempt, either way, is on the audit log.
     */
    assignOrder: defineAction({
      description: 'Assign a pending order to a person for fulfilment.',
      object: 'Order',
      targetParam: 'orderId',
      params: {
        orderId: z.string(),
        assignee: z.string().min(1),
      },
      preconditions: [
        ({ object }) =>
          object.status !== 'pending'
            ? reject('ORDER_NOT_ASSIGNABLE', `order ${object.id} is ${object.status}, only pending orders can be assigned`)
            : undefined,
      ],
      effects: ({ object, params }) => [modify('Order', object.id as string, { assignee: params.assignee })],
    }),

    /**
     * Creates ontology-owned state and rewires the ontology-owned part of
     * the graph in one atomic plan: the note is created and linked to the
     * order under the same gate — the order must exist and be visible to the
     * actor, and the one-to-many cardinality of orderNotes is enforced.
     * Notes are ontology-owned, so no write-back; the caller supplies the id
     * (see "What if an agent retries?" in the README — an invocation-supplied
     * id is also the minimal idempotency hook).
     */
    addOrderNote: defineAction({
      description: 'File a triage note against an order.',
      object: 'Order',
      targetParam: 'orderId',
      params: {
        orderId: z.string(),
        noteId: z.string().min(1),
        text: z.string().min(1),
        author: z.string().min(1),
      },
      preconditions: [],
      effects: ({ object, params }) => [
        create('Note', params.noteId as string, {
          id: params.noteId,
          text: params.text,
          author: params.author,
        }),
        link('orderNotes', object.id as string, params.noteId as string),
      ],
    }),
  },
})
