import { describe, expect, test } from "bun:test"
import { isProxyTransportFailure, proxyResponseFailure } from "../src/utils/proxyFailure"

describe("proxy failure classification", () => {
  test("only treats Proxy-Status with an error parameter as failure", () => {
    expect(proxyResponseFailure(200, { "proxy-status": 'ExampleProxy; next-hop="origin.example"' })).toBeUndefined()
    expect(proxyResponseFailure(502, { "proxy-status": "ExampleProxy; error=dns_error" })).toBe(
      "proxy-connection-failed",
    )
  })

  test("recognizes Chromium and Firefox proxy network errors", () => {
    expect(isProxyTransportFailure(new Error("net::ERR_TUNNEL_CONNECTION_FAILED"))).toBeTrue()
    expect(isProxyTransportFailure(new Error("NS_ERROR_PROXY_CONNECTION_REFUSED"))).toBeTrue()
  })
})

describe("Squid's own error pages", () => {
  test("X-Squid-Error marks a proxy that couldn't reach the host", () => {
    expect(proxyResponseFailure(503, { server: "squid", "x-squid-error": "ERR_CONNECT_FAIL 110" })).toBe(
      "proxy-connection-failed",
    )
    expect(proxyResponseFailure(503, { "x-squid-error": "ERR_DNS_FAIL 0" })).toBe("proxy-connection-failed")
  })
  test("a 503 without it is the site's", () => {
    expect(proxyResponseFailure(503, { server: "nginx" })).toBeUndefined()
  })
})
