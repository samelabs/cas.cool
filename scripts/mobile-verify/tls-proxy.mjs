/**
 * Local TLS terminator for mobile verification — production builds set the
 * session cookie `Secure`, which browsers refuse to store over plain HTTP.
 * Real deployments sit behind nginx TLS; this proxy reproduces that locally:
 * self-signed HTTPS on 8443 → plain HTTP on 3201.
 *
 * Usage: node scripts/mobile-verify/tls-proxy.mjs   (keep running)
 */

import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', '/tmp/verify-key.pem', '-out', '/tmp/verify-cert.pem',
  '-days', '2', '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
])

const proxy = createHttpsServer(
  {
    key: readFileSync('/tmp/verify-key.pem'),
    cert: readFileSync('/tmp/verify-cert.pem'),
  },
  (req, res) => {
    const upstream = httpRequest(
      { host: '127.0.0.1', port: 3201, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers)
        up.pipe(res)
      },
    )
    req.pipe(upstream)
  },
)

proxy.listen(8443, '127.0.0.1', () => {
  console.log('[tls-proxy] https://127.0.0.1:8443 → http://127.0.0.1:3201')
})
