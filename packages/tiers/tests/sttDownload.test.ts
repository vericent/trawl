import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { newFreshContext } from "@trawl/browser"
import { normaliseAudioAnswer } from "../src/solvers/stt"
import { setProxyEnvironment, startTestProxy, type TestProxy } from "./helpers/proxy"

// The audio challenge's download must leave the way the browser does: through the page's
// own proxy when its context has one, otherwise through the environment proxy (as Bun's
// fetch and the browser use it), and direct only when neither applies. No test leaves
// the machine: `.invalid` hosts are answered by the local proxy itself.

let proxy: TestProxy
let tunnel: TestProxy
let origin: ReturnType<typeof Bun.serve>
const originPaths: string[] = []
beforeAll(async () => {
  // The audio's stand-in origin, reachable only through `tunnel`.
  origin = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      originPaths.push(new URL(request.url).pathname + new URL(request.url).search)
      return new Response("audio via the environment proxy", { headers: { "content-type": "audio/mpeg" } })
    },
  })
  proxy = await startTestProxy("env-proxy")
  tunnel = await startTestProxy("tunnel", Number(origin.port))
})
afterAll(async () => {
  await proxy.close()
  await tunnel.close()
  await origin.stop(true)
})

const realFetch = globalThis.fetch
const savedSttUrl = process.env.STT_URL
let restoreEnvironment = () => {}
let logs: string[] = []
let logSpy: ReturnType<typeof spyOn> | undefined
beforeEach(() => {
  proxy.seen.length = 0
  tunnel.seen.length = 0
  originPaths.length = 0
  logs = []
  logSpy = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "))
  })
})
afterEach(() => {
  logSpy?.mockRestore()
  restoreEnvironment()
  restoreEnvironment = () => {}
  globalThis.fetch = realFetch
  if (savedSttUrl === undefined) delete process.env.STT_URL
  else process.env.STT_URL = savedSttUrl
})

// STT_URL is read when the module loads, so each case imports a fresh copy.
let copy = 0
async function loadStt() {
  process.env.STT_URL = "http://stt.test/v1/audio/transcriptions"
  return (await import(`../src/solvers/stt?download=${++copy}`)) as typeof import("../src/solvers/stt")
}

// Records what reached the recogniser, standing in for STT_URL.
function captureRecogniser(reply: string) {
  const seen: { calls: number; audio?: string } = { calls: 0 }
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.calls++
    seen.audio = await ((init?.body as FormData | undefined)?.get("file") as Blob | undefined)?.text()
    return new Response(reply)
  }) as typeof fetch
  return seen
}

// A page whose own `page.request` answers with `body`, recording each URL it was asked for.
function fakePage(context: object, body = "via page.request", status = 200) {
  const asked: string[] = []
  const page = {
    context: () => context,
    request: {
      get: async (url: string) => {
        asked.push(url)
        return {
          body: async () => Buffer.from(body),
          status: () => status,
          headers: () => ({ "content-type": "audio/mpeg" }),
          dispose: async () => {},
        }
      },
    },
  }
  return { page: page as never, asked }
}

const plainContext = () => ({ cookies: async () => [] })

async function proxiedContext(proxyUrl: string) {
  const context = { ...plainContext(), addInitScript: async () => {} }
  const browser = { newContext: async () => context }
  return (await newFreshContext(browser, { proxy: proxyUrl })) as object
}

describe("reCAPTCHA audio download", () => {
  test("goes through the environment proxy when the page's context has none", async () => {
    const stt = await loadStt()
    restoreEnvironment = setProxyEnvironment({ HTTP_PROXY: tunnel.url })
    const recogniser = captureRecogniser("seven four")
    const { page, asked } = fakePage(plainContext())

    const text = await stt.transcribeAudio("http://audio.invalid/payload?k=1", undefined, page, 5000)

    // Playwright tunnels even plain HTTP through the proxy with CONNECT.
    expect(tunnel.seen).toEqual(["CONNECT audio.invalid:80"])
    expect(originPaths).toEqual(["/payload?k=1"])
    expect(asked).toEqual([])
    expect(recogniser.audio).toBe("audio via the environment proxy")
    expect(text).toBe("seven four")
    expect(logs.some((line) => line.includes("audio download failed"))).toBe(false)
  })

  test("NO_PROXY keeps the download on the page's own request context", async () => {
    const stt = await loadStt()
    restoreEnvironment = setProxyEnvironment({ HTTP_PROXY: proxy.url, NO_PROXY: "audio.invalid" })
    const recogniser = captureRecogniser("ok")
    const { page, asked } = fakePage(plainContext())

    await stt.transcribeAudio("http://audio.invalid/payload", undefined, page, 5000)

    expect(proxy.seen).toEqual([])
    expect(asked).toEqual(["http://audio.invalid/payload"])
    expect(recogniser.audio).toBe("via page.request")
  })

  test("a context's own proxy wins over the environment proxy", async () => {
    const stt = await loadStt()
    restoreEnvironment = setProxyEnvironment({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url })
    const recogniser = captureRecogniser("ok")
    const { page, asked } = fakePage(await proxiedContext("http://page-proxy.invalid:3128"))

    await stt.transcribeAudio("https://audio.invalid/payload", undefined, page, 5000)

    expect(proxy.seen).toEqual([])
    expect(asked).toEqual(["https://audio.invalid/payload"])
    expect(recogniser.audio).toBe("via page.request")
  })

  test("a failed download is logged without credentials, and the recogniser is not called", async () => {
    const stt = await loadStt()
    // The local proxy refuses CONNECT, so an https download through it fails.
    const credentialed = proxy.url.replace("http://", "http://audio-user:audio-secret@")
    restoreEnvironment = setProxyEnvironment({ HTTPS_PROXY: credentialed })
    const recogniser = captureRecogniser("never")
    const { page } = fakePage(plainContext())

    expect(await stt.transcribeAudio("https://audio.invalid/payload", undefined, page, 5000)).toBeUndefined()

    expect(proxy.seen).toEqual(["CONNECT audio.invalid:443"])
    expect(recogniser.calls).toBe(0)
    const failure = logs.find((line) => line.includes("audio download failed"))
    expect(failure).toBeDefined()
    expect(logs.join("\n")).not.toContain("audio-secret")
    expect(logs.join("\n")).not.toContain("audio-user")
  })

  test("a download answered with an error status is logged with that status", async () => {
    const stt = await loadStt()
    restoreEnvironment = setProxyEnvironment({})
    const recogniser = captureRecogniser("never")
    const { page } = fakePage(plainContext(), "nope", 403)

    expect(await stt.transcribeAudio("https://audio.invalid/payload", undefined, page, 5000)).toBeUndefined()

    expect(recogniser.calls).toBe(0)
    expect(logs).toContain("[stt] audio download failed: 403")
  })
})

describe("reCAPTCHA audio answer", () => {
  test.each([
    ["7-4-2-9.", "7429"],
    ["7 4 2 9", "7 4 2 9"],
    ["the quick brown fox jumps over the lazy dog.", "the quick brown fox jumps over the lazy dog"],
    ["Target. Knowledge!", "target knowledge"],
    ["  well-known,   words?  ", "well known words"],
    ["Don't stop", "dont stop"],
    ["Café 12", "café 12"],
    ["...", ""],
  ])("%p becomes %p", (transcript, answer) => {
    expect(normaliseAudioAnswer(transcript)).toBe(answer)
  })
})
