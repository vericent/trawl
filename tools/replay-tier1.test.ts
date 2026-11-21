import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { tier1Transport } from "../packages/tiers/src/utils/tier1Transport"
import {
  type CapturedPage,
  capturedPages,
  captureFiles,
  jsonLines,
  offlineFetch,
  parseArgs,
  parseCaptureLine,
  replayHeaders,
  replayPage,
  utf8ContentType,
} from "./replay-tier1"

const page = (over: Partial<CapturedPage> = {}): CapturedPage => ({
  kind: "page",
  domain: "example.test",
  n: 0,
  root: true,
  url: "https://example.test/",
  finalUrl: "https://example.test/",
  status: 200,
  contentType: "text/html",
  headers: [["content-type", "text/html; charset=UTF-8"]],
  body: "<html><head><title>Example</title></head><body><h1>Example</h1><p>Real words.</p></body></html>",
  bodyCut: false,
  ...over,
})

describe("parseCaptureLine", () => {
  test("reads a page line, keeping every header pair", () => {
    const line = JSON.stringify({
      kind: "page",
      domain: "cnspharma.com",
      n: 1,
      root: false,
      url: "https://cnspharma.com/careers",
      final_url: "https://cnspharma.com/careers/",
      status: 200,
      content_type: "text/html",
      headers: [
        ["content-type", "text/html; charset=UTF-8"],
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
        ["broken"],
      ],
      body: "<html></html>",
      body_bytes: 13,
      body_truncated: false,
      body_cut: false,
      elapsed_ms: 3076,
    })
    const got = parseCaptureLine(line)
    expect(got).toMatchObject({
      domain: "cnspharma.com",
      n: 1,
      root: false,
      finalUrl: "https://cnspharma.com/careers/",
      status: 200,
      bodyBytes: 13,
      bodyCut: false,
    })
    expect(got?.headers).toEqual([
      ["content-type", "text/html; charset=UTF-8"],
      ["set-cookie", "a=1; Path=/"],
      ["set-cookie", "b=2; Path=/"],
    ])
  })

  test("skips domain records and blank lines", () => {
    expect(parseCaptureLine(JSON.stringify({ kind: "domain", domain: "x.test", discovery: "ats" }))).toBeUndefined()
    expect(parseCaptureLine("  ")).toBeUndefined()
  })

  test("falls back to the URL when there is no final URL, and marks a cut body", () => {
    const got = parseCaptureLine(
      JSON.stringify({ kind: "page", domain: "x.test", url: "https://x.test/", status: 404, body_cut: true }),
    )
    expect(got).toMatchObject({ finalUrl: "https://x.test/", body: "", headers: [], bodyCut: true, root: false })
  })

  test("refuses a page line with no URL", () => {
    expect(() => parseCaptureLine(JSON.stringify({ kind: "page", domain: "x.test", status: 200 }))).toThrow()
  })
})

describe("replayHeaders", () => {
  test("drops the wire's encoding and length, keeps each Set-Cookie, says UTF-8", () => {
    const headers = replayHeaders([
      ["Content-Type", "text/html; charset=ISO-8859-1"],
      ["Content-Encoding", "br"],
      ["content-length", "1234"],
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
      ["server", "cloudflare"],
    ])
    expect(headers.get("content-encoding")).toBeNull()
    expect(headers.get("content-length")).toBeNull()
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(headers.getSetCookie()).toEqual(["a=1", "b=2"])
    expect(headers.get("server")).toBe("cloudflare")
  })

  test("gives a value with characters past U+00FF back as its bytes", () => {
    const headers = replayHeaders([["permissions-policy", "accelerometer=()\u201a autoplay=(self)"]])
    expect(headers.get("permissions-policy")).toBe("accelerometer=()\u00e2\u0080\u009a autoplay=(self)")
  })

  test("leaves a content type without a charset alone", () => {
    expect(utf8ContentType("text/html")).toBe("text/html")
    expect(utf8ContentType('text/html; charset="windows-1252"; x=1')).toBe("text/html; charset=utf-8; x=1")
  })
})

describe("offlineFetch", () => {
  test("answers the page's own URLs, with the final URL as the response's", async () => {
    const misses: string[] = []
    const fetch = offlineFetch(page({ finalUrl: "https://example.test/home" }), misses)
    const res = await fetch("https://example.test/", {} as never)
    expect(res.status).toBe(200)
    expect(res.url).toBe("https://example.test/home")
    expect(await res.text()).toContain("Real words.")
    expect(misses).toEqual([])
  })

  test("throws for any other URL and records it", async () => {
    const misses: string[] = []
    const fetch = offlineFetch(page(), misses)
    await expect(fetch("https://elsewhere.test/api.json", {} as never)).rejects.toThrow(/not in the capture/)
    expect(misses).toEqual(["https://elsewhere.test/api.json"])
  })
})

describe("replayPage", () => {
  test("an ordinary page passes, and its html is the body", async () => {
    const original = tier1Transport.fetch
    const got = await replayPage(page())
    expect(tier1Transport.fetch).toBe(original)
    expect(got.verdict).toEqual({ status: "success", statusCode: 200 })
    expect(got.shell.status).toBe("success")
    expect(got.htmlSha256).toBe(got.bodySha256)
    expect(got.offlineMisses).toEqual([])
  })

  test("a 404 passes with its status", async () => {
    const got = await replayPage(page({ status: 404 }))
    expect(got.verdict).toEqual({ status: "success", statusCode: 404 })
  })

  test("a 403 is a refusal", async () => {
    const got = await replayPage(page({ status: 403, body: "<html><body>Forbidden</body></html>" }))
    expect(got.verdict).toMatchObject({ status: "blocked", reason: "http-403", statusCode: 403 })
  })

  test("Cloudflare's challenge header escalates", async () => {
    const got = await replayPage(
      page({ status: 403, headers: [["cf-mitigated", "challenge"], ...page().headers], body: "<html></html>" }),
    )
    expect(got.verdict).toMatchObject({ status: "needs-js", reason: "cloudflare-challenge" })
  })

  test("a reCAPTCHA v2 script on a page escalates as recaptcha-shell", async () => {
    const body = `<html><head><title>Jobs</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><p>Openings</p></body></html>`
    const got = await replayPage(page({ body }))
    expect(got.verdict).toMatchObject({ status: "needs-js", reason: "recaptcha-shell", challenge: "recaptcha" })
  })

  test("the session path judges the body even when the page sets a parent domain's cookie", async () => {
    const body = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
    const headers: [string, string][] = [...page().headers, ["set-cookie", "visitor=1; Domain=.example.test; Path=/"]]
    const got = await replayPage(
      page({ url: "https://www.example.test/", finalUrl: "https://www.example.test/", headers, body }),
    )
    expect(got.shell).toMatchObject({ status: "needs-js", reason: "javascript-shell" })
  })

  test("a JavaScript shell passes fresh and is caught only on the session path", async () => {
    const body = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`
    const got = await replayPage(page({ body }))
    expect(got.verdict.status).toBe("success")
    expect(got.shell).toMatchObject({ status: "needs-js", reason: "javascript-shell" })
  })
})

describe("files and arguments", () => {
  test("reads gzipped and plain capture files from a directory, pages only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-tier1-"))
    const lines = [
      JSON.stringify({ kind: "page", domain: "a.test", url: "https://a.test/", status: 200 }),
      JSON.stringify({ kind: "domain", domain: "a.test" }),
    ].join("\n")
    writeFileSync(join(dir, "pages-1.jsonl.gz"), gzipSync(lines))
    writeFileSync(
      join(dir, "pages-2.jsonl"),
      JSON.stringify({ kind: "page", domain: "b.test", url: "https://b.test/", status: 404 }),
    )
    writeFileSync(join(dir, "pages-1.jsonl.gz.json"), "{}")
    const files = captureFiles([dir])
    expect(files.map((f) => f.slice(dir.length + 1))).toEqual(["pages-1.jsonl.gz", "pages-2.jsonl"])
    const domains: string[] = []
    for (const file of files) for await (const p of capturedPages(file)) domains.push(p.domain)
    expect(domains).toEqual(["a.test", "b.test"])
  })

  test("splits lines at newlines only, not at a raw U+2028 inside a string", async () => {
    async function* chunks() {
      yield Buffer.from('{"a":"x\u2028y"}\n{"b":"')
      yield Buffer.from([0xe2, 0x80]) // a three-byte character cut between chunks
      yield Buffer.from([0xa9, 0x31, 0x22, 0x7d]) // the rest of U+2029, then 1"}
    }
    const lines: string[] = []
    for await (const line of jsonLines(chunks())) lines.push(line)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: "x\u2028y" }, { b: "\u20291" }])
  })

  test("parseArgs needs --out and an input, and checks --limit", () => {
    expect(parseArgs(["--out", "o.jsonl", "--limit", "5", "cap"])).toEqual({
      out: "o.jsonl",
      limit: 5,
      inputs: ["cap"],
    })
    expect(() => parseArgs(["cap"])).toThrow(/--out/)
    expect(() => parseArgs(["--out", "o.jsonl"])).toThrow(/capture/)
    expect(() => parseArgs(["--out", "o", "--limit", "0", "cap"])).toThrow(/--limit/)
    expect(() => parseArgs(["--out", "o", "--bogus", "cap"])).toThrow(/unknown/)
  })
})
