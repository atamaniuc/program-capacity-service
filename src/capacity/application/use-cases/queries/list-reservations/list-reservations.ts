import type { ReservationStatus } from '#src/capacity/domain/index.js';
import type { QueryReader } from '../../../ports/index.js';
import { decodeCursor, encodeCursor } from '../../../shared/cursor.js';
import { rejected, succeeded, type Outcome } from '../../../shared/problem.js';
import { reservationFields, type ReservationFields } from '../../../shared/views.js';

export interface ReservationPage {
  readonly items: readonly ReservationFields[];
  /** Null on the last page. */
  readonly nextCursor: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** FR-12: reservations of one program, filtered and keyset-paged; another tenant's program is 404. */
export class ListReservations {
  constructor(private readonly reader: QueryReader) {}

  async execute(query: {
    tenantId: string;
    programId: string;
    invoiceId?: string;
    status?: ReservationStatus;
    limit: number;
    cursor?: string;
  }): Promise<Outcome<ReservationPage>> {
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor);
      if (after === null || !UUID.test(after)) {
        return rejected('validation-error', 'cursor is not valid.');
      }
      afterId = after;
    }
    const program = await this.reader.getProgram(query.tenantId, query.programId);
    if (program === null) return rejected('not-found', 'Program not found.');

    const rows = await this.reader.listReservations({
      tenantId: query.tenantId,
      programId: query.programId,
      limit: query.limit + 1,
      ...(query.invoiceId === undefined ? {} : { invoiceId: query.invoiceId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(afterId === undefined ? {} : { afterId }),
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return succeeded(200, {
      items: page.map((reservation) => reservationFields(reservation, program.currency)),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last.id) : null,
    });
  }
}
