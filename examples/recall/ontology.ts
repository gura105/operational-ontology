import { z } from 'zod'
import {
  create, defineAction, defineLink, defineObject, defineOntology, link, reject,
  type Runtime,
} from '../../src/core.js'

const objects = {
  Customer: defineObject({
    primaryKey: 'id', source: 'north.tbl_cust ∪ south.CUSTOMER_MASTER',
    properties: { id: z.string(), name: z.string(), region: z.string() },
  }),
  Order: defineObject({
    primaryKey: 'id', source: 'north.tbl_order ∪ south.SALES_ORDER',
    properties: {
      id: z.string(), status: z.enum(['pending', 'shipped', 'cancelled']), total: z.number().int(),
      sourceSystem: z.enum(['north', 'south']), sourceId: z.string(),
    },
  }),
  Product: defineObject({
    primaryKey: 'id', source: 'south.ITEM_MASTER',
    properties: { id: z.string(), name: z.string(), stock: z.number() },
  }),
  RecallTicket: defineObject({
    primaryKey: 'id', source: 'support.tickets',
    properties: {
      id: z.string(), productId: z.string(), note: z.string(),
      recordedOn: z.string() /* YYYY-MM-DD */, author: z.string(),
    },
  }),
}

const schema = defineOntology({
  name: 'recall', objects,
  links: {
    customerOrders: defineLink({
      from: 'Customer', to: 'Order', kind: 'one-to-many',
      via: 'foreign key (north.tbl_order.cust_cd ∪ south.SALES_ORDER.CUST_ID)',
    }),
    orderProducts: defineLink({
      from: 'Order', to: 'Product', kind: 'many-to-many',
      via: 'join tables (north.tbl_order_line ∪ south.ORDER_LINE)',
    }),
    customerRecallTickets: defineLink({
      from: 'Customer', to: 'RecallTicket', kind: 'one-to-many', via: 'support.tickets.customer_id',
    }),
  },
  actions: {},
})

type RecallRead = Pick<Runtime<typeof schema>, 'get' | 'traverse' | 'filter' | 'intersect'>

/**
 * Rules need current related objects. Inject only the read methods here;
 * the getter is called after runtime construction (see runtime.ts).
 * Every rule passes its caller's actor to these reads.
 */
export function createRecallOntology(read: () => RecallRead) {
  return defineOntology({
    ...schema,
    actions: {
      createRecallTicket: defineAction(objects, {
        description: 'Create an exchange-contact ticket in the support system for a customer with shipped orders containing the recalled product. Refuses a second ticket for the same customer and product. Does not send a message or record contact completion.',
        object: 'Customer', targetParam: 'customerId',
        params: {
          ticketId: z.string().min(1), customerId: z.string(), productId: z.string(),
          note: z.string().min(1),
          recordedOn: z.iso.date(), author: z.string().min(1),
        },
        preconditions: [
          ({ params, actor }) => {
            const product = read().get('Product', params.productId, { actor })
            if (!product) return reject('UNKNOWN_PRODUCT', `product ${params.productId} does not exist`)
          },
          ({ object, params, actor }) => {
            const customerTickets = read().traverse(object, 'customerRecallTickets', { actor })
            const matching = read().filter(customerTickets, (ticket) => ticket.properties.productId === params.productId)
            if (matching.objects.length > 0) {
              return reject('RECALL_TICKET_ALREADY_EXISTS', `customer ${object.pk} already has a recall ticket for ${params.productId}`)
            }
          },
          ({ object, params, actor }) => {
            const product = read().get('Product', params.productId, { actor })!
            const customerOrders = read().traverse(object, 'customerOrders', { actor })
            const shipped = read().filter(customerOrders, (order) => order.properties.status === 'shipped')
            const productOrders = read().traverse(product, 'orderProducts', { actor })
            if (read().intersect(shipped, productOrders).objects.length === 0) {
              return reject('NO_SHIPPED_ORDER', `customer ${object.pk} has no shipped order containing ${params.productId}`)
            }
          },
        ],
        effects: ({ object, params }) => [
          create('RecallTicket', params.ticketId, {
            id: params.ticketId, productId: params.productId,
            note: params.note, recordedOn: params.recordedOn, author: params.author,
          }),
          link('customerRecallTickets', object.pk, params.ticketId),
        ],
        writeback: true,
      }),
    },
  })
}

export type Recall = ReturnType<typeof createRecallOntology>
