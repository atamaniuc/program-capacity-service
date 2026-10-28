import { Counter, Gauge, type Registry } from 'prom-client';
import type { OperationalMetrics } from '#src/capacity/application/ports/index.js';

/** Prometheus gauges of the relay and the jobs, registered on the ops-port registry. */
export function createOperationalMetrics(registry: Registry): OperationalMetrics {
  const unpublished = new Gauge({
    name: 'outbox_lag',
    help: 'Outbox events committed but not yet published to Kafka.',
    registers: [registry],
  });
  const oldestAge = new Gauge({
    name: 'outbox_oldest_unpublished_age_seconds',
    help: 'Age of the oldest unpublished outbox event.',
    registers: [registry],
  });
  const mismatches = new Gauge({
    name: 'invariant_mismatch_programs',
    help: 'Programs whose reserved total disagrees with reservations or ledger at the last check.',
    registers: [registry],
  });
  const overLimit = new Gauge({
    name: 'programs_over_limit',
    help: 'Programs whose reserved total exceeds the credit limit at the last check.',
    registers: [registry],
  });
  const deleted = new Counter({
    name: 'retention_deleted_rows_total',
    help: 'Rows removed by the retention cleanup job.',
    labelNames: ['table'],
    registers: [registry],
  });
  return {
    setOutboxLag: (lag) => {
      unpublished.set(lag.unpublished);
      oldestAge.set(lag.oldestAgeSeconds);
    },
    setInvariantMismatches: (count) => {
      mismatches.set(count);
    },
    setProgramsOverLimit: (count) => {
      overLimit.set(count);
    },
    addRetentionDeleted: (table, count) => {
      if (count > 0) deleted.inc({ table }, count);
    },
  };
}

/** Counter behind the DLQ alert: records parked in `<topic>.dlq`, by topic and error code. */
export function createDlqMetrics(registry: Registry): (topic: string, reason: string) => void {
  const parked = new Counter({
    name: 'dlq_messages_total',
    help: 'Records published to a dead-letter topic.',
    labelNames: ['topic', 'reason'],
    registers: [registry],
  });
  return (topic, reason) => {
    parked.inc({ topic, reason });
  };
}
