/** Deterministic RFC 9562-shaped UUID for synthetic receipt fixtures. */
export function uuid(n: number): string {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}
