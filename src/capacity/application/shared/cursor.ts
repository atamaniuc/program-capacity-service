/** Opaque page cursor: base64url of a small JSON document, so its content can change later. */
export function encodeCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), 'utf8').toString('base64url');
}

/** The position inside a cursor, or null when the cursor was not issued by `encodeCursor`. */
export function decodeCursor(cursor: string): string | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const after = (parsed as { after?: unknown }).after;
    return typeof after === 'string' && after.length > 0 && after.length <= 64 ? after : null;
  } catch {
    return null;
  }
}
