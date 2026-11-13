#!/usr/bin/env node
/**
 * CLI wiring for the release executor: real child_process / fs / fetch /
 * GitHub check-runs API behind the injected io contract. The executor holds
 * the policy; this file only performs.
 *
 * Usage:
 *   node scripts/release/cli.mjs preflight --sha <sha> [--json]
 *   node scripts/release/cli.mjs deploy   --sha <sha> [--with-maintenance]
 *                                          [--keep N] [--resume]
 *
 * preflight is strictly read-only (git rev-parse / df / pm2 jlist /
 * prisma migrate status against the CURRENT release). It never installs,
 * builds, migrates or switches anything.
 *
 * Defaults mirror the production deployment exactly. Every override below
 * exists so the SAME code path can be exercised end-to-end in an isolated
 * drill (temp release roots, a scratch PM2 app, a scratch database) without
 * touching the live cascool app or its database:
 *   RELEASES_ROOT / RELEASE_SHARED_ROOT   release/shared directories
 *   RELEASE_REPO_DIR                      git checkout for archive/diff
 *   RELEASE_REQUIRED_CHECK                required GitHub check name
 *   RELEASE_ORIGIN                        origin URL for health probes
 *   RELEASE_CURRENT_DIR                   current release dir (skip pm2 lookup)
 *   RELEASE_PM2_APP                       PM2 app name (default: cascool)
 *   RELEASE_APP_PORT / RELEASE_APP_HOST   app port/host (default 3000/127.0.0.1)
 *   RELEASE_PM2_SAVE=0                    skip `pm2 save` (drills only)
 *   RELEASE_PSQL_CMD                      psql prefix for DB probes
 */

import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { deploy, preflight } from './executor.mjs'

const ARGS = process.argv.slice(2)
const CMD = ARGS[0]

function arg(name, fallback = undefined) {
  const i = ARGS.indexOf(`--${name}`)
  return i >= 0 ? ARGS[i + 1] : fallback
}
function flag(name) {
  return ARGS.includes(`--${name}`)
}

const CONF = {
  repoDir: process.env.RELEASE_REPO_DIR ?? path.resolve(import.meta.dirname, '..', '..'),
  releasesRoot: process.env.RELEASES_ROOT ?? '/var/www/cascool-releases',
  sharedRoot: process.env.RELEASE_SHARED_ROOT ?? '/var/www/cascool-shared',
  origin: process.env.RELEASE_ORIGIN ?? 'https://127.0.0.1',
  requiredCheck: process.env.RELEASE_REQUIRED_CHECK ?? 'checks',
  pm2App: process.env.RELEASE_PM2_APP ?? 'cascool',
  appPort: process.env.RELEASE_APP_PORT ?? '3000',
  appHost: process.env.RELEASE_APP_HOST ?? '127.0.0.1',
  pm2Save: process.env.RELEASE_PM2_SAVE !== '0',
  psqlCmd: process.env.RELEASE_PSQL_CMD ?? 'sudo -n -u postgres psql -At -d cascool',
  currentDirEnv: process.env.RELEASE_CURRENT_DIR ?? '',
}

const PM2_ENV = `env -i HOME=${process.env.HOME} PATH=/usr/local/bin:/usr/bin:/bin`

function sh(cmd, { envFile, timeoutMs = 120_000 } = {}) {
  if (envFile) {
    // Source the release .env without echoing it (never print values).
    return execFileSyncShell(`set -a && . ${envFile} && set +a && ${cmd}`, timeoutMs)
  }
  return execFileSyncShell(cmd, timeoutMs)
}

function execFileSyncShell(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const child = execFile('/bin/bash', ['-c', cmd], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, () => {})
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function fetchCheckRuns(sha) {
  const res = await fetch(`https://api.github.com/repos/samelabs/cas.cool/commits/${sha}/check-runs`, {
    headers: { 'User-Agent': 'cascool-release-executor', Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) throw new Error(`check-runs API ${res.status}`)
  const data = await res.json()
  return data.check_runs ?? []
}

let cachedCurrentDir = null

async function currentReleaseDir() {
  if (cachedCurrentDir) return cachedCurrentDir
  if (CONF.currentDirEnv) {
    cachedCurrentDir = CONF.currentDirEnv
    return cachedCurrentDir
  }
  // The running release IS the app's PM2 cwd — production has no symlink.
  const r = await sh(`${PM2_ENV} pm2 jlist`)
  if (r.code !== 0) throw new Error('pm2 jlist failed — cannot resolve current release dir')
  const apps = JSON.parse(r.stdout || '[]')
  const app = apps.find((a) => a.name === CONF.pm2App)
  cachedCurrentDir = app?.pm2_env?.pm_cwd ?? ''
  return cachedCurrentDir
}

const io = {
  exec: (cmd, opts) => sh(cmd, opts),
  fetchCheckRuns,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  selfPid: () => process.pid,
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  exists: (p) => fsp.access(p).then(() => true, () => false),
  readFile: (p) => fsp.readFile(p, 'utf8'),
  readJson: async (p) => JSON.parse(await fsp.readFile(p, 'utf8')),
  writeJson: (p, v) => fsp.writeFile(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 }),
  appendJsonl: async (p, v) => fsp.appendFile(p, JSON.stringify(v) + '\n'),
  rm: (p) => fsp.rm(p, { force: true, recursive: true }),
  mtime: async (p) => (await fsp.stat(p)).mtimeMs,
  readdir: (p) => fsp.readdir(p),
  currentReleaseDir,
  diskFreeMb: async (p) => {
    const r = await sh(`df -Pm ${p} | tail -1 | awk '{print $4}'`)
    const free = Number(r.stdout.trim())
    if (r.code !== 0 || !Number.isFinite(free) || free < 0) {
      throw new Error(`df failed for ${p} (rc=${r.code}) — refusing to guess free space`)
    }
    return free
  },
  pendingMigrations: async (currentDir) => {
    const r = await sh(`cd ${currentDir} && set -a && . ./.env && set +a && npx prisma migrate status 2>&1 | grep -c 'have not yet been applied' || true`)
    return Number(r.stdout.trim() || 0)
  },
  migrationHead: async () => {
    // Read-only: latest applied migration name.
    const r = await sh(`${CONF.psqlCmd} -c 'SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1'`)
    return r.stdout.trim()
  },
  stopApp: async () => {
    const r = await sh(`${PM2_ENV} pm2 stop ${CONF.pm2App}`)
    if (r.code !== 0) throw new Error(`pm2 stop ${CONF.pm2App} failed`)
  },
  restartApp: async (dir) => {
    // The existing switch mechanism: re-register the app against a release
    // dir via the repo's ecosystem.config.cjs (name/port/host/memory all
    // overridable through the environment). env -i per the PM2 hygiene rule.
    await sh(`${PM2_ENV} pm2 delete ${CONF.pm2App} >/dev/null 2>&1 || true`)
    const env = [
      `PM2_APP_NAME=${CONF.pm2App}`,
      `PORT=${CONF.appPort}`,
      `APP_HOST=${CONF.appHost}`,
      'PM2_MAX_MEMORY=1G',
      'NODE_OPTIONS=--max-old-space-size=512',
    ].join(' ')
    const r = await sh(`cd ${dir} && ${PM2_ENV} ${env} pm2 start ${dir}/ecosystem.config.cjs`)
    if (r.code !== 0) throw new Error('pm2 re-register failed: ' + r.stderr.slice(0, 500))
    if (CONF.pm2Save) {
      const s = await sh(`${PM2_ENV} pm2 save`)
      if (s.code !== 0) throw new Error('pm2 save failed')
    }
  },
  appDbConnections: async () => {
    const r = await sh(`${CONF.psqlCmd} -c "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name NOT LIKE 'psql%'"`)
    return Number(r.stdout.trim() || 0)
  },
  recordBaseline: async (sharedRoot) => {
    const r = await sh(`${CONF.psqlCmd} -c 'SELECT (SELECT count(*) FROM "User") || chr(32) || (SELECT count(*) FROM "Post")'`)
    if (r.code !== 0) throw new Error('baseline query failed: ' + r.stderr.slice(0, 200))
    await fsp.appendFile(`${sharedRoot}/maintenance-baselines.jsonl`, JSON.stringify({ ts: new Date().toISOString(), counts: r.stdout.trim() }) + '\n')
  },
  healthProbe: async (probe) => {
    if (probe.kind === 'GET') {
      const res = await fetch(probe.url, { signal: AbortSignal.timeout(15_000) })
      return res.status === 200
    }
    if (probe.kind === 'MCP') {
      const res = await fetch(probe.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'release-executor', version: '1' } },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      // production /mcp answers anonymous initialize with 401 (auth gate):
      // both 200 and 401 prove the route is alive and enforcing auth
      return res.status === 200 || res.status === 401
    }
    if (probe.kind === 'DB') {
      const r = await sh(`${CONF.psqlCmd} -c '${probe.url}'`)
      return r.code === 0 && r.stdout.trim() === '1'
    }
    if (probe.kind === 'BUILD_ID') {
      const r = await sh(`test -s ${probe.url}/.next/BUILD_ID`)
      return r.code === 0
    }
    throw new Error(`unknown probe kind ${probe.kind}`)
  },
}

async function main() {
  if (CMD !== 'preflight' && CMD !== 'deploy') {
    console.error('usage: cli.mjs preflight|deploy --sha <sha> [flags]')
    process.exit(2)
  }
  const opts = {
    sha: arg('sha'),
    requiredCheck: CONF.requiredCheck,
    repoDir: CONF.repoDir,
    releasesRoot: CONF.releasesRoot,
    sharedRoot: CONF.sharedRoot,
    origin: CONF.origin,
    withMaintenance: flag('with-maintenance'),
    keepReleases: Number(arg('keep', '2')),
    resume: flag('resume'),
  }
  if (!opts.sha) {
    console.error('refusing: --sha is mandatory (explicit commit, never "latest main")')
    process.exit(2)
  }
  try {
    if (CMD === 'preflight') {
      const result = await preflight(opts, io)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const result = await deploy(opts, io)
    console.log(JSON.stringify({ ok: true, manifest: result.manifest }, null, 2))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    if (err && typeof err === 'object' && 'detail' in err && err.detail) {
      console.error(JSON.stringify(err.detail, null, 2))
    }
    process.exit(1)
  }
}

await main()
