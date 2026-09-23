import type { Database } from 'better-sqlite3'
import type { WritebackAdapter } from '../../src/core.js'

/** Persist one recall ticket and its two relationships as one atomic INSERT. */
export function createSupportAdapter(support: Database): WritebackAdapter {
  return {
    apply(edits) {
      const [ticket, customer, product] = edits
      if (edits.length !== 3 || ticket.op !== 'create' || ticket.object !== 'RecallTicket' ||
          customer.op !== 'link' || customer.link !== 'customerRecallTickets' || customer.to !== ticket.pk ||
          product.op !== 'link' || product.link !== 'productRecallTickets' || product.to !== ticket.pk) {
        throw new Error('support only accepts a recall ticket with its customer and product links')
      }
      // The source also enforces one ticket per customer/product, including
      // tickets created upstream after the ontology's last refresh.
      support.prepare(`
        INSERT INTO tickets (id, customer_id, product_id, note, recorded_on, author)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(ticket.pk, customer.from, product.from, ticket.data.note, ticket.data.recordedOn, ticket.data.author)
    },
  }
}
