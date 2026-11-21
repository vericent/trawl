import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { gunzipSync, gzipSync } from "node:zlib"
import type { OrchestratorDeps } from "@trawl/tiers"
import { scrapeRoute } from "./scrape"

// A local upstream: a gzipped sitemap served as a binary file, and the same XML served as text
// with Content-Encoding: gzip.
const XML = `<?xml version="1.0"?><urlset>${"<url><loc>https://example.com/a</loc></url>".repeat(200)}</urlset>`
let server: ReturnType<typeof Bun.serve>
let base = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === "/sitemap.xml.gz")
        return new Response(gzipSync(XML), { headers: { "content-type": "application/gzip" } })
      if (path === "/sitemap.xml")
        return new Response(gzipSync(XML), { headers: { "content-type": "text/xml", "content-encoding": "gzip" } })
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

const post = async (body: unknown) => {
  const res = await scrapeRoute(deps, () => ({})).handle(
    new Request("http://localhost/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe("/scrape body", () => {
  test("is left out by default; text still arrives in html", async () => {
    const { status, json } = await post({ url: `${base}/sitemap.xml`, maxTier: 1 })
    expect(status).toBe(200)
    expect(json.body).toBeUndefined()
    expect(json.bodyEncoding).toBeUndefined()
    expect(json.html).toBe(XML)
  })

  test("a binary file comes back base64 with includeBody, as the file itself", async () => {
    const { json } = await post({ url: `${base}/sitemap.xml.gz`, maxTier: 1, includeBody: true })
    expect(json.html).toBe("")
    expect(json.bodyEncoding).toBe("base64")
    const bytes = Buffer.from(json.body as string, "base64")
    expect(gunzipSync(bytes).toString()).toBe(XML)
  })

  test("Content-Encoding is undone in body", async () => {
    const { json } = await post({ url: `${base}/sitemap.xml`, maxTier: 1, includeBody: true })
    expect(Buffer.from(json.body as string, "base64").toString()).toBe(XML)
    expect((json.responseHeaders as Record<string, string>)["content-encoding"]).toBe("gzip")
  })

  test("includeBody must be a boolean", async () => {
    const { status } = await post({ url: `${base}/sitemap.xml`, includeBody: "yes" })
    expect(status).toBe(400)
  })
})
