export interface Clock {
  now(): Date;
}

/** Time-ordered identifiers (UUIDv7). */
export interface IdGenerator {
  next(): string;
}
