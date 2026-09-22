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
  RecallTask: defineObject({
    primaryKey: 'id', owned: true,
    properties: {
      id: z.string(), note: z.string(), recordedOn: z.string() /* YYYY-MM-DD */, author: z.string(),
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
    customerRecallTasks: defineLink({ from: 'Customer', to: 'RecallTask', kind: 'one-to-many', owned: true }),
    productRecallTasks: defineLink({ from: 'Product', to: 'RecallTask', kind: 'one-to-many', owned: true }),
    recallTaskOrders: defineLink({ from: 'RecallTask', to: 'Order', kind: 'many-to-many', owned: true }),
  },
  actions: {},
})

type RecallRead = Pick<Runtime<typeof schema>, 'get' | 'traverse' | 'pivot' | 'filter' | 'intersect'>

/**
 * Rules need current related objects. Inject only the read methods here;
 * the getter is called after runtime construction (see runtime.ts).
 * Every rule passes its caller's actor to these reads.
 */
export function createRecallOntology(read: () => RecallRead) {
  return defineOntology({
    ...schema,
    actions: {
      createRecallTask: defineAction(objects, {
        description: 'Record an exchange-contact task for a customer who received the recalled product. Refuses a second task for the same customer and product. Sends no message.',
        object: 'Customer', targetParam: 'customerId',
        params: {
          taskId: z.string().min(1), customerId: z.string(), productId: z.string(),
          orderIds: z.array(z.string()).min(1), note: z.string().min(1),
          recordedOn: z.iso.date(), author: z.string().min(1),
        },
        preconditions: [
          ({ params, actor }) => {
            const product = read().get('Product', params.productId, { actor })
            if (!product) return reject('UNKNOWN_PRODUCT', `product ${params.productId} does not exist`)
          },
          ({ object, params, actor }) => {
            const product = read().get('Product', params.productId, { actor })!
            const customerTasks = read().traverse(object, 'customerRecallTasks', { actor })
            const productTasks = read().traverse(product, 'productRecallTasks', { actor })
            if (read().intersect(customerTasks, productTasks).objects.length > 0) {
              return reject('ALREADY_CONTACTED', `customer ${object.pk} already has a recall task for ${params.productId}`)
            }
          },
          ({ object, params, actor }) => {
            const product = read().get('Product', params.productId, { actor })!
            const customerOrders = read().traverse(object, 'customerOrders', { actor })
            const shipped = read().filter(customerOrders, (order) => order.properties.status === 'shipped')
            const productOrders = read().traverse(product, 'orderProducts', { actor })
            const valid = read().intersect(shipped, productOrders)
            if (new Set(params.orderIds).size !== params.orderIds.length ||
                params.orderIds.some((id) => !valid.objects.some((order) => order.pk === id))) {
              return reject('INVALID_EVIDENCE', 'Choose distinct shipped orders of this customer that contain the recalled product')
            }
          },
        ],
        effects: ({ object, params }) => [
          create('RecallTask', params.taskId, {
            id: params.taskId, note: params.note, recordedOn: params.recordedOn, author: params.author,
          }),
          link('customerRecallTasks', object.pk, params.taskId),
          link('productRecallTasks', params.productId, params.taskId),
          ...params.orderIds.map((orderId) => link('recallTaskOrders', params.taskId, orderId)),
        ],
      }),
    },
  })
}

export type Recall = ReturnType<typeof createRecallOntology>
