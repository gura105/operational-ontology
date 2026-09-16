import { z } from 'zod'
import {
  create, defineAction, defineLink, defineObject, defineOntology, link, objectSet, reject,
  type Runtime,
} from '../../src/core.js'

const objects = {
  Equipment: defineObject({
    primaryKey: 'id', source: 'MES equipment',
    properties: {
      id: z.string(),
      inspection: z.enum(['clear', 'pressure-anomaly']), inspectedAt: z.iso.datetime({ offset: true }),
    },
  }),
  Product: defineObject({
    primaryKey: 'id', source: 'MES product catalog',
    // Historical evidence for prioritization, not a verdict on current lots.
    properties: { id: z.string(), name: z.string(), pastPressureIssue: z.boolean() },
  }),
  Lot: defineObject({
    primaryKey: 'id', source: 'MES lot',
    properties: {
      id: z.string(), units: z.number().int().positive(),
      manufacturedAt: z.iso.datetime({ offset: true }), releaseInspection: z.literal('passed'),
    },
  }),
  Shipment: defineObject({
    primaryKey: 'id', source: 'WMS shipment',
    properties: { id: z.string(), status: z.enum(['pending', 'shipped', 'held']), shippedAt: z.iso.datetime({ offset: true }).nullable() },
  }),
  ShipmentLine: defineObject({
    primaryKey: 'id', source: 'WMS shipment_line',
    properties: { id: z.string(), units: z.number().int().positive() },
  }),
  Customer: defineObject({
    primaryKey: 'id', source: 'WMS customer',
    properties: { id: z.string(), name: z.string(), region: z.string() },
  }),
  ContactTask: defineObject({
    primaryKey: 'id', owned: true,
    properties: { id: z.string(), reason: z.string(), after: z.iso.datetime({ offset: true }), before: z.iso.datetime({ offset: true }) },
  }),
}

const schema = defineOntology({
  name: 'factory', objects,
  links: {
    producedOn: defineLink({ from: 'Equipment', to: 'Lot', kind: 'many-to-many', via: 'MES production' }),
    productLots: defineLink({ from: 'Product', to: 'Lot', kind: 'one-to-many', via: 'MES lot.product_id' }),
    lotLines: defineLink({ from: 'Lot', to: 'ShipmentLine', kind: 'one-to-many', via: 'WMS shipment_line.lot_id' }),
    shipmentLines: defineLink({ from: 'Shipment', to: 'ShipmentLine', kind: 'one-to-many', via: 'WMS shipment_line.shipment_id' }),
    customerShipments: defineLink({ from: 'Customer', to: 'Shipment', kind: 'one-to-many', via: 'WMS shipment.customer_id' }),
    customerContacts: defineLink({ from: 'Customer', to: 'ContactTask', kind: 'one-to-many', owned: true }),
    contactEquipment: defineLink({ from: 'ContactTask', to: 'Equipment', kind: 'many-to-many', owned: true }),
    contactLots: defineLink({ from: 'ContactTask', to: 'Lot', kind: 'many-to-many', owned: true }),
    contactLines: defineLink({ from: 'ContactTask', to: 'ShipmentLine', kind: 'many-to-many', owned: true }),
  },
  actions: {},
})

type FactoryRead = Pick<Runtime<typeof schema>, 'get' | 'traverse' | 'pivot' | 'filter' | 'intersect'>

/**
 * Rules need current related objects. Inject only the read methods here;
 * the getter is called after runtime construction (see runtime.ts).
 * Every rule passes its caller's actor to these reads.
 */
export function createFactoryOntology(read: () => FactoryRead) {
  return defineOntology({
    ...schema,
    actions: {
      createContactTask: defineAction(objects, {
        description: 'Record a priority customer-contact/reinspection task for shipped lots made on pressure-anomalous equipment in the supplied window, whose product catalog records past pressure-related issues. Other lots remain under review. Does not confirm defects or send a message.',
        object: 'Customer', targetParam: 'customerId',
        params: {
          customerId: z.string(), taskId: z.string().min(1), equipmentId: z.string(),
          after: z.iso.datetime({ offset: true }), before: z.iso.datetime({ offset: true }),
          lineIds: z.array(z.string()).min(1), reason: z.string().min(1),
        },
        preconditions: [({ object, params, actor }) => {
          const equipment = read().get('Equipment', params.equipmentId, { actor })
          if (!equipment || equipment.properties.inspection !== 'pressure-anomaly') return reject('ANOMALY_REQUIRED', 'Choose equipment with a recorded pressure anomaly')
          if (Date.parse(params.after) >= Date.parse(params.before)) return reject('INVALID_WINDOW', 'after must precede before')
          const lots = read().filter(read().traverse(equipment, 'producedOn', { actor }), (object) => {
            const time = Date.parse(object.properties.manufacturedAt as string)
            return time >= Date.parse(params.after) && time < Date.parse(params.before)
          })
          const priority = read().filter(lots, (lot) => read().traverse(lot, 'productLots', { actor }).objects
            .some((product) => product.properties.pastPressureIssue === true))
          const priorityLines = read().pivot(priority, 'lotLines', { actor })
          const shipments = read().filter(read().traverse(object, 'customerShipments', { actor }), (object) => object.properties.status === 'shipped')
          const valid = read().intersect(priorityLines, read().pivot(shipments, 'shipmentLines', { actor }))
          if (new Set(params.lineIds).size !== params.lineIds.length || params.lineIds.some((id) => !valid.objects.some((line) => line.pk === id))) {
            return reject('INVALID_EVIDENCE', 'Choose distinct lines shipped to this customer from the selected equipment and window, with product history of pressure-related issues')
          }
        }],
        effects: ({ object, params, actor }) => {
          const lines = objectSet('ShipmentLine', params.lineIds.map((id) => read().get('ShipmentLine', id, { actor })!))
          const lots = read().pivot(lines, 'lotLines', { actor })
          return [
            create('ContactTask', params.taskId, { id: params.taskId, reason: params.reason, after: params.after, before: params.before }),
            link('customerContacts', object.pk, params.taskId), link('contactEquipment', params.taskId, params.equipmentId),
            ...lots.objects.map((lot) => link('contactLots', params.taskId, lot.pk)),
            ...params.lineIds.map((id) => link('contactLines', params.taskId, id)),
          ]
        },
      }),
    },
  })
}

export type Factory = ReturnType<typeof createFactoryOntology>
