/** Who asks and under which request; recorded in ledger and outbox rows (NFR-09). */
export interface RequestContext {
  readonly tenantId: string;
  /** Token `sub` or `client_id`. */
  readonly actor: string;
  readonly requestId: string;
  readonly idempotencyKey?: string | undefined;
}
