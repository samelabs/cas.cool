/**
 * Release executor unit contract (batch B5 + 轻量收口 fixes).
 *
 * Everything runs against throwaway temp directories with a scripted io —
 * no production path, no real git repo beyond what the fake exec answers,
 * and no database. The point of this suite is the GATE BEHAVIOR: which
 * deploys are refused, what a failure leaves behind, and that preflight
 * can never build/migrate/switch.
 *
 * The switch mechanism is PM2 re-registration (production has no symlink —
 * the running release IS the app's PM2 cwd); io.restartApp is the switch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DeployRefused, deploy, preflight } from '../scripts/release/executor.mjs'

const CUR_FULL = 'a'.repeat(40)
const TGT_FULL = 'b'.repeat(40)
const GOOD_CHECK = [{ name: 'checks', status: 'completed', conclusion: 'success', head_sha: TGT_FULL }]

let root: string
let opts: Record<string, unknown>

interface ScriptedIo {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  io: any
  calls: string[]
  controls: {
    checkRuns: { name: string; status: string; conclusion: string; head_sha: string }[]
    buildFails: boolean
    migrateFails: boolean
    manifestWriteFails: boolean
    healthOk: boolean
    migrationDiff: string[]
    destructiveSql: boolean
    alivePids: Set<number>
  }
}

function makeIo(): ScriptedIo {
  const calls: string[] = []
  const controls: ScriptedIo['controls'] = {
    checkRuns: GOOD_CHECK,
    buildFails: false,
    migrateFails: false,
    manifestWriteFails: false,
    healthOk: true,
    migrationDiff: [],
    destructiveSql: false,
    alivePids: new Set(),
  }
  const exec = async (cmd: string) => {
    calls.push(cmd)
    if (cmd.startsWith('mkdir -p ')) {
      await fsp.mkdir(cmd.slice('mkdir -p '.length), { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd.startsWith('git archive')) {
      // simulate the tar extraction step: the target dir comes to life
      const dir = cmd.match(/-C (\S+)/)?.[1]
      if (dir) await fsp.mkdir(dir, { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd.startsWith('git rev-parse --verify a')) return { code: 0, stdout: CUR_FULL + '\n', stderr: '' }
    if (cmd.startsWith('git rev-parse --verify b')) return { code: 0, stdout: TGT_FULL + '\n', stderr: '' }
    if (cmd.startsWith('git rev-parse')) return { code: 0, stdout: cmd.includes('main') ? 'x'.repeat(40) + '\n' : '', stderr: '' }
    if (cmd.startsWith('git diff --name-only')) return { code: 0, stdout: controls.migrationDiff.join('\n') + '\n', stderr: '' }
    if (cmd.startsWith('git show')) {
      const sql = controls.destructiveSql ? 'ALTER TABLE "Chemical" DROP COLUMN "x";\n' : 'CREATE TABLE "T";\n'
      return { code: 0, stdout: sql, stderr: '' }
    }
    if (cmd.includes('npm run build')) return { code: controls.buildFails ? 1 : 0, stdout: '', stderr: controls.buildFails ? 'build boom' : '' }
    if (cmd.includes('prisma migrate deploy')) return { code: controls.migrateFails ? 1 : 0, stdout: '', stderr: controls.migrateFails ? 'mig boom' : '' }
    if (cmd.startsWith('df -Pm')) return { code: 0, stdout: '20000\n', stderr: '' }
    if (cmd.startsWith('rm -rf')) {
      await fsp.rm(cmd.replace('rm -rf ', ''), { force: true, recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd.startsWith('rm -f ') && cmd.endsWith('maintenance.flag')) {
      await fsp.rm(cmd.replace('rm -f ', ''), { force: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd.startsWith('touch ') && cmd.endsWith('maintenance.flag')) {
      await fsp.writeFile(cmd.replace('touch ', ''), '')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd.startsWith('cp -p ')) {
      // simulate the .env copy from the current release
      const src = cmd.match(/cp -p (\S+) (\S+)/)?.[1]
      const dst = cmd.match(/cp -p (\S+) (\S+)/)?.[2]
      if (!src || !dst) return { code: 0, stdout: '', stderr: '' }
      try {
        await fsp.copyFile(src, dst)
        return { code: 0, stdout: '', stderr: '' }
      } catch {
        return { code: 1, stdout: '', stderr: `cp: cannot stat '${src}'` }
      }
    }
    if (cmd.startsWith('ln -sfn ') || cmd.startsWith('test -s ')) return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const io: any = {
    exec,
    fetchCheckRuns: async () => controls.checkRuns,
    now: () => 1_700_000_000_000,
    sleep: async () => {}, // tests never actually wait
    selfPid: () => 4242,
    pidAlive: (pid: number) => controls.alivePids.has(pid),
    exists: (p: string) => fsp.access(p).then(() => true, () => false),
    readFile: async (p: string) => {
      if (p.endsWith('BUILD_ID')) return 'test-build-id\n'
      return fsp.readFile(p, 'utf8')
    },
    readJson: async (p: string) => JSON.parse(await fsp.readFile(p, 'utf8')),
    writeJson: async (p: string, v: unknown) => {
      if (controls.manifestWriteFails && p.endsWith('deploy-manifest.json')) throw new Error('disk full')
      if (controls.manifestWriteFails && p.endsWith('deploy-manifests.jsonl')) throw new Error('disk full')
      await fsp.writeFile(p, JSON.stringify(v, null, 2) + '\n')
    },
    appendJsonl: async (p: string, v: unknown) => {
      if (controls.manifestWriteFails) throw new Error('disk full')
      await fsp.appendFile(p, JSON.stringify(v) + '\n')
    },
    rm: (p: string) => fsp.rm(p, { force: true, recursive: true }),
    mtime: async (p: string) => (await fsp.stat(p)).mtimeMs,
    readdir: (p: string) => fsp.readdir(p),
    currentReleaseDir: async () => `${root}/releases/aaaaaaa`,
    diskFreeMb: async () => 20000,
    pendingMigrations: async () => 0,
    migrationHead: async () => (controls.destructiveSql ? '20261112_drop_x' : '20261110230000_x'),
    stopApp: async () => calls.push('STOP-APP'),
    restartApp: async (dir: string) => calls.push(`RESTART-APP ${dir}`),
    appDbConnections: async () => 0,
    recordBaseline: async () => calls.push('RECORD-BASELINE'),
    healthProbe: async (probe: { name: string }) => {
      calls.push(`PROBE ${probe.name}`)
      return controls.healthOk
    },
  }
  return { io, calls, controls }
}

async function refuse(p: Promise<unknown>): Promise<DeployRefused> {
  try {
    await p
    throw new Error('expected refusal, got success')
  } catch (err) {
    if (err instanceof DeployRefused) return err as DeployRefused
    throw err
  }
}

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(() => true, () => false)
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'release-exec-'))
  await fsp.mkdir(`${root}/releases/aaaaaaa`, { recursive: true })
  await fsp.mkdir(`${root}/shared`, { recursive: true })
  // the current release must carry .env — the prep step copies it into the new dir
  await fsp.writeFile(`${root}/releases/aaaaaaa/.env`, 'DATABASE_URL=postgres://test\n', { mode: 0o600 })
  opts = {
    sha: 'bbbbbbb',
    requiredCheck: 'checks',
    releasesRoot: `${root}/releases`,
    sharedRoot: `${root}/shared`,
    origin: 'http://test',
    keepReleases: 2,
  }
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('admission gates', () => {
  it('refuses implicit refs (main / HEAD / branch names)', async () => {
    const { io } = makeIo()
    const err = await refuse(preflight({ ...opts, sha: 'main' }, io))
    expect(err.code).toBe('SHA_NOT_EXPLICIT')
    const err2 = await refuse(preflight({ ...opts, sha: 'HEAD' }, io))
    expect(err2.code).toBe('SHA_NOT_EXPLICIT')
  })

  it('refuses when the required check failed, is incomplete, or missing', async () => {
    const s = makeIo()
    s.controls.checkRuns = [{ name: 'checks', status: 'completed', conclusion: 'failure', head_sha: TGT_FULL }]
    expect((await refuse(preflight(opts, s.io))).code).toBe('CI_FAILED')
    const s2 = makeIo()
    s2.controls.checkRuns = [{ name: 'checks', status: 'in_progress', conclusion: '', head_sha: TGT_FULL }]
    expect((await refuse(preflight(opts, s2.io))).code).toBe('CI_INCOMPLETE')
    const s3 = makeIo()
    s3.controls.checkRuns = [{ name: 'lint', status: 'completed', conclusion: 'success', head_sha: TGT_FULL }]
    expect((await refuse(preflight(opts, s3.io))).code).toBe('CI_NO_RESULT')
  })

  it('refuses a green check that belongs to a different SHA', async () => {
    const s = makeIo()
    s.controls.checkRuns = [{ name: 'checks', status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40) }]
    const err = await refuse(preflight(opts, s.io))
    expect(err.code).toBe('CI_SHA_MISMATCH')
  })

  it('refuses a destructive migration without an explicit maintenance plan', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    const err = await refuse(preflight(opts, s.io))
    expect(err.code).toBe('MIGRATION_NEEDS_MAINTENANCE')
  })

  it('refuses when free disk is below the floor', async () => {
    const s = makeIo()
    s.io.diskFreeMb = async () => 100
    const err = await refuse(preflight({ ...opts, minFreeMb: 8000 }, s.io))
    expect(err.code).toBe('DISK_LOW')
  })

  it('refuses when the current release cannot be resolved', async () => {
    const s = makeIo()
    s.io.currentReleaseDir = async () => ''
    const err = await refuse(preflight(opts, s.io))
    expect(err.code).toBe('NO_CURRENT_RELEASE')
  })
})

describe('dry-run / preflight has no production side effects', () => {
  it('never builds, migrates, switches or restarts', async () => {
    const s = makeIo()
    const result = await preflight(opts, s.io)
    expect(result.sha).toBe(TGT_FULL)
    expect(result.plan.migrationCls).toBe('none')
    const dangerous = s.calls.filter((c) => /npm (ci|run build)|prisma migrate deploy|RESTART-APP|STOP-APP|cp -p .*\.env|ln -sfn/.test(c))
    expect(dangerous).toEqual([])
  })
})

describe('release preparation matches the live deployment shape', () => {
  it('stages .env copy, shared uploads symlinks and logs dir before build', async () => {
    const s = makeIo()
    const result = await deploy(opts, s.io)
    expect(result.ok).toBe(true)
    const prep = s.calls.find((c) => c.startsWith('cp -p ') && c.includes('/.env'))
    expect(prep).toContain(`cp -p ${root}/releases/aaaaaaa/.env ${root}/releases/bbbbbbb/.env`)
    // prep is one chained command; assert on its parts
    expect(s.calls.some((c) => c.includes(`ln -sfn ${root}/shared/uploads`) && c.includes('public/uploads'))).toBe(true)
    expect(s.calls.some((c) => c.includes(`ln -sfn ${root}/shared/private-uploads`) && c.includes('private-uploads'))).toBe(true)
    expect(s.calls.some((c) => c.includes(`mkdir -p ${root}/releases/bbbbbbb/logs`))).toBe(true)
    // the copied .env really landed in the new release dir
    expect(await fsp.readFile(`${root}/releases/bbbbbbb/.env`, 'utf8')).toContain('DATABASE_URL=postgres://test')
  })

  it('a missing .env in the current release aborts before any build', async () => {
    const s = makeIo()
    await fsp.rm(`${root}/releases/aaaaaaa/.env`)
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('RELEASE_PREP_FAILED')
    expect(s.calls.filter((c) => c.includes('npm ci'))).toEqual([])
  })
})

describe('deploy failure containment', () => {
  it('build failure leaves the online version untouched', async () => {
    const s = makeIo()
    s.controls.buildFails = true
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('BUILD_FAILED')
    expect(s.calls).not.toContainEqual(expect.stringMatching(/^RESTART-APP/))
  })

  it('manifest write failure aborts BEFORE the switch', async () => {
    const s = makeIo()
    s.controls.manifestWriteFails = true
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('MANIFEST_WRITE_FAILED')
    expect(s.calls).not.toContainEqual(expect.stringMatching(/^RESTART-APP/))
    // lock released despite abort
    expect(await exists(`${root}/releases/.deploy-lock`)).toBe(false)
  })

  it('destructive deploy with maintenance plan runs the window sequence in order and clears the flag on success', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    const result = await deploy({ ...opts, withMaintenance: true }, s.io)
    expect(result.ok).toBe(true)
    const stopIdx = s.calls.findIndex((c) => c === 'STOP-APP')
    const baselineIdx = s.calls.findIndex((c) => c === 'RECORD-BASELINE')
    const migrateIdx = s.calls.findIndex((c) => c.includes('prisma migrate deploy'))
    const switchIdx = s.calls.findIndex((c) => c === `RESTART-APP ${root}/releases/bbbbbbb`)
    const clearIdx = s.calls.findIndex((c) => c === `rm -f ${root}/shared/maintenance.flag`)
    expect(stopIdx).toBeGreaterThan(-1)
    expect(baselineIdx).toBeGreaterThan(stopIdx)
    expect(migrateIdx).toBeGreaterThan(baselineIdx)
    expect(switchIdx).toBeGreaterThan(migrateIdx)
    expect(clearIdx).toBeGreaterThan(switchIdx)
    // success concludes the run: flag gone, journal gone, lock gone
    expect(await exists(`${root}/shared/maintenance.flag`)).toBe(false)
    expect(await exists(`${root}/releases/bbbbbbb/.deploy-state.json`)).toBe(false)
    expect(await exists(`${root}/releases/.deploy-lock`)).toBe(false)
  })

  it('refuses to migrate when the app still holds DB connections in the window', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    s.io.appDbConnections = async () => 3
    const err = await refuse(deploy({ ...opts, withMaintenance: true }, s.io))
    expect(err.code).toBe('WRITE_STOP_FAILED')
    expect(s.calls).not.toContainEqual(expect.stringContaining('prisma migrate deploy'))
  })

  it('a pre-switch window failure restores the current app and clears the flag', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    s.io.appDbConnections = async () => 3 // WRITE_STOP_FAILED after stop
    const err = await refuse(deploy({ ...opts, withMaintenance: true }, s.io))
    expect(err.code).toBe('WRITE_STOP_FAILED')
    // recovery: current app back up (last RESTART-APP targets the OLD dir), flag cleared
    expect(s.calls.filter((c) => c.startsWith('RESTART-APP')).at(-1)).toBe(`RESTART-APP ${root}/releases/aaaaaaa`)
    expect(await exists(`${root}/shared/maintenance.flag`)).toBe(false)
    expect((err.detail as { maintenanceRecovery?: { appRestarted: boolean } }).maintenanceRecovery?.appRestarted).toBe(true)
    expect(await exists(`${root}/releases/.deploy-lock`)).toBe(false)
  })

  it('migration failure inside the window also restores the current app', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    s.controls.migrateFails = true
    const err = await refuse(deploy({ ...opts, withMaintenance: true }, s.io))
    expect(err.code).toBe('MIGRATION_FAILED')
    expect(s.calls.filter((c) => c.startsWith('RESTART-APP')).at(-1)).toBe(`RESTART-APP ${root}/releases/aaaaaaa`)
    expect(await exists(`${root}/shared/maintenance.flag`)).toBe(false)
  })
})

describe('health-check and rollback decisions', () => {
  it('additive deploy: health failure re-registers the previous release, never the DB', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_add/migration.sql']
    s.controls.healthOk = false
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('HEALTH_FAILED_ROLLED_BACK')
    expect(s.calls.filter((c) => c.startsWith('RESTART-APP')).at(-1)).toBe(`RESTART-APP ${root}/releases/aaaaaaa`)
    expect(s.calls).not.toContainEqual(expect.stringContaining('pg_restore'))
    // rollback concludes the run too: journal and lock gone
    expect(await exists(`${root}/releases/bbbbbbb/.deploy-state.json`)).toBe(false)
    expect(await exists(`${root}/releases/.deploy-lock`)).toBe(false)
  })

  it('maintenance-window additive deploy: health failure ALSO clears the flag', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_add/migration.sql']
    s.controls.healthOk = false
    const err = await refuse(deploy({ ...opts, withMaintenance: true }, s.io))
    expect(err.code).toBe('HEALTH_FAILED_ROLLED_BACK')
    expect(await exists(`${root}/shared/maintenance.flag`)).toBe(false)
  })

  it('destructive deploy: health failure does NOT blind-rollback and KEEPS the flag for manual triage', async () => {
    const s = makeIo()
    s.controls.migrationDiff = ['prisma/migrations/20261112_drop/migration.sql']
    s.controls.destructiveSql = true
    s.controls.healthOk = false
    const err = await refuse(deploy({ ...opts, withMaintenance: true }, s.io))
    expect(err.code).toBe('HEALTH_FAILED_NO_ROLLBACK')
    // new version stays up for manual triage and writes stay closed
    expect(s.calls.filter((c) => c.startsWith('RESTART-APP')).at(-1)).toBe(`RESTART-APP ${root}/releases/bbbbbbb`)
    expect(await exists(`${root}/shared/maintenance.flag`)).toBe(true)
    const journal = JSON.parse(await fsp.readFile(`${root}/releases/bbbbbbb/.deploy-state.json`, 'utf8')) as { phases: { phase: string }[] }
    expect(journal.phases.at(-1)?.phase).toBe('needs-manual')
  })

  it('successful deploy writes a manifest with sha, buildId and acceptance', async () => {
    const s = makeIo()
    const result = await deploy(opts, s.io)
    expect(result.ok).toBe(true)
    const manifest = JSON.parse(await fsp.readFile(`${root}/releases/bbbbbbb/deploy-manifest.json`, 'utf8')) as Record<string, unknown>
    expect(manifest['sha']).toBe(TGT_FULL)
    expect(manifest['buildId']).toBe('test-build-id')
    expect(manifest['previousRunning']).toEqual({ dir: `${root}/releases/aaaaaaa`, sha: CUR_FULL })
    expect((manifest['acceptance'] as { ok: boolean }).ok).toBe(true)
    const ledger = await fsp.readFile(`${root}/shared/deploy-manifests.jsonl`, 'utf8')
    expect(ledger.trim().split('\n').length).toBeGreaterThanOrEqual(1)
  })
})

describe('retention and concurrency', () => {
  it('keeps the live release and its predecessor, removes older ones', async () => {
    const s = makeIo()
    // three pre-existing releases: aaaaaaa is current-predecessor, ccccccc/ddddddd are stale
    for (const name of ['ccccccc', 'ddddddd']) {
      await fsp.mkdir(`${root}/releases/${name}`)
      const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
      await fsp.utimes(`${root}/releases/${name}`, past, past)
    }
    const result = await deploy(opts, s.io)
    expect(result.ok).toBe(true)
    const remaining = (await fsp.readdir(`${root}/releases`)).filter((d) => /^[0-9a-f]{7,40}$/.test(d)).sort()
    expect(remaining).toEqual(['aaaaaaa', 'bbbbbbb'])
  })

  it('refuses a concurrent deploy while the lock holder is alive, reclaims a stale lock', async () => {
    const s = makeIo()
    await fsp.writeFile(`${root}/releases/.deploy-lock`, JSON.stringify({ pid: 999, sha: 'zzz', ts: 1 }))
    s.controls.alivePids.add(999)
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('DEPLOY_LOCKED')

    const s2 = makeIo() // pid 999 not alive here
    const result = await deploy(opts, s2.io)
    expect(result.ok).toBe(true)
  })

  it('a corrupt (unreadable) lock file is treated as stale and reclaimed', async () => {
    const s = makeIo()
    await fsp.writeFile(`${root}/releases/.deploy-lock`, 'not-json{')
    const result = await deploy(opts, s.io)
    expect(result.ok).toBe(true)
  })

  it('an interrupted deploy (state journal present) requires explicit --resume', async () => {
    const s = makeIo()
    await fsp.mkdir(`${root}/releases/bbbbbbb`, { recursive: true })
    await fsp.writeFile(`${root}/releases/bbbbbbb/.deploy-state.json`, JSON.stringify({ phases: [{ phase: 'prepared' }] }))
    const err = await refuse(deploy(opts, s.io))
    expect(err.code).toBe('DEPLOY_INTERRUPTED')
    // the lock does not leak across the refusal
    expect(await exists(`${root}/releases/.deploy-lock`)).toBe(false)

    const s2 = makeIo()
    const result = await deploy({ ...opts, resume: true }, s2.io)
    expect(result.ok).toBe(true)
  })
})
