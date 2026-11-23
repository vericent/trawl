import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type OrchestratorDeps, ScrapeError, scrape } from "../src/orchestrator"
import { setProxyEnvironment } from "./helpers/proxy"

// A forward proxy that can't reach anything, as Oxylabs' Squid answered for a dead host (11-20):
// 503, its own page, X-Squid-Error. And one that passes a site's own 503 through.
let squid: ReturnType<typeof Bun.serve>
let site: ReturnType<typeof Bun.serve>
beforeAll(() => {
  squid = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response("<title>ERROR: The requested URL could not be retrieved</title>", {
        status: 503,
        headers: { server: "squid", "x-squid-error": "ERR_CONNECT_FAIL 110", "content-type": "text/html" },
      }),
  })
  site = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response("<html><body>down for maintenance</body></html>", {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
  })
})
afterAll(() => {
  squid.stop(true)
  site.stop(true)
})
let restore = () => {}
afterEach(() => {
  restore()
  restore = () => {}
})

let browsers = 0
const deps = (): OrchestratorDeps => ({
  acquireBrowser: async () => {
    browsers++
    throw new Error("no browser in this test")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

describe("a proxy's own error page through the environment proxy", () => {
  test("is a proxy failure, not the site's 503, and isn't escalated to a browser", async () => {
    restore = setProxyEnvironment({ HTTP_PROXY: `http://127.0.0.1:${squid.port}` })
    browsers = 0
    const err = await scrape({ url: "http://dead.example/", maxTier: 3 }, deps()).catch((e) => e)
    expect(err).toBeInstanceOf(ScrapeError)
    expect(String(err.message)).toContain("proxy-connection-failed")
    expect(browsers).toBe(0)
  })

  test("a site's own 503 still comes back as the site's", async () => {
    restore = setProxyEnvironment({ NO_PROXY: "127.0.0.1" })
    const res = await scrape({ url: `http://127.0.0.1:${site.port}/`, maxTier: 1 }, deps()).catch((e) => e)
    // not a proxy failure: whatever tier 1 makes of a 503 page, it isn't called the proxy's
    expect(String(res?.message ?? "")).not.toContain("proxy-connection-failed")
  })
})
