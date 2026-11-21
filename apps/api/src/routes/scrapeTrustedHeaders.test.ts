import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import { scrapeRoute } from "./scrape"

// A local upstream that echoes the request's headers; /hop redirects to another origin's echo.
let echo: ReturnType<typeof Bun.serve>
let other: ReturnType<typeof Bun.serve>
let base = ""
const echoHeaders = (req: Request) => Response.json(Object.fromEntries(req.headers))

beforeAll(() => {
  other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: echoHeaders })
  echo = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/hop")
        return new Response(null, { status: 302, headers: { location: `http://localhost:${other.port}/` } })
      return echoHeaders(req)
    },
  })
  base = `http://127.0.0.1:${echo.port}`
})
afterAll(() => {
  echo.stop(true)
  other.stop(true)
})

let saved = 0
const deps = (): OrchestratorDeps => ({
  acquireBrowser: async () => {
    throw new Error("no browser in this test")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {
    saved++
  },
  invalidateSession: async () => {},
})

const SENT = {
  Cookie: "sid=abc; csrf=1",
  Authorization: "Bearer t",
  "User-Agent": "careers/1",
  "X-Csrf-Token": "tok",
}

const seen = async (trusted: boolean, path = "/") => {
  const res = await scrapeRoute(deps, () => ({}), undefined, trusted).handle(
    new Request("http://localhost/scrape", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}${path}`, maxTier: 1, headers: SENT }),
    }),
  )
  const json = (await res.json()) as { html: string; tier: number }
  return { status: res.status, tier: json.tier, headers: JSON.parse(json.html) as Record<string, string> }
}

describe("/scrape trusted headers", () => {
  test("off (the default): Cookie, Authorization and User-Agent are dropped", async () => {
    const { status, headers } = await seen(false)
    expect(status).toBe(200)
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers["user-agent"]).not.toBe("careers/1")
    expect(headers["x-csrf-token"]).toBe("tok")
  })

  test("on: they reach the site at tier 1, and nothing is saved to the clearance store", async () => {
    saved = 0
    const { status, tier, headers } = await seen(true)
    expect(status).toBe(200)
    expect(tier).toBe(1)
    expect(headers.cookie).toBe("sid=abc; csrf=1")
    expect(headers.authorization).toBe("Bearer t")
    expect(headers["user-agent"]).toBe("careers/1")
    expect(headers["x-csrf-token"]).toBe("tok")
    expect(saved).toBe(0)
  })

  test("on: a redirect to another origin still drops Cookie and Authorization", async () => {
    const { status, headers } = await seen(true, "/hop")
    expect(status).toBe(200)
    expect(headers.host).toBe(`localhost:${other.port}`)
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
  })
})
