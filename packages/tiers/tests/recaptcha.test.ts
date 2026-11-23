import { describe, expect, test } from "bun:test"
import { solveRecaptchaV2 } from "../src/solvers/recaptcha"

test("reCAPTCHA auto-pass returns immediately after confirmed checkbox success", async () => {
  const clicks: string[] = []
  const page = {
    waitForSelector: async () => ({}),
    frameLocator: () => ({
      first() {
        return this
      },
      locator: (selector: string) => ({
        click: async () => {
          clicks.push(selector)
        },
        waitFor: async () => {},
        isVisible: async () => true,
      }),
    }),
  }
  const started = Date.now()
  expect(await solveRecaptchaV2(page as never, 4000)).toBe(true)
  expect(clicks).toEqual(["#recaptcha-anchor"])
  expect(Date.now() - started).toBeLessThan(1000)
})

// The audio path against a stand-in widget: an anchor frame and a challenge frame (bframe)
// whose reads honour their timeout the way Playwright's do, and wait forever without one,
// as a read on a frame that has gone does under the browser tier's request-long default.
// Nothing leaves the machine: the transcriber is injected.
type AfterVerify = "detach" | "navigate" | "token" | "reject"

const SORRY_URL = "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Djobs"
const RESULTS_URL = "https://www.google.com/search?q=jobs"
const AUDIO_URL = "https://www.google.com/recaptcha/enterprise/payload/audio.mp3?p=test"

function stalled<T>(options?: { timeout?: number }): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (options?.timeout) setTimeout(() => reject(new Error(`Timeout ${options.timeout}ms exceeded`)), options.timeout)
  })
}

function widget(afterVerify: AfterVerify) {
  const state = {
    url: SORRY_URL,
    bframeLive: true,
    anchorLive: true,
    token: "",
    error: "",
    answers: [] as string[],
    verifies: 0,
    unboundedReads: 0,
  }
  const verify = () => {
    state.verifies++
    if (afterVerify === "detach") state.bframeLive = false
    if (afterVerify === "navigate") {
      state.url = RESULTS_URL
      state.bframeLive = false
      state.anchorLive = false
    }
    if (afterVerify === "token") state.token = "03AFcWeA".padEnd(400, "x")
    if (afterVerify === "reject") state.error = "Multiple correct solutions required - please solve more."
  }
  const anchorLocator = (selector: string) => {
    const self = {
      first: () => self,
      click: async (options?: { timeout?: number }) => (state.anchorLive ? undefined : stalled(options)),
      // No auto-pass: the checkbox only goes green after a solve, which these cases don't show.
      waitFor: async () => {
        throw new Error("Timeout exceeded")
      },
      isVisible: async () => false,
      innerText: async (options?: { timeout?: number }) => {
        if (!options?.timeout) state.unboundedReads++
        return state.anchorLive ? "I'm not a robot" : stalled<string>(options)
      },
    }
    void selector
    return self
  }
  const bframeLocator = (selector: string) => {
    const live = <T>(value: () => T, options?: { timeout?: number }): Promise<T> => {
      if (!options?.timeout) state.unboundedReads++
      return state.bframeLive ? Promise.resolve(value()) : stalled<T>(options)
    }
    const self = {
      first: () => self,
      click: (options?: { timeout?: number }) =>
        live(() => {
          if (selector === "#recaptcha-verify-button") verify()
          if (selector === "#recaptcha-reload-button") state.error = ""
        }, options),
      fill: (value: string, options?: { timeout?: number }) => live(() => void state.answers.push(value), options),
      waitFor: (options?: { timeout?: number }) => live(() => undefined, options),
      isVisible: async () => state.bframeLive && selector === "#recaptcha-audio-button",
      innerText: (options?: { timeout?: number }) =>
        live(
          () =>
            selector === ".rc-audiochallenge-error-message"
              ? state.error
              : `Press PLAY and enter the words you hear ${state.error}`,
          options,
        ),
      evaluate: (_fn: unknown, _arg?: unknown, options?: { timeout?: number }) =>
        live(() => (selector === "#audio-source" ? AUDIO_URL : ""), options),
      getAttribute: (_name: string, options?: { timeout?: number }) => live(() => null, options),
    }
    return self
  }
  const frame = (url: string, isLive: () => boolean) => ({ url: () => url, isDetached: () => !isLive() })
  const page = {
    url: () => state.url,
    frames: () =>
      [
        { url: () => state.url, isDetached: () => false },
        frame("https://www.google.com/recaptcha/enterprise/anchor?k=test", () => state.anchorLive),
        frame("https://www.google.com/recaptcha/enterprise/bframe?k=test", () => state.bframeLive),
      ].filter((f) => !f.isDetached()),
    content: async () =>
      state.url === SORRY_URL
        ? '<html><body><form id="captcha-form"><div class="g-recaptcha" data-sitekey="test"></div></form></body></html>'
        : `<html><body>${"Jobs near Austin. ".repeat(20)}</body></html>`,
    evaluate: async () => state.token.length > 20,
    waitForSelector: async () => ({}),
    waitForURL: async () => {},
    waitForLoadState: async () => {},
    frameLocator: (selector: string) => {
      const locator = selector.includes("anchor") ? anchorLocator : bframeLocator
      const self = { first: () => self, locator }
      return self
    },
  }
  return { page, state }
}

const transcribe = async () => "and requires reliable level measurement."

describe("reCAPTCHA audio answer outcome", () => {
  test("a challenge frame that detaches after Verify ends the solve quickly, unsolved", async () => {
    const { page, state } = widget("detach")
    const started = Date.now()
    expect(await solveRecaptchaV2(page as never, 60_000, undefined, { transcribe })).toBe(false)
    expect(state.verifies).toBe(1)
    expect(state.answers).toEqual(["and requires reliable level measurement"])
    expect(state.unboundedReads).toBe(0)
    // The audio wait (1.5 s) plus two readings of the closed frame, nowhere near the 60 s budget.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("navigating away from the challenge after Verify counts as solved", async () => {
    const { page, state } = widget("navigate")
    const started = Date.now()
    expect(await solveRecaptchaV2(page as never, 60_000, undefined, { transcribe })).toBe(true)
    expect(state.verifies).toBe(1)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("a filled response token counts as solved", async () => {
    const { page, state } = widget("token")
    expect(await solveRecaptchaV2(page as never, 60_000, undefined, { transcribe })).toBe(true)
    expect(state.verifies).toBe(1)
    expect(state.url).toBe(SORRY_URL)
  })

  test("a challenge still open with an error message is not solved", async () => {
    const { page, state } = widget("reject")
    expect(await solveRecaptchaV2(page as never, 4_000, undefined, { transcribe })).toBe(false)
    expect(state.verifies).toBeGreaterThanOrEqual(1)
    expect(state.unboundedReads).toBe(0)
  }, 10_000)
})
