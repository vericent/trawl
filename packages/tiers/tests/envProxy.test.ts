import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { Cookie, SessionData } from "@trawl/types"
import { type OrchestratorDeps, scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { bypassesEnvironmentProxy, environmentProxy } from "../src/utils/envProxy"
import { tier1Transport } from "../src/utils/tier1Transport"
import { tlsFetch } from "../src/utils/tlsTransport"
import { setProxyEnvironment, startTestProxy, type TestProxy } from "./helpers/proxy"

let first: TestProxy
let second: TestProxy
beforeAll(async () => {
  first = await startTestProxy("first")
  second = await startTestProxy("second")
})
afterAll(async () => {
  await first.close()
  await second.close()
})

let restoreEnvironment = () => {}
beforeEach(() => {
  first.seen.length = 0
  second.seen.length = 0
})
afterEach(() => {
  restoreEnvironment()
  restoreEnvironment = () => {}
})

const useEnvironment = (values: Record<string, string>) => {
  restoreEnvironment = setProxyEnvironment(values)
}

// Which local proxy a request reached, or "direct".
const reached = () => (first.seen.length > 0 ? "first" : second.seen.length > 0 ? "second" : "direct")

describe("environment proxy rules", () => {
  // Each case is checked against Bun's own fetch below, so the wreq transport keeps
  // the routing operators already get from TIER1_TRANSPORT=bun.
  const cases: [string, (a: string, b: string) => Record<string, string>, string][] = [
    ["HTTP_PROXY for http", (a) => ({ HTTP_PROXY: a }), "http://h.invalid/"],
    ["HTTPS_PROXY not for http", (a) => ({ HTTPS_PROXY: a }), "http://h.invalid/"],
    ["HTTPS_PROXY for https", (a) => ({ HTTPS_PROXY: a }), "https://h.invalid/"],
    ["HTTP_PROXY not for https", (a) => ({ HTTP_PROXY: a }), "https://h.invalid/"],
    ["lowercase http_proxy first", (a, b) => ({ http_proxy: a, HTTP_PROXY: b }), "http://h.invalid/"],
    ["lowercase https_proxy first", (a, b) => ({ https_proxy: a, HTTPS_PROXY: b }), "https://h.invalid/"],
    ["empty lowercase falls back", (_a, b) => ({ http_proxy: "", HTTP_PROXY: b }), "http://h.invalid/"],
    ["quoted empty value", () => ({ HTTP_PROXY: '""' }), "http://h.invalid/"],
    ["proxy without a scheme", (a) => ({ HTTP_PROXY: a.slice("http://".length) }), "http://h.invalid/"],
    ["NO_PROXY *", (a) => ({ HTTP_PROXY: a, NO_PROXY: "*" }), "http://h.invalid/"],
    ["NO_PROXY * in a list", (a) => ({ HTTP_PROXY: a, NO_PROXY: "x.invalid,*" }), "http://h.invalid/"],
    ["NO_PROXY exact host", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid" }), "http://h.invalid/"],
    ["NO_PROXY subdomain", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid" }), "http://a.h.invalid/"],
    ["NO_PROXY not a suffix", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid" }), "http://bh.invalid/"],
    ["NO_PROXY leading dot", (a) => ({ HTTP_PROXY: a, NO_PROXY: ".h.invalid" }), "http://h.invalid/"],
    ["NO_PROXY leading *.", (a) => ({ HTTP_PROXY: a, NO_PROXY: "*.invalid" }), "http://h.invalid/"],
    ["NO_PROXY other glob", (a) => ({ HTTP_PROXY: a, NO_PROXY: "*h.invalid" }), "http://h.invalid/"],
    ["NO_PROXY case", (a) => ({ HTTP_PROXY: a, NO_PROXY: "H.INVALID" }), "http://h.invalid/"],
    ["NO_PROXY whitespace", (a) => ({ HTTP_PROXY: a, NO_PROXY: " x.invalid  h.invalid " }), "http://h.invalid/"],
    ["NO_PROXY semicolon", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid;x.invalid" }), "http://h.invalid/"],
    ["NO_PROXY trailing dot", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid." }), "http://h.invalid/"],
    ["NO_PROXY default port", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid:80" }), "http://h.invalid/"],
    ["NO_PROXY other port", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid:8080" }), "http://h.invalid/"],
    ["NO_PROXY same port", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid:8080" }), "http://h.invalid:8080/"],
    ["NO_PROXY https port", (a) => ({ HTTPS_PROXY: a, NO_PROXY: "h.invalid:443" }), "https://h.invalid/"],
    ["NO_PROXY bad port", (a) => ({ HTTP_PROXY: a, NO_PROXY: "h.invalid:0" }), "http://h.invalid/"],
    ["NO_PROXY with a scheme", (a) => ({ HTTP_PROXY: a, NO_PROXY: "http://h.invalid" }), "http://h.invalid/"],
    [
      "lowercase no_proxy first",
      (a) => ({ HTTP_PROXY: a, no_proxy: "x.invalid", NO_PROXY: "h.invalid" }),
      "http://h.invalid/",
    ],
    ["empty no_proxy falls back", (a) => ({ HTTP_PROXY: a, no_proxy: "", NO_PROXY: "h.invalid" }), "http://h.invalid/"],
    ["no loopback exemption", (a) => ({ HTTP_PROXY: a }), "http://127.0.0.1:9/"],
    ["NO_PROXY IP", (a) => ({ HTTP_PROXY: a, NO_PROXY: "127.0.0.1" }), "http://127.0.0.1:9/"],
    ["NO_PROXY other IP", (a) => ({ HTTP_PROXY: a, NO_PROXY: "127.0.0.2" }), "http://127.0.0.1:9/"],
    ["NO_PROXY IP is not a domain", (a) => ({ HTTP_PROXY: a, NO_PROXY: "0.0.1" }), "http://127.0.0.1:9/"],
    ["NO_PROXY CIDR", (a) => ({ HTTP_PROXY: a, NO_PROXY: "127.0.0.0/8" }), "http://127.0.0.1:9/"],
    ["NO_PROXY other CIDR", (a) => ({ HTTP_PROXY: a, NO_PROXY: "10.0.0.0/8" }), "http://127.0.0.1:9/"],
    ["NO_PROXY no name lookup", (a) => ({ HTTP_PROXY: a, NO_PROXY: "localhost" }), "http://127.0.0.1:9/"],
  ]

  test.each(cases)("matches Bun's fetch: %s", async (_name, environment, url) => {
    useEnvironment(environment(first.url, second.url))
    await fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => {})
    const bun = reached()
    const resolved = environmentProxy(url)
    expect(resolved === undefined ? "direct" : resolved.endsWith(first.url.slice(7)) ? "first" : "second").toBe(bun)
  })

  test("matches IPv6 entries as Bun does", () => {
    const url = new URL("http://[::1]/")
    expect(bypassesEnvironmentProxy(url, "::1")).toBe(true)
    expect(bypassesEnvironmentProxy(url, "[::1]")).toBe(true)
    expect(bypassesEnvironmentProxy(url, "[::1]:80")).toBe(true)
    expect(bypassesEnvironmentProxy(url, "[::1]:81")).toBe(false)
    expect(bypassesEnvironmentProxy(url, "::/0")).toBe(true)
    expect(bypassesEnvironmentProxy(url, "::1/128")).toBe(true)
    expect(bypassesEnvironmentProxy(url, "fe80::/10")).toBe(false)
    expect(bypassesEnvironmentProxy(new URL("http://[::ffff:10.0.0.1]/"), "::ffff:a00:0/104")).toBe(true)
    expect(bypassesEnvironmentProxy(new URL("http://10.200.0.1/"), "10.0.0.0/8")).toBe(true)
    expect(bypassesEnvironmentProxy(new URL("http://11.0.0.1/"), "10.0.0.0/8")).toBe(false)
  })

  test("reads the environment at request time", () => {
    useEnvironment({})
    expect(environmentProxy("https://h.invalid/")).toBeUndefined()
    process.env.HTTPS_PROXY = "http://egress:3128"
    expect(environmentProxy("https://h.invalid/")).toBe("http://egress:3128")
  })
})

describe("wreq transport environment proxy", () => {
  let server: ReturnType<typeof Bun.serve>
  let direct: string[]
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        direct.push(new URL(request.url).pathname)
        return new Response("<html><body>origin content</body></html>", { headers: { "content-type": "text/html" } })
      },
    })
  })
  afterAll(() => server.stop(true))
  beforeEach(() => {
    direct = []
  })

  test("sends http requests through HTTP_PROXY", async () => {
    useEnvironment({ HTTP_PROXY: first.url })
    const response = await tlsFetch("http://h.invalid/page")
    expect(await response.text()).toBe("via first")
    expect(first.seen).toEqual(["GET http://h.invalid/page"])
  })

  test("tunnels https requests through HTTPS_PROXY", async () => {
    useEnvironment({ HTTPS_PROXY: first.url, HTTP_PROXY: second.url })
    await expect(tlsFetch("https://h.invalid/page", { timeoutMs: 3000 })).rejects.toThrow()
    expect(first.seen).toEqual(["CONNECT h.invalid:443"])
    expect(second.seen).toEqual([])
  })

  test("forwards to the origin and connects directly for NO_PROXY hosts", async () => {
    const url = `${server.url.origin}/forwarded`
    useEnvironment({ HTTP_PROXY: first.url })
    expect(await (await tlsFetch(url)).text()).toContain("origin content")
    expect(first.seen).toEqual([`GET ${url}`])
    expect(direct).toEqual(["/forwarded"])

    restoreEnvironment()
    useEnvironment({ HTTP_PROXY: first.url, NO_PROXY: "localhost,127.0.0.1" })
    first.seen.length = 0
    expect(await (await tlsFetch(`${server.url.origin}/direct`)).text()).toContain("origin content")
    expect(first.seen).toEqual([])
    expect(direct).toEqual(["/forwarded", "/direct"])
  })

  test("keeps an explicit request proxy ahead of the environment", async () => {
    useEnvironment({ HTTP_PROXY: first.url, NO_PROXY: "h.invalid" })
    const response = await tlsFetch("http://h.invalid/explicit", { proxy: second.url })
    expect(await response.text()).toBe("via second")
    expect(first.seen).toEqual([])
    expect(second.seen).toEqual(["GET http://h.invalid/explicit"])
  })

  test("does not proxy without proxy variables", async () => {
    useEnvironment({})
    expect(await (await tlsFetch(`${server.url.origin}/plain`)).text()).toContain("origin content")
    expect(first.seen).toEqual([])
    expect(direct).toEqual(["/plain"])
  })

  describe("through Tier 1 and the orchestrator", () => {
    const originalFetch = tier1Transport.fetch
    beforeEach(() => {
      tier1Transport.fetch = tlsFetch
    })
    afterEach(() => {
      tier1Transport.fetch = originalFetch
    })

    test("Tier 1 answers through the environment proxy", async () => {
      useEnvironment({ HTTPS_PROXY: first.url, HTTP_PROXY: first.url })
      const result = await runTier1(`${server.url.origin}/tier1`)
      expect(result).toMatchObject({ status: "success", statusCode: 200 })
      expect(first.seen).toEqual([`GET ${server.url.origin}/tier1`])
    })

    test("an environment proxy keeps clearance saving and replay eligible", async () => {
      const cookieSeen: (string | null)[] = []
      const origin = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          cookieSeen.push(request.headers.get("cookie"))
          if (!request.headers.get("cookie")?.includes("cf_clearance=verified"))
            return new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
              status: 403,
              headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
            })
          return new Response("<html><body><main>Cleared content</main></body></html>", {
            headers: { "content-type": "text/html" },
          })
        },
      })
      try {
        const url = `http://127.0.0.1:${origin.port}/`
        useEnvironment({ HTTPS_PROXY: first.url, HTTP_PROXY: first.url })
        let saved: SessionData | undefined
        let checkouts = 0
        const deps: OrchestratorDeps = {
          acquireBrowser: async () => {
            checkouts++
            return { fingerprint: { userAgent: "verified-agent" } } as BrowserHandle
          },
          releaseBrowser: () => {},
          loadSession: async () => saved,
          saveSession: async (_domain, data) => {
            saved = data
          },
          invalidateSession: async () => {
            saved = undefined
          },
        }
        const clearance: Cookie = {
          name: "cf_clearance",
          value: "verified",
          domain: "127.0.0.1",
          path: "/",
          expires: Date.now() / 1000 + 3600,
          secure: false,
          httpOnly: true,
        }
        const solved = await scrape({ url }, deps, {
          tier3: async () => ({
            tier: 3,
            status: "success",
            durationMs: 1,
            html: "<html><body><main>Cleared content</main></body></html>",
            effectiveUrl: url,
            contentType: "text/html",
            userAgent: "verified-agent",
            cookies: [clearance],
          }),
        })
        expect(solved.tier).toBe(3)
        // Tier 3 ran without a proxy, so the clearance is bound to the origin for replay.
        expect(saved?.httpOrigin).toBe(new URL(url).origin)
        expect(saved?.proxyId).toBeUndefined()

        first.seen.length = 0
        const replayed = await scrape({ url }, deps)
        expect(replayed).toMatchObject({ tier: 1, sessionCached: true, proxyUsed: false })
        expect(replayed.html).toContain("Cleared content")
        expect(checkouts).toBe(1)
        expect(first.seen).toEqual([`GET ${url}`])
        expect(cookieSeen.at(-1)).toBe("cf_clearance=verified")
      } finally {
        origin.stop(true)
      }
    })
  })
})
