import type { QueryReader } from '../../../ports/index.js';
import { decodeCursor, encodeCursor } from '../../../shared/cursor.js';
import { rejected, succeeded, type Outcome } from '../../../shared/problem.js';
import { moneyView, type MoneyView } from '../../../shared/views.js';

export interface LedgerEntryView {
  readonly entryId: string;
  readonly kind: string;
  readonly reservationId: string | null;
  readonly deltaReserved: MoneyView;
  readonly deltaLimit: MoneyView;
  readonly limitAfter: MoneyView;
  readonly reservedAfter: MoneyView;
  readonly causeType: string;
  readonly causeId: string;
  readonly actor: string;
  readonly createdAt: string;
}

export interface LedgerPage {
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
}

/** FR-12 / FR-11: the audit trail of one program, oldest first, keyset-paged and tenant-scoped. */
export class GetLedger {
  constructor(private readonly reader: QueryReader) {}

  async execute(query: {
    tenantId: string;
    programId: string;
    limit: number;
    cursor?: string;
  }): Promise<Outcome<LedgerPage>> {
    let afterId: bigint | undefined;
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      if (after === null || !/^\d{1,18}$/.test(after)) {
        return rejected('validation-error', 'cursor is not valid.');
      }
      afterId = BigInt(after);
    }
    const program = await this.reader.getProgram(query.tenantId, query.programId);
    if (program === null) return rejected('not-found', 'Program not found.');

    const rows = await this.reader.listLedger({
      tenantId: query.tenantId,
      programId: query.programId,
      limit: query.limit + 1,
      ...(afterId === undefined ? {} : { afterId }),
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const money = (minor: bigint): MoneyView => moneyView(minor, program.currency);
    return succeeded(200, {
      items: page.map((entry) => ({
        entryId: entry.id.toString(),
        kind: entry.kind,
        reservationId: entry.reservationId,
        deltaReserved: money(entry.deltaReservedMinor),
        deltaLimit: money(entry.deltaLimitMinor),
        limitAfter: money(entry.limitAfter),
        reservedAfter: money(entry.reservedAfter),
        causeType: entry.causeType,
        causeId: entry.causeId,
        actor: entry.actor,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor(last.id.toString()) : null,
    });
  }
}
