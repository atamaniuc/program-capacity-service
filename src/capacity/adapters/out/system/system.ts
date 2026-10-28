import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator } from '#src/capacity/application/ports/index.js';

export const systemClock: Clock = { now: () => new Date() };

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, then random bits. */
export const uuidV7Generator: IdGenerator = {
  next: () => {
    const bytes = randomBytes(16);
    const timestamp = BigInt(Date.now());
    for (let index = 0; index < 6; index++) {
      bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
    }
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
};
