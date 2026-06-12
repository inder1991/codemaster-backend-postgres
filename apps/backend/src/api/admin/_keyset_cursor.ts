// Reusable opaque (ts, id) keyset cursor for the admin list reads (integrations, knowledge, proposals).
// The cursor is base64url(JSON {ts, id}) unpadded (Buffer's base64url is already unpadded). An empty ts
// marks the NULLS-LAST tail of a nullable-timestamp sort (matches the Python's datetime.min sentinel).
//
// W2.7 / EH9: the in-memory `keysetSlice` (fetch-all, sort, slice in Node) was DELETED — every consumer
// now pushes the keyset predicate + ORDER BY + LIMIT into SQL (see admin_read_repo.ts). The `ts` payload
// carries the raw Postgres `::text` µs-precision rendering, never a JS-Date-truncated ISO string.

export class CursorInvalidError extends Error {
  public constructor() {
    super("invalid cursor");
    this.name = "CursorInvalidError";
  }
}

export function encodeTsIdCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), "utf-8").toString("base64url");
}

export function decodeTsIdCursor(cursor: string): { ts: string; id: string } {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
      ts?: unknown;
      id?: unknown;
    };
    if (typeof p.ts !== "string" || typeof p.id !== "string") {
      throw new CursorInvalidError();
    }
    return { ts: p.ts, id: p.id };
  } catch {
    throw new CursorInvalidError();
  }
}
