import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import { scrapeRoute } from "./scrape"

// A local upstream: /r1 -> /r2 -> /end, each redirect setting a cookie; /refuse answers 429.
let server: ReturnType<typeof Bun.serve>
let base = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/r1") return new Response(null, { status: 302, headers: { location: "/r2", "set-cookie": "a=1" } })
      if (path === "/r2") return new Response(null, { status: 302, headers: { location: "/end", "set-cookie": "b=2" } })
      if (path === "/end") return new Response("the end", { headers: { "content-type": "text/plain" } })
      if (path === "/refuse")
        return new Response('{"error":"slow down"}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        })
      if (path === "/challenge")
        return new Response("<html><head><title>Just a moment...</title></head><body></body></html>", {
          status: 403,
          headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        })
      if (path === "/widget")
        return new Response(
          '<html><head><title>Example</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><div class="g-recaptcha"></div></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8", "x-test": "kept" } },
        )
      return new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => server.stop(true))

const deps = (): OrchestratorDeps => ({
  acquireBrowser: async () => {
    throw new Error("no browser in this test")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

type Answer = {
  statusCode?: number
  html?: string
  url?: string
  error?: string
  responseHeaders?: Record<string, string>
  timings?: { tier: number; status: string; reason?: string }[]
}
const post = async (body: Record<string, unknown>) => {
  const res = await scrapeRoute(deps, () => ({}), undefined, false).handle(
    new Request("http://localhost/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, json: (await res.json()) as Answer }
}

describe("/scrape maxRedirects", () => {
  test("0: the first redirect comes back, with its Location and Set-Cookie", async () => {
    const { status, json } = await post({ url: `${base}/r1`, maxTier: 1, maxRedirects: 0 })
    expect(status).toBe(200)
    expect(json.statusCode).toBe(302)
    expect(json.responseHeaders?.location).toBe("/r2")
    expect(json.responseHeaders?.["set-cookie"]).toBe("a=1")
  })

  test("1: one is followed, the next comes back", async () => {
    const { json } = await post({ url: `${base}/r1`, maxTier: 1, maxRedirects: 1 })
    expect(json.statusCode).toBe(302)
    expect(json.url).toBe(`${base}/r2`)
    expect(json.responseHeaders?.location).toBe("/end")
    expect(json.responseHeaders?.["set-cookie"]).toBe("b=2")
  })

  test("unset: redirects are followed as before", async () => {
    const { json } = await post({ url: `${base}/r1`, maxTier: 1 })
    expect(json.statusCode).toBe(200)
    expect(json.html).toBe("the end")
  })

  test("must be 0 to 19, and needs maxTier 1", async () => {
    expect((await post({ url: `${base}/r1`, maxTier: 1, maxRedirects: 20 })).status).toBe(400)
    expect((await post({ url: `${base}/r1`, maxTier: 1, maxRedirects: 1.5 })).status).toBe(400)
    expect((await post({ url: `${base}/r1`, maxRedirects: 0 })).status).toBe(400)
  })
})

describe("/scrape returnRefusals", () => {
  test("a 429 comes back as the answer, with its page and Retry-After", async () => {
    const { status, json } = await post({ url: `${base}/refuse`, maxTier: 1, returnRefusals: true })
    expect(status).toBe(200)
    expect(json.statusCode).toBe(429)
    expect(json.html).toBe('{"error":"slow down"}')
    expect(json.responseHeaders?.["retry-after"]).toBe("30")
  })

  test("a page tier 1 would hand to a browser comes back with its page, and timings say why", async () => {
    const { status, json } = await post({ url: `${base}/widget`, maxTier: 1, returnRefusals: true })
    expect(status).toBe(200)
    expect(json.statusCode).toBe(200)
    expect(json.html).toContain('class="g-recaptcha"')
    expect(json.responseHeaders?.["x-test"]).toBe("kept")
    expect(json.timings?.[0]).toMatchObject({ tier: 1, status: "needs-js", reason: "recaptcha-shell" })
  })

  test("a challenge known by its header comes back with its status", async () => {
    const { status, json } = await post({ url: `${base}/challenge`, maxTier: 1, returnRefusals: true })
    expect(status).toBe(200)
    expect(json.statusCode).toBe(403)
    expect(json.responseHeaders?.["cf-mitigated"]).toBe("challenge")
    expect(json.timings?.[0]).toMatchObject({ status: "needs-js", reason: "cloudflare-challenge" })
  })

  test("without it, a needs-js page is still an error", async () => {
    const { status, json } = await post({ url: `${base}/widget`, maxTier: 1 })
    expect(status).toBe(500)
    expect(json.statusCode).toBeUndefined()
  })

  test("without it, the refusal is still an error", async () => {
    const { status, json } = await post({ url: `${base}/refuse`, maxTier: 1 })
    expect(status).toBe(500)
    expect(json.statusCode).toBeUndefined()
  })

  test("needs maxTier 1", async () => {
    expect((await post({ url: `${base}/refuse`, returnRefusals: true })).status).toBe(400)
  })
})
