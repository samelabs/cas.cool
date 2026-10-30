import { spawn } from 'node:child_process'
import { mkdirSync, appendFileSync } from 'node:fs'
import { SERVER_PORT, SERVER_URL, TEST_DATABASE_URL, TEST_JWT_SECRET } from './env'

let child: ReturnType<typeof spawn> | null = null

/**
 * Boot the PRODUCTION server (`next start`) against the throwaway test
 * database. Used by browser suites: dev-mode Turbopack/HMR plumbing must
 * not be a variable when the test target is client hydration behavior —
 * and production mode is the deployment reality these suites certify.
 * Requires a prior `next build` with the same DATABASE_URL (the build
 * prerenders /sitemap.xml).
 */
export async function startProdTestServer(): Promise<void> {
  child = spawn('npx', ['next', 'start', '--port', String(SERVER_PORT)], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })

  let log = ''
  const append = (d: Buffer) => {
    log += d
    mkdirSync('.tmp/test-logs', { recursive: true })
    appendFileSync('.tmp/test-logs/server-prod.log', d)
  }
  child.stdout!.on('data', append)
  child.stderr!.on('data', append)

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited (code ${child.exitCode}):\n${log.slice(-2000)}`)
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/posts`)
      if (res.status === 200) return
    } catch {
      // not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`next start did not become ready within 60s:\n${log.slice(-2000)}`)
}

export async function stopProdTestServer(): Promise<void> {
  const c = child
  child = null
  if (!c || c.exitCode !== null) return
  await new Promise<void>((resolve) => {
    c.on('exit', () => resolve())
    try {
      process.kill(-c.pid!, 'SIGTERM')
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-c.pid!, 'SIGKILL')
      } catch {
        /* already gone */
      }
      resolve()
    }, 5000)
  })
}
