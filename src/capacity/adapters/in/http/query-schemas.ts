import * as z from 'zod';
import { Amount, reservationFields } from '../boundary/schemas.js';

/** FR-12 contract: list reservations and read the ledger, both keyset-paged (ADR 015). */

const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(50)
  .meta({ description: 'Page size, 1 to 100.', example: 50 });

const cursor = z.string().min(1).max(256).optional().meta({
  description: 'Opaque cursor: pass the `nextCursor` of the previous page unchanged.',
});

export const ListReservationsQuery = z.object({
  invoiceId: z.string().min(1).max(128).optional().meta({ example: 'INV-1003' }),
  status: z.enum(['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED']).optional(),
  limit,
  cursor,
});

export const LedgerQuery = z.object({ limit, cursor });

export const ReservationPageResponse = z
  .object({
    items: z.array(z.object(reservationFields).meta({ id: 'ReservationItem' })),
    nextCursor: z.string().nullable().meta({ description: 'Null on the last page.' }),
  })
  .meta({ id: 'ReservationPage' });

export const LedgerPageResponse = z
  .object({
    items: z.array(
      z
        .object({
          entryId: z.string(),
          kind: z.enum(['RESERVE', 'RELEASE', 'LIMIT_SET', 'RECON_ADJUST']),
          reservationId: z.uuid().nullable(),
          deltaReserved: Amount.meta({ description: 'Change of reserved, program currency.' }),
          deltaLimit: Amount.meta({ description: 'Change of the credit limit.' }),
          limitAfter: Amount,
          reservedAfter: Amount,
          causeType: z.string(),
          causeId: z.string(),
          actor: z.string(),
          createdAt: z.iso.datetime(),
        })
        .meta({ id: 'LedgerEntry' }),
    ),
    nextCursor: z.string().nullable().meta({ description: 'Null on the last page.' }),
  })
  .meta({ id: 'LedgerPage' });
