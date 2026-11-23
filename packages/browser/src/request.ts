import { request } from "playwright-core"
import { toPlaywrightProxy } from "./proxy"

interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: "Strict" | "Lax" | "None"
}

/**
 * A standalone Playwright request context that sends everything through `proxyUrl`.
 * A page's own `page.request` uses only its context's or browser's `proxy` option and
 * never the environment's `HTTPS_PROXY`, so code that must leave through the environment
 * proxy uses one of these instead. The caller disposes it.
 */
export const newProxiedRequestContext = (proxyUrl: string, cookies: Cookie[] = []) =>
  request.newContext({ proxy: toPlaywrightProxy(proxyUrl), storageState: { cookies, origins: [] } })
