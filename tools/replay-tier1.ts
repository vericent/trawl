/**
 * Replay captured pages through Tier 1's verdict code, with no network.
 *
 *   bun tools/replay-tier1.ts --out replay.jsonl [--waf /opt/trawl-waf/trawl-waf] [--limit N] CAPTURE...
 *
 * CAPTURE is a `.jsonl` or `.jsonl.gz` file, or a directory of them: the page capture another
 * crawler kept (one JSON object a line). Each `{"kind": "page"}` line carries the URL, the final
 * URL, the status, every header as `[name, value]` pairs (each Set-Cookie its own pair), and the
 * body as the crawler decoded it. Other lines (`{"kind": "domain"}`, ...) are skipped.
 *
 * Every page goes through `runTier1` with Tier 1's transport replaced by one that answers from
 * the capture and refuses every other URL (a proof-of-work follow-up, say): nothing is fetched.
 * Each page is run twice:
 *
 * - `verdict`: a fresh request, as `/scrape` makes it with no cached session. Its status is
 *   Tier 1's verdict: `success`, `needs-js` (it would escalate to a browser), `blocked` or `error`.
 * - `shell`: the same answer with an (empty) HTTP session, the only path on which Tier 1 runs its
 *   `javascript-shell` check (a page whose body text, scripts aside, is empty or "Loading"). Its
 *   Set-Cookie headers are left out: an empty jar refuses a parent domain's cookie
 *   (`session-cookies-need-browser`) that a browser-filled jar would take, and the check is the body's.
 *
 * With `--waf`, the page's evidence also goes to wafmeow (`WafDetector`), as `detectWaf` does.
 *
 * The capture's body is already decoded, so `Content-Encoding` and `Content-Length` are dropped
 * and the charset is said to be UTF-8 (the bytes replayed are the text's UTF-8). Redirects were
 * followed by the crawler: the final page is answered at the first URL, and `res.url` names the
 * final URL.
 *
 * One JSON line a page goes to `--out`: the page's identity, the two verdicts, the WAF products,
 * and SHA-256s of the body replayed and of the `html` Tier 1 returned (equal unless
 * `normalizeHtml` changed it), so a reader can check detection on trawl's text offline.
 */
import { createHash } from "node:crypto"
import { createReadStream, readdirSync, statSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { createGunzip } from "node:zlib"
import { runTier1, type Tier1Result } from "../packages/tiers/src/tiers/1"
import { HttpSessionCookies } from "../packages/tiers/src/utils/httpSessionCookies"
import { tier1Transport } from "../packages/tiers/src/utils/tier1Transport"
import { snapshotWafEvidence, WafDetector, type WafEvidence } from "../packages/tiers/src/utils/waf"

export interface CapturedPage {
  kind: "page"
  domain: string
  n: number
  root: boolean
  url: string
  finalUrl: string
  status: number
  contentType: string
  headers: [string, string][]
  body: string
  bodyBytes?: number
  bodyCut: boolean
}

// Headers that describe the bytes on the wire, which the capture no longer holds.
const WIRE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"])

const isHeaderPair = (pair: unknown): pair is [string, string] =>
  Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string"

/** A capture line as a page, or undefined for any other line (a domain's record, a blank line). */
export function parseCaptureLine(line: string): CapturedPage | undefined {
  const text = line.trim()
  if (!text) return
  const raw = JSON.parse(text) as Record<string, unknown>
  if (raw?.kind !== "page") return
  const { domain, url, status } = raw
  if (typeof domain !== "string" || typeof url !== "string" || typeof status !== "number")
    throw new Error(`capture page without domain, url or status: ${text.slice(0, 120)}`)
  const headers = Array.isArray(raw.headers) ? raw.headers.filter(isHeaderPair) : []
  return {
    kind: "page",
    domain,
    n: typeof raw.n === "number" ? raw.n : 0,
    root: raw.root === true,
    url,
    finalUrl: typeof raw.final_url === "string" && raw.final_url ? raw.final_url : url,
    status,
    contentType: typeof raw.content_type === "string" ? raw.content_type : "",
    headers: headers.map(([name, value]) => [name, value]),
    body: typeof raw.body === "string" ? raw.body : "",
    bodyBytes: typeof raw.body_bytes === "number" ? raw.body_bytes : undefined,
    bodyCut: raw.body_cut === true || raw.body_truncated === true,
  }
}

/** The captured headers as the replayed response's: wire-only headers dropped, the charset UTF-8. */
export function replayHeaders(pairs: [string, string][]): Headers {
  const headers = new Headers()
  for (const [name, value] of pairs) {
    const key = name.toLowerCase()
    if (WIRE_HEADERS.has(key)) continue
    headers.append(key, wireValue(key === "content-type" ? utf8ContentType(value) : value))
  }
  return headers
}

/**
 * A header value as the bytes it came in: the capture decoded them as UTF-8, and a Headers value
 * is a byte string, so a character past U+00FF (a "‚" in a Permissions-Policy) goes back to its bytes.
 */
export function wireValue(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the byte-string range is the point
  return /[^\u0000-\u00ff]/.test(value) ? Buffer.from(value, "utf8").toString("latin1") : value
}

export function utf8ContentType(value: string): string {
  return /;\s*charset\s*=/i.test(value) ? value.replace(/;\s*charset\s*=\s*("?)[^;"]*\1/i, "; charset=utf-8") : value
}

type Tier1Fetch = typeof tier1Transport.fetch

/** A Tier 1 transport that answers `page` at its own URLs and throws for every other one. */
export function offlineFetch(page: CapturedPage, misses: string[]): Tier1Fetch {
  const own = new Set([page.url, page.finalUrl].map((u) => new URL(u).href))
  return (async (url: string | URL) => {
    const href = new URL(String(url)).href
    if (!own.has(href)) {
      misses.push(href)
      throw new Error(`offline replay: ${href} is not in the capture`)
    }
    const status = page.status >= 200 && page.status <= 599 ? page.status : 599
    const nullBody = status === 204 || status === 205 || status === 304
    const res = new Response(nullBody ? null : new TextEncoder().encode(page.body), {
      status,
      headers: replayHeaders(page.headers),
    })
    Object.defineProperty(res, "url", { value: page.finalUrl })
    return res
  }) as Tier1Fetch
}

export interface Verdict {
  status: Tier1Result["status"]
  reason?: string
  challenge?: string
  explicitChallenge?: boolean
  statusCode?: number
}

const verdictOf = (r: Tier1Result): Verdict => ({
  status: r.status,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.challenge ? { challenge: r.challenge } : {}),
  ...(r.explicitChallenge ? { explicitChallenge: true } : {}),
  ...(r.statusCode !== undefined ? { statusCode: r.statusCode } : {}),
})

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export interface Replayed {
  domain: string
  n: number
  root: boolean
  url: string
  finalUrl: string
  status: number
  bodyBytes: number
  bodyCut: boolean
  verdict: Verdict
  shell: Verdict
  waf?: { state: string; products: string[]; reason?: string }
  bodySha256: string
  htmlSha256?: string
  htmlLength?: number
  offlineMisses: string[]
}

/** One page through Tier 1, fresh and as a session replay, with the transport answering from it. */
export async function replayPage(page: CapturedPage, waf?: WafDetector): Promise<Replayed> {
  const misses: string[] = []
  const original = tier1Transport.fetch
  tier1Transport.fetch = offlineFetch(page, misses)
  let evidence: WafEvidence | undefined
  try {
    const fresh = await runTier1(
      page.url,
      undefined,
      "GET",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      60_000,
      undefined,
      (seen) => {
        evidence ??= seen
      },
    )
    tier1Transport.fetch = offlineFetch(
      { ...page, headers: page.headers.filter(([name]) => name.toLowerCase() !== "set-cookie") },
      misses,
    )
    const replay = await runTier1(
      page.url,
      undefined,
      "GET",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      new HttpSessionCookies(new URL(page.url).origin, []),
    )
    const out: Replayed = {
      domain: page.domain,
      n: page.n,
      root: page.root,
      url: page.url,
      finalUrl: page.finalUrl,
      status: page.status,
      bodyBytes: page.bodyBytes ?? Buffer.byteLength(page.body),
      bodyCut: page.bodyCut,
      verdict: verdictOf(fresh),
      shell: verdictOf(replay),
      bodySha256: sha256(page.body),
      ...(fresh.status === "success" && fresh.html !== undefined
        ? { htmlSha256: sha256(fresh.html), htmlLength: fresh.html.length }
        : {}),
      offlineMisses: [...new Set(misses)],
    }
    if (waf && evidence) {
      const snapshot = snapshotWafEvidence(evidence)
      let found = await waf.detect(snapshot, 5_000)
      // the first call starts the worker, which can outlast the detector's 250 ms
      for (let retry = 0; retry < 3 && found.state === "unavailable" && found.reason !== "not-installed"; retry++) {
        await Bun.sleep(100)
        found = await waf.detect(snapshot, 5_000)
      }
      out.waf = { state: found.state, products: found.products, ...(found.reason ? { reason: found.reason } : {}) }
    }
    return out
  } finally {
    tier1Transport.fetch = original
  }
}

/** The capture files under each argument: files as given, directories' `.jsonl(.gz)` files sorted. */
export function captureFiles(paths: string[]): string[] {
  return paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => /\.jsonl(?:\.gz)?$/.test(name))
          .sort()
          .map((name) => join(path, name))
      : [path],
  )
}

/** Lines split at "\n" only: readline would also split at U+2028 and U+2029, which JSON leaves raw in a string. */
export async function* jsonLines(input: AsyncIterable<Buffer | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of input) {
    rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let end = rest.indexOf("\n")
    while (end !== -1) {
      yield rest.slice(0, end)
      rest = rest.slice(end + 1)
      end = rest.indexOf("\n")
    }
  }
  rest += decoder.decode()
  if (rest) yield rest
}

export async function* capturedPages(file: string): AsyncGenerator<CapturedPage> {
  const stream = createReadStream(file)
  for await (const line of jsonLines(file.endsWith(".gz") ? stream.pipe(createGunzip()) : stream)) {
    const page = parseCaptureLine(line)
    if (page) yield page
  }
}

export interface Args {
  out: string
  waf?: string
  limit?: number
  inputs: string[]
}

export function parseArgs(argv: string[]): Args {
  const inputs: string[] = []
  let out: string | undefined
  let waf: string | undefined
  let limit: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === "--out") out = value()
    else if (arg === "--waf") waf = value()
    else if (arg === "--limit") {
      limit = Number(value())
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit takes a positive whole number")
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`)
    else inputs.push(arg)
  }
  if (!out) throw new Error("--out PATH is required")
  if (inputs.length === 0) throw new Error("name at least one capture file or directory")
  return { out, inputs, ...(waf ? { waf } : {}), ...(limit ? { limit } : {}) }
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const waf = args.waf ? new WafDetector([args.waf]) : undefined
  const out = await open(args.out, "w")
  const counts = new Map<string, number>()
  let pages = 0
  const started = Date.now()
  try {
    for (const file of captureFiles(args.inputs)) {
      for await (const page of capturedPages(file)) {
        const replayed = await replayPage(page, waf)
        await out.write(`${JSON.stringify(replayed)}\n`)
        const key = `${replayed.verdict.status}${replayed.verdict.reason ? ` ${replayed.verdict.reason}` : ""}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
        if (++pages % 1000 === 0) console.error(`${pages} pages, ${((Date.now() - started) / 1000).toFixed(0)} s`)
        if (args.limit && pages >= args.limit) break
      }
      if (args.limit && pages >= args.limit) break
    }
  } finally {
    await out.close()
  }
  console.error(`${pages} pages replayed in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${args.out}`)
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) console.error(`  ${count}\t${key}`)
  process.exit(0)
}

if (import.meta.main) await main(process.argv.slice(2))
