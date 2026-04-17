/** Convert integer micros (1e-6 USD) to a "$X.XX" string. */
export function microsToUsd(m: number | null | undefined): string {
  if (m == null) return '—'
  return `$${(m / 1_000_000).toFixed(2)}`
}
