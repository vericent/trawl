// Speech-to-text for reCAPTCHA v2 audio challenge solving.
//
// Default (zero-cost, no key): uses Google's own free Speech Recognition endpoint.
// Google's reCAPTCHA audio is designed for screen-reader accessibility - their own
// STT transcribes it perfectly. We download the MP3, convert to FLAC via ffmpeg
// (ships in the Docker image), and POST to Google's endpoint. No billing, no signup.
// This is the same technique the open-source Buster accessibility extension uses.
//
// Optional (bring-your-own): set STT_URL to any Whisper-compatible HTTP server.
// Free local options (run in Docker alongside TRAWL):
//   whisper.cpp:            STT_URL=http://localhost:8080/inference
//   faster-whisper-server:  STT_URL=http://localhost:8000/v1/audio/transcriptions

import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import { contextProxy, newProxiedRequestContext } from "@trawl/browser"
import type { Page } from "patchright"
import { environmentProxy } from "../utils/envProxy"
import { runFfmpeg } from "./subprocess"

const STT_URL = process.env.STT_URL?.trim() ?? ""
const STT_KEY = process.env.STT_API_KEY ?? ""
// Model name sent to STT_URL. OpenAI-compatible servers that expose several recognisers
// choose one by this field, so it must be configurable rather than fixed at whisper-1.
const STT_MODEL = process.env.STT_MODEL?.trim() || "whisper-1"
// FFMPEG_PATH: full path to ffmpeg binary. Docker installs 'ffmpeg' via apt.
// On macOS with Playwright's bundled binary it's named 'ffmpeg-mac'; set this
// env var or create a symlink to make 'ffmpeg' resolve.

// Google's public Speech API key - used in Google's own demos and the Buster extension.
// Has been public since 2013. Google can't revoke it without breaking their own accessibility tooling.
const GOOGLE_STT =
  "https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"

export async function transcribeAudio(
  audioUrl: string,
  signal: AbortSignal | undefined,
  page: Page,
  timeoutMs: number,
): Promise<string | undefined> {
  // Audio URLs come from page markup; use the context's egress instead of a server-side fetch.
  // `page.request` follows only a context's own proxy option, never HTTPS_PROXY, so a context
  // without one would dial direct even where the browser itself leaves through the
  // environment proxy. Those downloads take the environment proxy explicitly.
  const download = async (headers: Record<string, string>) => {
    signal?.throwIfAborted()
    const context = page.context()
    const viaEnvironment = contextProxy(context) ? undefined : environmentProxy(audioUrl)
    const client = viaEnvironment
      ? await newProxiedRequestContext(viaEnvironment, await context.cookies(audioUrl))
      : page.request
    try {
      signal?.throwIfAborted()
      const response = await client.get(audioUrl, { headers, timeout: Math.max(1, timeoutMs) })
      try {
        signal?.throwIfAborted()
        return new Response(new Uint8Array(await response.body()), {
          status: response.status(),
          headers: response.headers(),
        })
      } finally {
        await response.dispose()
      }
    } catch (error) {
      throw new Error(`audio download failed: ${describeError(error)}`)
    } finally {
      if (client !== page.request) await client.dispose()
    }
  }
  return STT_URL ? transcribeWhisper(download, signal) : transcribeGoogle(download, signal)
}

// The first line of an error, with any URL credentials masked, so a log line can say why a
// download or recogniser call failed without printing a proxy's user name or password.
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split("\n")[0] ?? "").replace(/\/\/[^/@\s]*@/g, "//**@").slice(0, 200)
}

// For audio the page already delivered in memory (for example AWS WAF embeds it in the
// challenge JSON), so there is no URL to fetch. The extension of `filename` tells servers
// that sniff by name which container to expect.
export async function transcribeAudioBytes(
  bytes: Uint8Array,
  signal?: AbortSignal,
  filename = "audio.aac",
): Promise<string | undefined> {
  const download = async () => new Response(new Uint8Array(bytes))
  return STT_URL ? transcribeWhisper(download, signal, filename) : transcribeGoogle(download, signal)
}

type AudioDownload = (headers: Record<string, string>) => Promise<Response>

async function transcribeWhisper(
  download: AudioDownload,
  signal?: AbortSignal,
  filename = "audio.mp3",
): Promise<string | undefined> {
  try {
    const res = await download({ "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/149" })
    if (!res.ok) {
      console.log("[stt] audio download failed:", res.status)
      return
    }

    const form = new FormData()
    form.append("file", await res.blob(), filename)
    form.append("model", STT_MODEL)
    form.append("language", "en")
    form.append("response_format", "text")

    const headers: Record<string, string> = {}
    if (STT_KEY) headers.Authorization = `Bearer ${STT_KEY}`

    const sttRes = await fetch(STT_URL, { method: "POST", headers, body: form, signal })
    if (!sttRes.ok) {
      console.log("[stt] recogniser failed:", sttRes.status)
      return
    }
    const text = await sttRes.text()
    console.log("[stt] transcript:", JSON.stringify(text.slice(0, 200)))
    return clean(text)
  } catch (error) {
    console.log("[stt] error:", describeError(error))
    return
  }
}

// Converts MP3 → FLAC via ffmpeg, sends to Google's free Speech API.
// Tries 8000 Hz first (reCAPTCHA audio is typically low-bitrate), then 16000 Hz.
async function transcribeGoogle(download: AudioDownload, signal?: AbortSignal): Promise<string | undefined> {
  const id = randomUUID().slice(0, 8)
  const mp3 = `/tmp/trawl-${id}.mp3`
  const flac8 = `/tmp/trawl-${id}-8k.flac`
  const flac16 = `/tmp/trawl-${id}-16k.flac`
  try {
    const res = await download({
      // Use Firefox UA to match Camoufox - Google may serve different content by browser
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
      Referer: "https://www.google.com/recaptcha/api2/bframe",
      Accept: "audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,application/ogg;q=0.7,video/*;q=0.6,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.5",
    })
    if (!res.ok) {
      console.log("[stt] audio download failed:", res.status)
      return
    }
    const audioBytes = await res.arrayBuffer()
    console.log("[stt] audio downloaded:", audioBytes.byteLength, "bytes, type:", res.headers.get("content-type"))
    if (audioBytes.byteLength < 1000) {
      console.log("[stt] audio too small")
      return
    }
    await Bun.write(mp3, audioBytes)

    // Try both sample rates - reCAPTCHA audio varies (8kHz native, 16kHz after processing)
    for (const [rate, flac] of [
      [8000, flac8],
      [16000, flac16],
    ] as [number, string][]) {
      const ff = await runFfmpeg(
        ["-i", mp3, "-ar", String(rate), "-ac", "1", "-c:a", "flac", "-threads", "1", flac, "-y", "-loglevel", "error"],
        signal,
      )
      if (ff.exitCode !== 0) {
        console.log(`[stt] ffmpeg ${rate}Hz error:`, ff.stderr.toString().trim().slice(0, 120))
        continue
      }
      const flacData = await Bun.file(flac).arrayBuffer()
      console.log(`[stt] flac@${rate}Hz size:`, flacData.byteLength, "bytes")
      if (flacData.byteLength < 500) continue

      const sttRes = await fetch(`${GOOGLE_STT}`, {
        method: "POST",
        headers: { "Content-Type": `audio/x-flac; rate=${rate}` },
        body: flacData,
        signal,
      })
      if (!sttRes.ok) {
        console.log("[stt] Google STT failed:", sttRes.status)
        continue
      }

      const raw = await sttRes.text()
      console.log("[stt] raw response:", raw.slice(0, 300))

      for (const line of raw.split("\n").reverse()) {
        if (!line.startsWith("{")) continue
        try {
          const j = JSON.parse(line) as { result?: Array<{ alternative?: Array<{ transcript?: string }> }> }
          const t = j?.result?.[0]?.alternative?.[0]?.transcript
          if (t) {
            const cleaned = clean(t)
            console.log("[stt] raw transcript:", JSON.stringify(t), "→", JSON.stringify(cleaned))
            if (cleaned) return cleaned
            // transcript exists but cleaned to empty - try next rate
          }
        } catch {}
      }
    }
    return
  } catch (err) {
    console.log("[stt] error:", describeError(err))
    return
  } finally {
    await Promise.all([mp3, flac8, flac16].map((path) => unlink(path).catch(() => {})))
  }
}

// reCAPTCHA audio challenges are now word/phrase-based (not digit sequences).
// The user hears English words and types them verbatim. Keep the full phrase,
// just normalize whitespace and lowercase (reCAPTCHA is case-insensitive).
function clean(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ")
}

// What gets typed into reCAPTCHA's audio answer. Whisper writes spoken digits as "7-4-2-9."
// and ends phrases with a full stop, where a listener would type "7429" or the bare words.
// Punctuation between two digits is dropped (the digits join), apostrophes inside a word
// are dropped, and any other punctuation becomes a space. Letters and digits, in any
// script, are kept as they are; the result is lowercased with single spaces.
export function normaliseAudioAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/(?<=\p{N})[^\p{L}\p{N}\s]+(?=\p{N})/gu, "")
    .replace(/(?<=\p{L})['\u2019](?=\p{L})/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}
