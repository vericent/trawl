import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { firefoxHeaderCase, headerName } from "../src/utils/headerCase"

// The request as it reaches the wire: a raw TCP server keeps the bytes Bun's HTTP/1.1 client sent.
let server: Bun.TCPSocketListener<undefined> | undefined
let lastRequest = ""

beforeAll(() => {
  server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        lastRequest += Buffer.from(data).toString("latin1")
        if (!lastRequest.includes("\r\n\r\n")) return
        const body = `<html><head><title>ok</title></head><body>${"x".repeat(2048)}</body></html>`
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        )
        socket.end()
      },
    },
  })
})

afterAll(() => server?.stop(true))

const headerLines = () =>
  lastRequest
    .split("\r\n\r\n")[0]
    .split("\r\n")
    .slice(1)
    .map((line) => line.slice(0, line.indexOf(":")))

describe("tier 1's header names on HTTP/1.1", () => {
  test("go out in Firefox's capitals, none in lower case", async () => {
    lastRequest = ""
    await runTier1(`http://127.0.0.1:${server?.port}/page`)
    const names = headerLines()
    for (const name of [
      "User-Agent",
      "Accept",
      "Accept-Language",
      "Accept-Encoding",
      "Upgrade-Insecure-Requests",
      "Sec-Fetch-Dest",
      "Sec-Fetch-Mode",
      "Sec-Fetch-Site",
      "Sec-Fetch-User",
      "Priority",
    ])
      expect(names).toContain(name)
    // 1.11-1.12 sent "sec-fetch-site", "sec-fetch-user" and "priority" as written: a mix no browser sends
    expect(names.filter((n) => n !== n.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()))).toEqual([])
  })

  test("a caller's header still replaces the default, whatever its case, once", async () => {
    lastRequest = ""
    await runTier1(`http://127.0.0.1:${server?.port}/page`, { "accept-language": "de-DE", "X-Custom": "1" })
    const lines = lastRequest.split("\r\n\r\n")[0].split("\r\n")
    expect(lines.filter((l) => l.toLowerCase().startsWith("accept-language:"))).toEqual(["Accept-Language: de-DE"])
    expect(lines).toContain("X-Custom: 1")
  })
})

describe("headerName", () => {
  test("spells names as Firefox does", () => {
    expect(headerName("sec-fetch-site")).toBe("Sec-Fetch-Site")
    expect(headerName("priority")).toBe("Priority")
    expect(headerName("user-agent")).toBe("User-Agent")
    expect(headerName("dnt")).toBe("DNT")
    expect(headerName("te")).toBe("TE")
  })

  test("keeps the values and every header", () => {
    expect(firefoxHeaderCase({ "sec-fetch-user": "?1", cookie: "a=b" })).toEqual({
      "Sec-Fetch-User": "?1",
      Cookie: "a=b",
    })
  })
})
