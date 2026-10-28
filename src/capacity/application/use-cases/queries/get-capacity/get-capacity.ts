import type { CapacityReader } from '../../../ports/index.js';
import { rejected, succeeded, type Outcome } from '../../../shared/problem.js';
import { capacityView, type CapacityView } from '../../../shared/views.js';

/** FR-01: current availability of one program, tenant-scoped; another tenant's program is 404. */
export class GetCapacity {
  constructor(private readonly reader: CapacityReader) {}

  async execute(query: { tenantId: string; programId: string }): Promise<Outcome<CapacityView>> {
    const program = await this.reader.getProgram(query.tenantId, query.programId);
    return program === null
      ? rejected('not-found', 'Program not found.')
      : succeeded(200, capacityView(program));
  }
}
