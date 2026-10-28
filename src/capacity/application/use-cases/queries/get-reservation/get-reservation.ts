import type { CapacityReader } from '../../../ports/index.js';
import { rejected, succeeded, type Outcome } from '../../../shared/problem.js';
import { moneyView, reservationFields, type ReservationFields } from '../../../shared/views.js';

export interface ReservationDetail extends ReservationFields {
  readonly releases: readonly {
    readonly releaseRef: string;
    readonly reason: string;
    readonly invoiceAmount: { readonly value: string; readonly currency: string };
    readonly releasedAmount: { readonly value: string; readonly currency: string };
    readonly createdAt: string;
  }[];
}

/** One reservation with its releases, tenant- and program-scoped. */
export class GetReservation {
  constructor(private readonly reader: CapacityReader) {}

  async execute(query: {
    tenantId: string;
    programId: string;
    reservationId: string;
  }): Promise<Outcome<ReservationDetail>> {
    const program = await this.reader.getProgram(query.tenantId, query.programId);
    if (program === null) return rejected('not-found', 'Program not found.');
    const found = await this.reader.getReservation(
      query.tenantId,
      query.programId,
      query.reservationId,
    );
    if (found === null) return rejected('not-found', 'Reservation not found.');
    const { reservation, releases } = found;
    return succeeded(200, {
      ...reservationFields(reservation, program.currency),
      releases: releases.map((release) => ({
        releaseRef: release.releaseRef,
        reason: release.reason,
        invoiceAmount: moneyView(release.invoiceMinor, reservation.invoiceAmount.currency),
        releasedAmount: moneyView(release.programMinor, program.currency),
        createdAt: release.createdAt.toISOString(),
      })),
    });
  }
}
