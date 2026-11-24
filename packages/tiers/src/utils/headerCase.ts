// Firefox writes HTTP/1.1 header names in their registered capitals ("Sec-Fetch-Site",
// "Priority"). Tier 1 keeps its headers keyed in lower case so it can replace and drop them by
// name; this turns them back into Firefox's spelling at the send. Bun's HTTP/1.1 client
// capitalises only the names it knows and sends the rest as written, so lower-case keys went out
// as a mix ("Sec-Fetch-Dest" beside "sec-fetch-site", "priority") that no browser sends, and
// Crunchbase's Cloudflare challenged every page (vericent, 2026-11-24); 1.8.0's capitals passed.
// HTTP/2 lower-cases every name on the wire, so wreq's requests are unchanged.

const SPECIAL: Record<string, string> = { dnt: "DNT", te: "TE", "x-requested-with": "X-Requested-With" }

export function headerName(name: string): string {
  const lower = name.toLowerCase()
  return SPECIAL[lower] ?? lower.replace(/(^|-)([a-z])/g, (_, dash: string, ch: string) => dash + ch.toUpperCase())
}

export function firefoxHeaderCase(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) out[headerName(name)] = value
  return out
}
