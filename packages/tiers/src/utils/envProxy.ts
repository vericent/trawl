import { isIP } from "node:net"

type Environment = Record<string, string | undefined>

// Bun's fetch treats an empty value, or one holding only a pair of quotes, as unset.
// The lowercase name is read first and an unset one falls back to the uppercase name.
function variable(env: Environment, name: string): string | undefined {
  for (const key of [name.toLowerCase(), name.toUpperCase()]) {
    const value = env[key]
    if (value && value !== '""' && value !== "''") return value
  }
  return undefined
}

function ipBytes(address: string): number[] | undefined {
  const family = isIP(address)
  if (family === 4) return address.split(".").map(Number)
  if (family !== 6) return undefined
  // Rewrite an embedded IPv4 tail (::ffff:10.0.0.1) as its two hexadecimal groups.
  const text = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_match, a, b, c, d) =>
    [(Number(a) << 8) | Number(b), (Number(c) << 8) | Number(d)].map((word) => word.toString(16)).join(":"),
  )
  const [head = "", rest] = text.split("::")
  const groups = (part: string) => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [])
  const left = groups(head)
  const right = groups(rest ?? "")
  const zeros = rest === undefined ? 0 : 8 - left.length - right.length
  const words = [...left, ...Array<number>(zeros).fill(0), ...right]
  return words.flatMap((word) => [word >> 8, word & 0xff])
}

function sameNetwork(host: number[], network: number[], prefix: number): boolean {
  if (host.length !== network.length || prefix > host.length * 8) return false
  for (let bit = 0; bit < prefix; bit++) {
    const index = bit >> 3
    const mask = 0x80 >> (bit & 7)
    if (((host[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) return false
  }
  return true
}

interface Entry {
  host: string
  port?: number
}

function parseEntry(raw: string): Entry | undefined {
  let text = raw.toLowerCase()
  let port: string | undefined
  if (text.startsWith("[")) {
    const end = text.indexOf("]")
    if (end < 0) return undefined
    const after = text.slice(end + 1)
    if (after && !after.startsWith(":") && !after.startsWith("/")) return undefined
    if (after.startsWith(":")) port = after.slice(1)
    text = text.slice(1, end) + (after.startsWith("/") ? after : "")
  } else if (text.indexOf(":") === text.lastIndexOf(":") && text.includes(":")) {
    port = text.slice(text.indexOf(":") + 1)
    text = text.slice(0, text.indexOf(":"))
  }
  if (port !== undefined) {
    if (!/^\d+$/.test(port)) return undefined
    const value = Number(port)
    if (value < 1 || value > 65_535) return undefined
  }
  if (text.startsWith("*.")) text = text.slice(2)
  else if (text.startsWith(".")) text = text.slice(1)
  if (text.endsWith(".")) text = text.slice(0, -1)
  if (!text) return undefined
  return port === undefined ? { host: text } : { host: text, port: Number(port) }
}

function hostMatches(entry: string, host: string): boolean {
  const slash = entry.indexOf("/")
  if (slash >= 0) {
    const network = ipBytes(entry.slice(0, slash))
    const address = ipBytes(host)
    const prefix = entry.slice(slash + 1)
    if (!network || !address || !/^\d+$/.test(prefix)) return false
    return sameNetwork(address, network, Number(prefix))
  }
  const address = ipBytes(host)
  if (address) {
    const other = ipBytes(entry)
    return Boolean(other) && other?.join(".") === address.join(".")
  }
  return host === entry || host.endsWith(`.${entry}`)
}

/**
 * Whether `NO_PROXY` exempts a URL, using the rules Bun's fetch applies: entries are
 * separated by commas or whitespace, `*` exempts every host, a leading `.` or `*.` is
 * ignored, a domain also exempts its subdomains, IP addresses match exactly or by CIDR
 * range, and an entry with a port exempts only that port.
 */
export function bypassesEnvironmentProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false
  let host = url.hostname.toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host.endsWith(".")) host = host.slice(0, -1)
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
  for (const raw of noProxy.split(/[\s,]+/)) {
    if (!raw) continue
    if (raw === "*") return true
    const entry = parseEntry(raw)
    if (!entry || (entry.port !== undefined && entry.port !== port)) continue
    if (hostMatches(entry.host, host)) return true
  }
  return false
}

/**
 * The proxy Bun's fetch would take from the environment for a request with no explicit
 * proxy: `https_proxy`/`HTTPS_PROXY` for https URLs, `http_proxy`/`HTTP_PROXY` for http
 * URLs, unless `no_proxy`/`NO_PROXY` exempts the host. A value without a scheme is an
 * HTTP proxy.
 */
export function environmentProxy(url: string | URL, env: Environment = process.env): string | undefined {
  const target = typeof url === "string" ? new URL(url) : url
  const scheme = target.protocol === "https:" ? "https" : target.protocol === "http:" ? "http" : undefined
  if (!scheme) return undefined
  const proxy = variable(env, `${scheme}_proxy`)
  if (!proxy || bypassesEnvironmentProxy(target, variable(env, "no_proxy"))) return undefined
  return /^[a-z][a-z\d+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`
}
