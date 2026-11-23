import { expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { HttpSessionCookies } from "../src/utils/httpSessionCookies"
import { withFetch } from "./helpers/fetch"

test("a javascript-shell verdict keeps the answer's status, headers and bytes, for returnRefusals", async () => {
  const shell =
    '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>'
  const response = new Response(shell, { headers: { "content-type": "text/html", "x-test": "kept" } })
  await withFetch(response, async () => {
    const result = await runTier1(
      "https://example.test/",
      undefined,
      "GET",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      new HttpSessionCookies("https://example.test", []),
    )
    expect(result).toMatchObject({ status: "needs-js", reason: "javascript-shell", statusCode: 200 })
    expect(result.responseHeaders?.["x-test"]).toBe("kept")
    expect(new TextDecoder().decode(result.body)).toBe(shell)
  })
})
