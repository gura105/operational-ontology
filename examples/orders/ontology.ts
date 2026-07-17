/**
 * The ontology: the business, modeled once, on top of data that already
 * exists. Objects are nouns, links are relationships, actions are the verbs —
 * with the business rules attached to the verbs.
 */
import { z } from 'zod'
import { defineAction, defineLink, defineObject, defineOntology, modify, reject } from '../../src/core.js'

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
        customerId: z.string(),
        status: z.enum(['pending', 'assigned', 'shipped', 'cancelled']),
        total: z.number(),
        assignee: z.string().nullable(),
        // Which system of record this order lives in — write-back routes on this.
        sourceSystem: z.enum(['north', 'south']),
        sourceId: z.string(),
      },
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
  },

  links: {
    customerOrders: defineLink({
      from: 'Customer',
      to: 'Order',
      kind: 'one-to-many',
      via: 'foreign key (orders.customerId)',
    }),
    orderProducts: defineLink({
      from: 'Order',
      to: 'Product',
      kind: 'many-to-many',
      via: 'join tables (north.tbl_order_line ∪ south.ORDER_LINE)',
    }),
  },

  actions: {
    /**
     * The verb this whole repository exists to demonstrate. The rule
     * "a shipped order cannot be cancelled" is a domain invariant — no
     * permission system can express it, and no caller can bypass it.
     * Cancellation is written back to the originating legacy system.
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
     * Assignment exists only in the ontology layer — neither legacy system
     * has an assignee column. Edits can live above the systems of record.
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
      effects: ({ object, params }) => [
        modify('Order', object.id as string, { status: 'assigned', assignee: params.assignee }),
      ],
    }),
  },
})
