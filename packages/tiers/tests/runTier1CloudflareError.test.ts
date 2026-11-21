import { describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { isCloudflareErrorPage, isCloudflarePage } from "../src/utils/detect"
import { withFetch } from "./helpers/fetch"

// The shape of Cloudflare's error pages (cdn-cgi/styles/cf.errors.css), cut down.
const errorPage = (title: string, code: string, extra = "") => `<!DOCTYPE html>
<html lang="en-US"><head><title>${title}</title>
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />${extra}</head>
<body><div id="cf-wrapper"><div id="cf-error-details" class="p-0">
<header><h1><span class="inline-block">${title.split(" | ")[0]}</span><span class="code-label">Error code ${code}</span></h1></header>
<section><p>The site owner may have set restrictions that prevent you from accessing the site.</p></section>
<div class="cf-error-footer">Cloudflare Ray ID: <strong>8f0000000000000a</strong> &bull; Performance &amp; security by <a href="https://www.cloudflare.com/5xx-error-landing">Cloudflare</a></div>
</div></div></body></html>`

const DNS_ERROR = errorPage("DNS resolution error | careers.example.test | Cloudflare", "1001")
const SSL_525 = errorPage("example.test | 525: SSL handshake failed", "525")
const ORIGIN_DNS = errorPage("Origin DNS error | jobs.example.test | Cloudflare", "1016")
const PHISHING = errorPage("Suspected Phishing | Cloudflare", "1020")

const html = (body: string, status: number, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8", server: "cloudflare", ...headers },
  })

describe("isCloudflareErrorPage", () => {
  test("Cloudflare's error pages are error pages, though isCloudflarePage still matches them", () => {
    for (const [page, status] of [
      [DNS_ERROR, 409],
      [SSL_525, 525],
      [ORIGIN_DNS, 530],
      [PHISHING, 403],
    ] as const) {
      expect(isCloudflarePage(page, {})).toBe(true)
      expect(isCloudflareErrorPage(page, {}, status)).toBe(true)
    }
  })

  test("not on a 2xx, nor with cf-mitigated, a challenge title, a challenge script or a widget", () => {
    expect(isCloudflareErrorPage(DNS_ERROR, {}, 200)).toBe(false)
    expect(isCloudflareErrorPage(DNS_ERROR, { "cf-mitigated": "challenge" }, 403)).toBe(false)
    expect(isCloudflareErrorPage(errorPage("Just a moment...", "1001"), {}, 403)).toBe(false)
    const script = '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script>'
    expect(isCloudflareErrorPage(errorPage("Example", "1001", script), {}, 403)).toBe(false)
    const widget = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
    expect(isCloudflareErrorPage(errorPage("Example", "1001", widget), {}, 403)).toBe(false)
  })

  test("not when cf-error-details is only inside a template", () => {
    expect(isCloudflareErrorPage('<template><div id="cf-error-details"></div></template>', {}, 409)).toBe(false)
  })
})

describe("Tier 1 on Cloudflare's error pages", () => {
  for (const [name, page, status] of [
    ["409 DNS resolution error", DNS_ERROR, 409],
    ["525 SSL handshake failed", SSL_525, 525],
    ["530 origin DNS error", ORIGIN_DNS, 530],
  ] as const) {
    test(`${name}: the site's answer, with its status and page`, async () => {
      await withFetch(html(page, status), async () => {
        const result = await runTier1("https://careers.example.test/")
        expect(result.status).toBe("success")
        expect(result.statusCode).toBe(status)
        expect(result.html).toContain("cf-error-details")
      })
    })
  }

  test("a 403 Suspected Phishing page is a refusal, not a challenge", async () => {
    await withFetch(html(PHISHING, 403), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("blocked")
      expect(result.reason).toBe("http-403")
    })
  })

  test("a real challenge still escalates", async () => {
    const challenge = errorPage("Just a moment...", "", "<script>window._cf_chl_opt={cvId:'3'}</script>")
    await withFetch(html(challenge, 403), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("cloudflare-challenge")
    })
  })
})
