import { sleep } from "../utils/deadline"
// reCAPTCHA v2 solver using the audio challenge channel.
//
// Flow:
//  1. Click the reCaptcha checkbox - with a real Chrome fingerprint and good IP,
//     Google's risk scoring often auto-passes at score ≥ 0.5 (green checkmark).
//  2. If a visual image challenge appears, switch to audio mode.
//  3. Download the audio MP3 from Google's servers.
//  4. Transcribe via speech-to-text (Google's free API or configured Whisper endpoint).
//     Note: Google's own reCaptcha audio is designed to be solvable by accessibility
//     tools, meaning their own STT model handles it well - we exploit this circularity.
//  5. Submit the digit string.
//
// reCaptcha v3: purely passive - no widget, no interaction. Real Chrome browsers
// with good behavioral patterns (no automation signals) score ≥ 0.7 automatically.

import type { FrameLocator, Page } from "patchright"
import { persistentBrowserWall } from "../utils/browserWall"
import { normaliseAudioAnswer, transcribeAudio } from "./stt"

const ANCHOR_IFRAME = 'iframe[src*="recaptcha"][src*="anchor"]'
const BFRAME_IFRAME = 'iframe[src*="recaptcha"][src*="bframe"]'
// Standard and Enterprise widgets both keep their response in a g-recaptcha-response field
// (a second widget on the page gets g-recaptcha-response-1, and so on).
const RESPONSE_FIELD = 'textarea[name^="g-recaptcha-response"], input[name^="g-recaptcha-response"]'

// How long an answer gets to show its outcome after Verify, how often it is read, and the cap
// on any single frame read. Each is further capped by the solver's remaining budget.
const VERIFY_WAIT_MS = 8_000
const VERIFY_POLL_MS = 400
const READ_MS = 1_000
// A solve that navigates (Google's /sorry submits its form) gets this long to load.
const NAVIGATION_SETTLE_MS = 10_000

export interface RecaptchaDeps {
  transcribe: typeof transcribeAudio
}

/** Settles with the work's value, or the fallback on failure or after `ms`. For reads with no timeout option. */
async function within<T>(work: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), Math.max(1, ms))
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function currentUrl(page: Page): string {
  try {
    return page.url()
  } catch {
    return ""
  }
}

function withoutHash(url: string): string {
  const hash = url.indexOf("#")
  return hash < 0 ? url : url.slice(0, hash)
}

/** Whether the page holds a live reCAPTCHA frame of this kind; undefined when its frames can't be listed. */
function hasFrame(page: Page, kind: "anchor" | "bframe"): boolean | undefined {
  try {
    const frames = page.frames()
    if (!Array.isArray(frames)) return undefined
    return frames.some((frame) => {
      if (frame.isDetached?.()) return false
      const url = frame.url()
      return url.includes("recaptcha") && url.includes(`/${kind}`)
    })
  } catch {
    return undefined
  }
}

interface ChallengeStart {
  url: string
  // The page was a wall (Google's /sorry, a WAF page) before the solve, as the browser tier judges it.
  wall: boolean
  // The widget's frames were visible through page.frames(), so their absence later means something.
  framesListed: boolean
}

type VerifyOutcome = "solved" | "rejected" | "closed" | "pending"

const REJECTED_TEXT = /multiple correct solutions|please try again|try again later|automated queries|network may be/i

/**
 * Reads the outcome of a submitted answer once. Success is any of: the page navigated away from
 * the challenge, the widget's frames are gone, the response token is filled, the checkbox is
 * checked, or the wall the solve began on is no longer detected. A challenge frame that closed
 * or emptied without one of those is "closed", never "solved".
 */
async function readVerifyOutcome(
  page: Page,
  anchor: FrameLocator,
  bframe: FrameLocator,
  start: ChallengeStart,
  ms: number,
): Promise<{ outcome: VerifyOutcome; why: string }> {
  const url = currentUrl(page)
  if (url && start.url && withoutHash(url) !== withoutHash(start.url)) return { outcome: "solved", why: "navigated" }

  const anchorLive = start.framesListed ? hasFrame(page, "anchor") : undefined
  const bframeLive = start.framesListed ? hasFrame(page, "bframe") : undefined
  if (anchorLive === false && bframeLive === false) return { outcome: "solved", why: "widget gone" }

  const token = await within(
    () =>
      page.evaluate(
        (selector) =>
          Array.from(document.querySelectorAll(selector)).some(
            (field) => ((field as HTMLTextAreaElement).value ?? "").trim().length > 20,
          ),
        RESPONSE_FIELD,
      ),
    ms,
    false,
  )
  if (token) return { outcome: "solved", why: "response token" }

  if (
    anchorLive !== false &&
    (await within(() => anchor.locator('#recaptcha-anchor[aria-checked="true"]').isVisible({ timeout: ms }), ms, false))
  )
    return { outcome: "solved", why: "checkbox checked" }

  if (start.wall) {
    const html = await within(() => page.content(), ms, "")
    if (html && !persistentBrowserWall(html, url, {}, 200, "none")) return { outcome: "solved", why: "wall cleared" }
  }

  if (bframeLive === false) return { outcome: "closed", why: "challenge frame gone" }
  const error = await within(
    () => bframe.locator(".rc-audiochallenge-error-message").innerText({ timeout: ms }),
    ms,
    "",
  )
  if (error.trim()) return { outcome: "rejected", why: error.trim().slice(0, 120) }
  const text = await within(() => bframe.locator("body").innerText({ timeout: ms }), ms, "")
  if (REJECTED_TEXT.test(text)) return { outcome: "rejected", why: text.slice(0, 120).replace(/\s+/g, " ") }
  if (!text.trim()) return { outcome: "closed", why: "challenge frame empty" }
  return { outcome: "pending", why: "challenge still open" }
}

/** Polls the answer's outcome until it is decided or the verify window (within the budget) ends. */
async function awaitVerifyOutcome(
  page: Page,
  anchor: FrameLocator,
  bframe: FrameLocator,
  start: ChallengeStart,
  deadline: number,
  signal: AbortSignal,
): Promise<{ outcome: VerifyOutcome; why: string }> {
  const until = Math.min(deadline, Date.now() + VERIFY_WAIT_MS)
  let last: { outcome: VerifyOutcome; why: string } = { outcome: "pending", why: "no reading" }
  let closedReads = 0
  while (Date.now() < until) {
    last = await readVerifyOutcome(page, anchor, bframe, start, Math.max(1, Math.min(READ_MS, until - Date.now())))
    if (last.outcome === "solved" || last.outcome === "rejected") return last
    // A frame that is gone or empty on two readings in a row has closed without a solve.
    closedReads = last.outcome === "closed" ? closedReads + 1 : 0
    if (closedReads >= 2) return last
    await sleep(Math.min(VERIFY_POLL_MS, Math.max(0, until - Date.now())), signal)
  }
  return last
}

/** After a solve, give a navigation the page started (a submitted form) time to load, within the budget. */
async function settleAfterSolve(page: Page, start: ChallengeStart, deadline: number): Promise<void> {
  const ms = () => Math.max(1, Math.min(NAVIGATION_SETTLE_MS, deadline - Date.now()))
  if (start.wall && withoutHash(currentUrl(page)) === withoutHash(start.url)) {
    await within(
      () => page.waitForURL((next) => withoutHash(next.toString()) !== withoutHash(start.url), { timeout: ms() }),
      ms(),
      undefined,
    )
  }
  await within(() => page.waitForLoadState("domcontentloaded", { timeout: ms() }), ms(), undefined)
}

export async function solveRecaptchaV2(
  page: Page,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  deps: RecaptchaDeps = { transcribe: transcribeAudio },
): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false
  signal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))])
    : AbortSignal.timeout(Math.max(1, timeoutMs))
  const deadline = Date.now() + timeoutMs
  const budget = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()))

  try {
    // Step 1: wait for the anchor iframe
    // Use .first() - sites like nopecha also embed an invisible reCAPTCHA alongside the demo
    // widget, so the selector can match 2 elements (strict mode violation without .first())
    const hasAnchor = await page
      .waitForSelector(ANCHOR_IFRAME, { timeout: Math.max(1, Math.min(8000, deadline - Date.now())) })
      .then(() => true)
      .catch(() => false)
    if (!hasAnchor) return false
    const anchor = page.frameLocator(ANCHOR_IFRAME).first()
    const startUrl = currentUrl(page)
    const start: ChallengeStart = {
      url: startUrl,
      wall: Boolean(
        persistentBrowserWall(await within(() => page.content(), budget(2000), ""), startUrl, {}, 200, "none"),
      ),
      framesListed: hasFrame(page, "anchor") === true,
    }

    // Step 2: click the checkbox - force:true handles widgets inside hidden tab containers
    await anchor
      .locator("#recaptcha-anchor")
      .click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())), force: true })
    console.log("[recaptcha] clicked checkbox")

    // Return as soon as the checkbox passes; retain the full risk-scoring window.
    const autoPassed = await anchor
      .locator('#recaptcha-anchor[aria-checked="true"]')
      .waitFor({ state: "visible", timeout: Math.max(1, Math.min(2500, deadline - Date.now())) })
      .then(() => true)
      .catch(() => false)
    if (autoPassed) {
      console.log("[recaptcha] auto-passed")
      await settleAfterSolve(page, start, deadline)
      return true
    }

    // Step 3: challenge appeared - switch to audio mode
    const hasBframe = await page
      .waitForSelector(BFRAME_IFRAME, { timeout: Math.max(1, Math.min(8000, deadline - Date.now())) })
      .then(() => true)
      .catch(() => false)
    if (!hasBframe) {
      console.log("[recaptcha] bframe not found")
      return false
    }
    const bframe = page.frameLocator(BFRAME_IFRAME).first()

    // Log bframe content summary for debugging
    const bframeText = await bframe
      .locator("body")
      .innerText({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())) })
      .catch(() => "")
    console.log("[recaptcha] bframe text snippet:", bframeText.slice(0, 120).replace(/\s+/g, " "))

    const audioBtn = bframe.locator("#recaptcha-audio-button")
    const isAudioVisible = await audioBtn
      .isVisible({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
      .catch(() => false)
    if (!isAudioVisible) {
      // Check if image challenge is showing - means audio tab exists but needs click
      const hasImageChallenge = await bframe
        .locator(".rc-imageselect, #rc-imageselect")
        .isVisible({ timeout: Math.max(1, Math.min(2000, deadline - Date.now())) })
        .catch(() => false)
      if (hasImageChallenge) {
        console.log("[recaptcha] image challenge visible - attempting audio button click anyway")
        await audioBtn
          .click({ timeout: Math.max(1, Math.min(3000, deadline - Date.now())), force: true })
          .catch(() => {})
        await sleep(2000, signal)
        const nowVisible = await audioBtn
          .isVisible({ timeout: Math.max(1, Math.min(2000, deadline - Date.now())) })
          .catch(() => false)
        if (!nowVisible) {
          console.log("[recaptcha] audio button not accessible (image-only challenge or risk score too low)")
          return false
        }
      } else {
        console.log("[recaptcha] audio button not visible, no image challenge either")
        return false
      }
    }
    await audioBtn.click({ timeout: Math.max(1, Math.min(5000, deadline - Date.now())) })
    console.log("[recaptcha] switched to audio challenge")

    // Step 4: transcribe and submit (retry up to 3 times with fresh audio). Every frame read
    // here is bounded: after Verify the challenge frame can empty or detach, and a read with
    // no timeout of its own would otherwise wait out the whole request.
    let attempt = 0
    while (Date.now() < deadline && attempt < 3) {
      attempt++

      // The challenge closed since the last answer: decide from the page, don't wait on it.
      if (start.framesListed && hasFrame(page, "bframe") === false) {
        const closed = await readVerifyOutcome(page, anchor, bframe, start, budget(READ_MS))
        console.log(`[recaptcha] challenge frame gone: ${closed.outcome} (${closed.why})`)
        if (closed.outcome === "solved") {
          await settleAfterSolve(page, start, deadline)
          return true
        }
        return false
      }

      // Wait for audio source element to appear (loads after the bframe transitions).
      // If this times out, Google may have blocked the audio challenge for this IP.
      const hasAudioSrc = await bframe
        .locator("#audio-source, audio")
        .first()
        .waitFor({ timeout: budget(10_000) })
        .then(() => true)
        .catch(() => false)
      if (!hasAudioSrc) {
        const bframeText2 = await within(
          () => bframe.locator("body").innerText({ timeout: budget(READ_MS) }),
          budget(READ_MS),
          "",
        )
        console.log("[recaptcha] audio element not found; bframe:", bframeText2.slice(0, 120).replace(/\s+/g, " "))
        if (/automated queries|try again|network may be/i.test(bframeText2)) {
          console.log("[recaptcha] blocked by Google - audio challenge requires residential proxy")
          return false
        }
        const outcome = await readVerifyOutcome(page, anchor, bframe, start, budget(READ_MS))
        if (outcome.outcome === "solved") {
          console.log(`[recaptcha] solved (${outcome.why})`)
          await settleAfterSolve(page, start, deadline)
          return true
        }
        if (outcome.outcome === "closed") {
          console.log(`[recaptcha] challenge closed without a solve (${outcome.why})`)
          return false
        }
      }

      // Small wait after audio element appears - src may be set asynchronously
      await sleep(1500, signal)

      // Get audio URL via JS property (getAttribute can miss dynamically-set src)
      const rawHref =
        (await bframe
          .locator("#audio-source")
          .evaluate((el) => (el as HTMLAudioElement).src || el.getAttribute("src") || "", undefined, {
            timeout: budget(READ_MS),
          })
          .catch(() => "")) ||
        (await bframe
          .locator("audio")
          .first()
          .evaluate((el) => (el as HTMLAudioElement).src || "", undefined, { timeout: budget(READ_MS) })
          .catch(() => "")) ||
        (await bframe
          .locator(".rc-audiochallenge-tdownload-link")
          .getAttribute("href", { timeout: budget(READ_MS) })
          .catch(() => undefined)) ||
        ""

      // Reject blob: URLs - they're browser-internal and can't be fetched from outside
      const audioHref = rawHref && !rawHref.startsWith("blob:") ? rawHref : undefined
      console.log("[recaptcha] raw audio href:", rawHref?.slice(0, 100) ?? "none")

      console.log("[recaptcha] audio URL:", audioHref?.slice(0, 80) ?? "unavailable")

      if (!audioHref) {
        console.log("[recaptcha] audio URL not found, retry", attempt)
        await bframe
          .locator("#recaptcha-reload-button")
          .click({ timeout: budget(3000) })
          .catch(() => {})
        await sleep(2000, signal)
        continue
      }

      const absUrl = audioHref.startsWith("http") ? audioHref : `https://www.google.com${audioHref}`
      console.log("[recaptcha] transcribing audio (attempt", attempt, ")")

      const audioSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      const transcript = await deps.transcribe(absUrl, audioSignal, page, Math.max(1, deadline - Date.now()))
      const answer = transcript ? normaliseAudioAnswer(transcript) : undefined

      if (!answer) {
        console.log("[recaptcha] transcription empty, refreshing audio")
        await bframe
          .locator("#recaptcha-reload-button")
          .click({ timeout: budget(3000) })
          .catch(() => {})
        await sleep(1500, signal)
        continue
      }

      console.log("[recaptcha] answer:", answer)

      // Submit
      await bframe
        .locator("#audio-response")
        .fill(answer, { timeout: budget(3000) })
        .catch(() => {})
      await bframe
        .locator("#recaptcha-verify-button")
        .click({ timeout: budget(3000) })
        .catch(() => {})

      const verdict = await awaitVerifyOutcome(page, anchor, bframe, start, deadline, signal)
      console.log(`[recaptcha] after verify: ${verdict.outcome} (${verdict.why})`)
      if (verdict.outcome === "solved") {
        console.log("[recaptcha] solved via audio ✓")
        await settleAfterSolve(page, start, deadline)
        return true
      }
      if (verdict.outcome === "closed") return false

      // Wrong answer - get a new challenge
      await bframe
        .locator("#recaptcha-reload-button")
        .click({ timeout: budget(3000) })
        .catch(() => {})
      await sleep(1500, signal)
    }

    return false
  } catch (err) {
    console.log("[recaptcha] solver error:", err instanceof Error ? err.message : err)
    return false
  }
}

export async function hasRecaptchaV2(page: Page, timeout = 2000): Promise<boolean> {
  // Use state: 'attached' - the iframe may be present but inside a display:none container
  // (nopecha shows all difficulty tabs in DOM, hides inactive ones with CSS).
  // The solver uses force:true to interact through hidden containers.
  return page
    .waitForSelector(ANCHOR_IFRAME, { timeout, state: "attached" })
    .then(() => true)
    .catch(() => false)
}
