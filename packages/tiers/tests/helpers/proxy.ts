import { connect, createServer, type Socket } from "node:net"

export interface TestProxy {
  url: string
  seen: string[]
  close: () => Promise<void>
}

// A local forward proxy for tests. It records each request line, answers `.invalid`
// hosts itself, refuses CONNECT (or, with `tunnelTo`, tunnels every CONNECT to that
// local port whatever host it names), and forwards other plain HTTP requests to their
// origin over a fresh connection. It never reaches beyond the named local target.
export async function startTestProxy(name = "test-proxy", tunnelTo?: number): Promise<TestProxy> {
  const seen: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((client) => {
    sockets.add(client)
    client.on("close", () => sockets.delete(client))
    let head = Buffer.alloc(0)
    client.on("error", () => {})
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) return
      client.off("data", onData)
      const lines = head.subarray(0, end).toString("latin1").split("\r\n")
      const [method = "", target = ""] = (lines[0] ?? "").split(" ")
      seen.push(`${method} ${target}`)
      if (method === "CONNECT" && tunnelTo) {
        const upstream = connect(tunnelTo, "127.0.0.1", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          upstream.write(head.subarray(end + 4))
          client.pipe(upstream)
          upstream.pipe(client)
        })
        upstream.on("error", () => client.destroy())
        return
      }
      if (method === "CONNECT") {
        client.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        return
      }
      const url = new URL(target)
      if (url.hostname.endsWith(".invalid")) {
        const body = `via ${name}`
        client.end(
          `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
        )
        return
      }
      const headers = lines.slice(1).filter((line) => !/^(connection|proxy-connection|keep-alive):/i.test(line))
      const upstream = connect(Number(url.port || 80), url.hostname, () => {
        upstream.write(
          [`${method} ${url.pathname}${url.search} HTTP/1.1`, ...headers, "connection: close", "", ""].join("\r\n"),
        )
        upstream.write(head.subarray(end + 4))
      })
      upstream.on("error", () => client.destroy())
      upstream.pipe(client)
    }
    client.on("data", onData)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test proxy has no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]

// Replaces the proxy variables for one test and returns a restore function.
export function setProxyEnvironment(values: Record<string, string>): () => void {
  const saved = Object.fromEntries(PROXY_VARIABLES.map((name) => [name, process.env[name]]))
  for (const name of PROXY_VARIABLES) delete process.env[name]
  Object.assign(process.env, values)
  return () => {
    for (const name of PROXY_VARIABLES) {
      const value = saved[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
