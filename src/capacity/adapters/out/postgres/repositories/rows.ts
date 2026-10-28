import type { Kysely } from 'kysely';
import {
  parseFxRate,
  type Program,
  type ProgramStatus,
  type Reservation,
  type ReservationOrigin,
  type ReservationStatus,
} from '#src/capacity/domain/index.js';
import type { Database } from '../db.js';

/** A pool or an open transaction. */
export type Queryable = Kysely<Database>;

/** pg returns BIGINT as a string and NUMERIC as a string; neither ever becomes a float. */
export interface ProgramRow {
  tenant_id: string;
  id: string;
  currency: string;
  credit_limit_minor: string;
  reserved_minor: string;
  status: string;
  version: string;
  treasury_seq: string;
  platform_seq: string;
}

export function toProgram(row: ProgramRow): Program {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    currency: row.currency,
    creditLimitMinor: BigInt(row.credit_limit_minor),
    reservedMinor: BigInt(row.reserved_minor),
    status: row.status as ProgramStatus,
    version: Number(row.version),
    treasurySeq: Number(row.treasury_seq),
    platformSeq: Number(row.platform_seq),
  };
}

export interface ReservationRow {
  id: string;
  tenant_id: string;
  program_id: string;
  invoice_id: string;
  invoice_amount_minor: string;
  invoice_currency: string;
  fx_rate: string;
  fx_rate_source: string;
  fx_rate_at: Date;
  amount_minor: string;
  released_minor: string;
  released_invoice_minor: string;
  status: string;
  origin: string;
  platform_seq: string;
  created_at: Date;
}

export function toReservation(row: ReservationRow): Reservation {
  const rate = parseFxRate(row.fx_rate);
  if (!rate.ok) throw new Error(`stored fx_rate ${row.fx_rate} is not a valid rate`);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    programId: row.program_id,
    invoiceId: row.invoice_id,
    invoiceAmount: { minor: BigInt(row.invoice_amount_minor), currency: row.invoice_currency },
    fx: { rate: rate.value, source: row.fx_rate_source, at: row.fx_rate_at },
    amountMinor: BigInt(row.amount_minor),
    releasedMinor: BigInt(row.released_minor),
    releasedInvoiceMinor: BigInt(row.released_invoice_minor),
    status: row.status as ReservationStatus,
    origin: row.origin as ReservationOrigin,
    platformSeq: Number(row.platform_seq),
    createdAt: row.created_at,
  };
}
