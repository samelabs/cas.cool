import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { SERVER_PORT, SERVER_URL, TEST_DATABASE_URL, TEST_JWT_SECRET } from './env'

let child: ReturnType<typeof spawn> | null = null

/**
 * Boot `next dev` against the throwaway test database and wait until the
 * public timeline answers 200 (first hit also triggers route compilation).
 */
export async function startTestServer(): Promise<void> {
  // next dev and production builds SHARE .next/cache (unstable_cache data
  // persists there), and next dev persists its own prerender/route cache in
  // .next/dev across boots. Stale entries from a previous build or dev run
  // (e.g. a different SiteConfig row) would leak into these tests — clear
  // both so every test run starts cache-cold and hermetic.
  rmSync('.next/cache', { recursive: true, force: true })
  rmSync('.next/dev', { recursive: true, force: true })

  child = spawn('npx', ['next', 'dev', '--port', String(SERVER_PORT)], {
    env: {
      ...process.env,
      // process env overrides .env in Next.js — the server must see ONLY the test DB
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: TEST_JWT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → teardown kills `npx` AND `next`
  })

  let log = ''
  child.stdout!.on('data', (d: Buffer) => (log += d))
  child.stderr!.on('data', (d: Buffer) => (log += d))

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next dev exited (code ${child.exitCode}):\n${log.slice(-2000)}`)
    }
    try {
      const res = await fetch(`${SERVER_URL}/api/posts`)
      if (res.status === 200) return
    } catch {
      // not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`next dev did not become ready within 90s:\n${log.slice(-2000)}`)
}

export async function stopTestServer(): Promise<void> {
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
