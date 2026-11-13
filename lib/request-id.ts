/**
 * A v4 UUID for a panel request. `crypto.randomUUID` exists only in a secure context, so a panel
 * served over plain http on a tailnet name has none; `getRandomValues` works everywhere. Given 16 bytes, the
 * same bytes always make the same id.
 */
export function requestId(b = crypto.getRandomValues(new Uint8Array(16))): string {
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
