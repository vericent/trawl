import { describe, expect, test } from "bun:test"
import { runTier1 } from "../src/tiers/1"
import { hasPageSubstance } from "../src/utils/detect"
import { withFetch } from "./helpers/fetch"

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })

const links = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join(" ")
const prose = (chars: number) =>
  `<p>${"We are hiring engineers and technicians in three plants. ".repeat(Math.ceil(chars / 56))}</p>`

const page = (title: string, widget: string, nLinks = 25, chars = 1_400) =>
  `<html><head><title>${title}</title>${widget}</head><body><nav>${links(nLinks)}</nav>${prose(chars)}<form><div class="g-recaptcha" data-sitekey="k"></div></form></body></html>`

const RECAPTCHA = '<script src="https://www.google.com/recaptcha/api.js" async defer></script>'
const TURNSTILE = '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
const HCAPTCHA = '<script src="https://hcaptcha.com/1/api.js"></script>'

describe("hasPageSubstance (Recon's richly_rendered bar)", () => {
  test("a titled page with 8 links and 400 characters of text has substance", () => {
    expect(hasPageSubstance(page("Careers | Example", "", 8, 420))).toBe(true)
  })

  test("over 20 KB with 15 links has substance whatever its text", () => {
    const big = `<html><head><title>Example</title><style>${"x".repeat(21_000)}</style></head><body>${links(15)}</body></html>`
    expect(hasPageSubstance(big)).toBe(true)
  })

  test("too few links, too little text, no title, or a challenge's title: no substance", () => {
    expect(hasPageSubstance(page("Careers", "", 7, 1_000))).toBe(false)
    expect(hasPageSubstance(page("Careers", "", 10, 200))).toBe(false)
    expect(hasPageSubstance(page("", "", 25, 1_000))).toBe(false)
    expect(hasPageSubstance(page("Just a moment...", "", 25, 1_000))).toBe(false)
    expect(hasPageSubstance(page("Security check", "", 25, 1_000))).toBe(false)
  })

  test("script text doesn't count as text", () => {
    const scripted = `<html><head><title>App</title></head><body>${links(10)}<script>${"var a=1;".repeat(200)}</script></body></html>`
    expect(hasPageSubstance(scripted)).toBe(false)
  })

  test("repeated links count once", () => {
    const same = `<html><head><title>Example</title></head><body>${'<a href="/x">x</a>'.repeat(20)}${prose(800)}</body></html>`
    expect(hasPageSubstance(same)).toBe(false)
  })
})

describe("Tier 1: a captcha widget on a page with substance is the page", () => {
  for (const [name, widget] of [
    ["reCAPTCHA", RECAPTCHA],
    ["Turnstile", TURNSTILE],
    ["hCaptcha", HCAPTCHA],
  ] as const) {
    test(`${name} on a careers page with a form: success, with the page`, async () => {
      await withFetch(html(page("Careers | Example", widget)), async () => {
        const result = await runTier1("https://example.test/careers")
        expect(result.status).toBe("success")
        expect(result.html).toContain("We are hiring")
      })
    })
  }

  test("on a 404 page with the site's footer form: success, with the 404", async () => {
    await withFetch(html(page("Page not found - Example", RECAPTCHA), 404), async () => {
      const result = await runTier1("https://example.test/careers/jobs")
      expect(result.status).toBe("success")
      expect(result.statusCode).toBe(404)
    })
  })

  test("a thin page that is only the widget still escalates", async () => {
    const thin = `<html><head><title>Example</title>${RECAPTCHA}</head><body><div class="g-recaptcha" data-sitekey="k"></div></body></html>`
    await withFetch(html(thin), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("recaptcha-shell")
    })
  })

  test("a widget behind a challenge title still escalates", async () => {
    await withFetch(html(page("Security check", RECAPTCHA)), async () => {
      const result = await runTier1("https://example.test/")
      expect(result.status).toBe("needs-js")
      expect(result.reason).toBe("recaptcha-shell")
    })
  })
})
