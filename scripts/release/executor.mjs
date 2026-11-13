/**
 * Release executor — the gated pipeline behind cas.cool's existing
 * release-directory deployment (git-archive build → atomic symlink swap →
 * PM2 re-register). This module is pure orchestration: every side effect
 * (shell, HTTP, filesystem, GitHub API, clock) arrives through an injected
 * `io` object so tests can drive it against temp directories and scripted
 * commands without touching production.
 *
 * Hard rules encoded here (batch B contract):
 *  - an explicit git SHA is required; symbolic refs ("main", "HEAD") are
 *    rejected so a deploy can never silently mean "latest main"
 *  - the target SHA must carry a COMPLETED + SUCCESS result for the exact
 *    check name, and every considered check run must match that same SHA
 *  - preflight/dry-run never invokes build, install, migration or service
 *    commands — the code path simply does not contain them
 *  - a failed health check rolls back the symlink for backward-compatible
 *    deploys, but NEVER blind-rolls-back code after a destructive migration
 *  - the machine-readable manifest is written BEFORE the switch; a manifest
 *    write failure aborts the deploy with the online version untouched
 */

export class DeployRefused extends Error {
  /**
   * @param {string} code machine-readable refusal code
   * @param {string} message human explanation
   * @param {unknown} [detail] structured evidence
   */
  constructor(code, message, detail) {
    super(`${code}: ${message}`)
    this.code = code
    this.detail = detail
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/
const DESTRUCTIVE_SQL = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bCREATE\s+OR\s+REPLACE\b[^;]*\bRETURNS\b[^;]*\bAS\b\s*\$/i,
]

/** Migration risk classes, ordered by required ceremony. */
export const MIGRATION_CLASS = {
  NONE: 'none',
  ADDITIVE: 'additive',
  DESTRUCTIVE: 'destructive',
}

/**
 * @param {string} raw ref-like argument as given by the operator
 * @param {import('./io-types.ts').Io} io
 * @returns {Promise<string>} full 40-char sha
 */
export async function resolveSha(raw, io, repoDir = '.') {
  if (!SHA_RE.test(raw)) {
    throw new DeployRefused(
      'SHA_NOT_EXPLICIT',
      `refusing implicit ref "${raw}" — pass an explicit commit SHA (7-40 hex)`,
    )
  }
  const r = await io.exec(`git -C ${repoDir} rev-parse --verify ${raw}^{commit}`)
  if (r.code !== 0) {
    throw new DeployRefused('SHA_UNKNOWN', `commit ${raw} not found in local git`, r.stderr)
  }
  const full = r.stdout.trim()
  if (full.length !== 40) {
    throw new DeployRefused('SHA_AMBIGUOUS', `resolved "${raw}" to non-commit object ${full}`)
  }
  return full
}

/**
 * CI admission gate. Every considered check run must belong to the exact
 * target SHA; a green run from any other SHA is not accepted as substitute.
 * @param {string} fullSha
 * @param {string} requiredCheck exact GitHub check name
 */
export async function ciGate(fullSha, requiredCheck, io) {
  const runs = await io.fetchCheckRuns(fullSha)
  const matching = runs.filter((run) => run.name === requiredCheck)
  if (matching.length === 0) {
    throw new DeployRefused('CI_NO_RESULT', `no check named "${requiredCheck}" for ${fullSha.slice(0, 8)}`, {
      available: runs.map((run) => run.name),
    })
  }
  for (const run of matching) {
    if (run.head_sha !== fullSha) {
      throw new DeployRefused('CI_SHA_MISMATCH', `check "${requiredCheck}" reports head ${run.head_sha}, not ${fullSha}`, run)
    }
    if (run.status !== 'completed') {
      throw new DeployRefused('CI_INCOMPLETE', `check "${requiredCheck}" is ${run.status} (must be completed)`, run)
    }
    if (run.conclusion !== 'success') {
      throw new DeployRefused('CI_FAILED', `check "${requiredCheck}" concluded "${run.conclusion}"`, run)
    }
  }
  return { check: requiredCheck, runs: matching.length, sha: fullSha }
}

/**
 * Classify migration risk between the currently running SHA and the target.
 * @returns {Promise<{cls: string, added: string[], destructive: string[]}>}
 */
export async function classifyMigrations(currentSha, targetSha, io, repoDir = '.') {
  if (!currentSha) return { cls: MIGRATION_CLASS.NONE, added: [], destructive: [] }
  const r = await io.exec(`git -C ${repoDir} diff --name-only ${currentSha} ${targetSha} -- prisma/migrations`)
  if (r.code !== 0) {
    throw new DeployRefused('MIGRATION_DIFF_FAILED', 'git diff of migration dirs failed', r.stderr)
  }
  const added = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('migration.sql'))
  if (added.length === 0) return { cls: MIGRATION_CLASS.NONE, added, destructive: [] }
  const destructive = []
  for (const file of added) {
    const show = await io.exec(`git -C ${repoDir} show ${targetSha}:${file}`)
    if (show.code !== 0) {
      throw new DeployRefused('MIGRATION_READ_FAILED', `cannot read ${file}@${targetSha.slice(0, 8)}`, show.stderr)
    }
    if (DESTRUCTIVE_SQL.some((re) => re.test(show.stdout))) destructive.push(file)
  }
  return { cls: destructive.length > 0 ? MIGRATION_CLASS.DESTRUCTIVE : MIGRATION_CLASS.ADDITIVE, added, destructive }
}

/**
 * Pure decision step — no io. Determines whether a controlled maintenance
 * window (write-stop + baseline) is required before the switch.
 */
export function planDeploy({ migrationCls, maintenanceRequested }) {
  const needsWindow = migrationCls === MIGRATION_CLASS.DESTRUCTIVE || maintenanceRequested === true
  if (migrationCls === MIGRATION_CLASS.DESTRUCTIVE && maintenanceRequested !== true) {
    throw new DeployRefused(
      'MIGRATION_NEEDS_MAINTENANCE',
      'destructive migration detected — refusing to deploy without an explicit maintenance plan (--with-maintenance + write-stop baseline)',
      {},
    )
  }
  return { migrationCls, needsWindow }
}

/**
 * Read-preflight: explicit SHA + CI gate + current production state.
 * Guaranteed side-effect free beyond read-only probes (git rev-parse, df,
 * readlink, read-only prisma migrate status on the CURRENT release).
 */
export async function preflight(opts, io) {
  const repoDir = opts.repoDir ?? '.'
  const fullSha = await resolveSha(opts.sha, io, repoDir)
  const ci = await ciGate(fullSha, opts.requiredCheck, io)
  const currentDir = await io.currentReleaseDir()
  if (!currentDir) {
    throw new DeployRefused('NO_CURRENT_RELEASE', 'cannot resolve the currently running release directory (PM2 cwd) — refusing to deploy blind')
  }
  const currentShort = currentDir.split('/').pop()
  const currentSha = await resolveSha(currentShort, io, repoDir)
  const migrations = await classifyMigrations(currentSha, fullSha, io, repoDir)
  const plan = planDeploy({ migrationCls: migrations.cls, maintenanceRequested: opts.withMaintenance })
  const disk = await io.diskFreeMb(opts.releasesRoot)
  if (disk < (opts.minFreeMb ?? 8000)) {
    throw new DeployRefused('DISK_LOW', `${disk}MB free below floor ${opts.minFreeMb ?? 8000}MB`, { disk })
  }
  const pending = await io.pendingMigrations(currentDir)
  return {
    sha: fullSha,
    ci,
    current: { dir: currentDir, sha: currentSha },
    migrations,
    plan,
    diskFreeMb: disk,
    pendingMigrationsOnCurrent: pending,
  }
}

/**
 * Full deploy. Order of operations is the contract; each phase marks the
 * state journal so an interrupted run is visible and never silently resumed.
 * @param {object} opts see preflight + { keepReleases?: number, resume?: boolean }
 */
export async function deploy(opts, io) {
  const pre = await preflight(opts, io)
  const short = pre.sha.slice(0, 7)
  const dir = `${opts.releasesRoot}/${short}`
  const lockPath = `${opts.releasesRoot}/.deploy-lock`
  const journal = `${dir}/.deploy-state.json`
  await acquireLock(lockPath, io)
  // Maintenance-window bookkeeping: a window that opens but never reaches
  // the switch must be undone in the catch arm (restart the CURRENT release,
  // clear the flag) — a stopped app must never be left behind.
  let windowOpened = false
  let switched = false
  try {
    if (await io.exists(journal)) {
      if (!opts.resume) {
        throw new DeployRefused('DEPLOY_INTERRUPTED', `state journal exists at ${journal} — inspect it, then pass --resume to rerun clean`, await io.readJson(journal))
      }
      await io.rm(journal) // explicit --resume: rerun the whole pipeline clean
    }

    // 1) prepare the release directory (never mutates the online tree).
    // A live release dir is more than the git tree: it carries .env (copied
    // from the current release, never printed), the shared uploads symlinks
    // and the PM2 log dir — exactly what the running releases have.
    // git runs with -C so the deploy never depends on the shell's cwd.
    await io.exec(`mkdir -p ${dir}`)
    await io.exec(`git -C ${opts.repoDir ?? '.'} archive ${pre.sha} | tar -x -C ${dir}`)
    const prep = await io.exec(
      `cp -p ${pre.current.dir}/.env ${dir}/.env && ` +
        `ln -sfn ${opts.sharedRoot}/uploads ${dir}/public/uploads && ` +
        `ln -sfn ${opts.sharedRoot}/private-uploads ${dir}/private-uploads && ` +
        `mkdir -p ${dir}/logs`,
    )
    if (prep.code !== 0) {
      throw new DeployRefused('RELEASE_PREP_FAILED', 'could not stage runtime files (.env copy / shared uploads symlinks / logs dir) — online version untouched', prep.stderr)
    }
    await phase(journal, 'prepared', io)

    // 2) install + build INSIDE the new directory
    const build = await io.exec(`cd ${dir} && npm ci --no-audit --no-fund`, { timeoutMs: 600_000 })
    if (build.code !== 0) throw new DeployRefused('BUILD_FAILED', 'npm ci failed in release dir (online version untouched)', build.stderr)
    const gen = await io.exec(`cd ${dir} && npx prisma generate`, { timeoutMs: 120_000 })
    if (gen.code !== 0) throw new DeployRefused('BUILD_FAILED', 'prisma generate failed (online version untouched)', gen.stderr)
    const b = await io.exec(`cd ${dir} && npm run build`, { envFile: `${dir}/.env`, timeoutMs: 900_000 })
    if (b.code !== 0) throw new DeployRefused('BUILD_FAILED', 'npm run build failed (online version untouched)', b.stderr)
    const buildId = (await io.readFile(`${dir}/.next/BUILD_ID`)).trim()
    await phase(journal, 'built', io)

    // 3) migration phase — class decides ceremony
    const migrationHeadBefore = await io.migrationHead(opts.sharedRoot)
    if (pre.plan.needsWindow) {
      await io.exec(`touch ${opts.sharedRoot}/maintenance.flag`)
      await io.stopApp()
      windowOpened = true
      let conns = await io.appDbConnections()
      for (let i = 0; conns !== 0 && i < 5; i++) {
        await io.sleep(1000) // the stopped app needs a moment to close its sockets
        conns = await io.appDbConnections()
      }
      if (conns !== 0) {
        throw new DeployRefused('WRITE_STOP_FAILED', `app still holds ${conns} DB connections after stop — not migrating`, { conns })
      }
      await io.recordBaseline(opts.sharedRoot)
    }
    if (pre.migrations.cls !== MIGRATION_CLASS.NONE) {
      const m = await io.exec(`cd ${dir} && npx prisma migrate deploy`, { envFile: `${dir}/.env`, timeoutMs: 600_000 })
      if (m.code !== 0) {
        throw new DeployRefused('MIGRATION_FAILED', 'prisma migrate deploy failed — database left in migrated-or-partial state; recovery restarts the CURRENT release (old code on a possibly migrated schema — verify before reopening writes)', m.stderr)
      }
    }
    const migrationHeadAfter = await io.migrationHead(opts.sharedRoot)
    await phase(journal, 'migrated', io)

    // 4) manifest BEFORE the switch — write failure must abort early
    const manifest = {
      schema: 1,
      sha: pre.sha,
      shortSha: short,
      buildId,
      builtAt: new Date(io.now()).toISOString(),
      migrationHeadBefore,
      migrationHeadAfter,
      migrationClass: pre.migrations.cls,
      migrations: pre.migrations.added,
      previousRunning: { dir: pre.current.dir, sha: pre.current.sha },
      requiredCheck: pre.ci.check,
      acceptance: null, // filled after health checks
    }
    try {
      await io.writeJson(`${dir}/deploy-manifest.json`, manifest)
      await io.appendJsonl(`${opts.sharedRoot}/deploy-manifests.jsonl`, manifest)
    } catch (err) {
      throw new DeployRefused('MANIFEST_WRITE_FAILED', 'could not persist deploy manifest — aborting BEFORE switch', String(err))
    }
    await phase(journal, 'manifested', io)

    // 5) switch = PM2 re-register on the new release dir. Production has NO
    // symlink: /var/www/cas.cool is the git checkout (nginx serves /uploads/
    // from it directly) and the app's identity IS its PM2 cwd. Re-registering
    // the app against the new release dir is the existing switch mechanism.
    // pm2 delete runs before pm2 start: if start fails, the app slot is
    // EMPTY — bring the CURRENT release back up before refusing.
    try {
      await io.restartApp(dir)
    } catch (switchErr) {
      const switchRecovery = { previousRestarted: false }
      try {
        await io.restartApp(pre.current.dir)
        switchRecovery.previousRestarted = true
      } catch (e) {
        switchRecovery.restartError = String(e)
      }
      throw new DeployRefused(
        'SWITCH_FAILED',
        switchRecovery.previousRestarted
          ? 'pm2 re-register of the new release failed — the PREVIOUS release was brought back up; no switch happened'
          : 'pm2 re-register of the new release failed AND the previous release could not be restored — APP IS DOWN, manual intervention required',
        { switchError: String(switchErr), recovery: switchRecovery },
      )
    }
    switched = true
    await phase(journal, 'switched', io)

    // 6) health checks and the rollback decision (BUILD_ID probes THIS
    // release dir — the app was just re-registered onto it)
    const acceptance = await healthChecks(opts, io, dir)
    manifest.acceptance = acceptance
    await io.writeJson(`${dir}/deploy-manifest.json`, manifest)
    if (!acceptance.ok) {
      if (pre.migrations.cls === MIGRATION_CLASS.DESTRUCTIVE) {
        await phase(journal, 'needs-manual', io)
        throw new DeployRefused(
          'HEALTH_FAILED_NO_ROLLBACK',
          'health checks failed after a DESTRUCTIVE migration — code rollback would desync schema; new version stays up for manual triage and the maintenance flag is deliberately left UP',
          acceptance,
        )
      }
      await io.restartApp(pre.current.dir)
      await io.exec(`rm -f ${opts.sharedRoot}/maintenance.flag`)
      await phase(journal, 'rolled-back', io)
      await io.rm(journal)
      throw new DeployRefused('HEALTH_FAILED_ROLLED_BACK', 'health checks failed — app re-registered on the previous release (no DB rollback attempted)', acceptance)
    }
    await phase(journal, 'verified', io)

    // 7) retention — always keep the live dir plus keepReleases-1 predecessors,
    //    then conclude: clear the maintenance flag, journal and lock
    await retention(opts, pre, io)
    await io.exec(`rm -f ${opts.sharedRoot}/maintenance.flag`)
    await io.rm(journal)
    await io.rm(lockPath)
    return { ok: true, manifest, preflight: pre }
  } catch (err) {
    if (windowOpened && !switched) {
      // ANY failure between flag+stop and the switch (DeployRefused or a raw
      // io error like a broken baseline query) must undo the half-open
      // window: writes back on, current app back up.
      const recovery = { flagCleared: false, appRestarted: false }
      try {
        await io.exec(`rm -f ${opts.sharedRoot}/maintenance.flag`)
        recovery.flagCleared = true
      } catch { /* flag left in place; outcome reported below */ }
      try {
        await io.restartApp(pre.current.dir)
        recovery.appRestarted = true
      } catch (e) {
        recovery.restartError = String(e)
      }
      if (err && typeof err === 'object' && 'detail' in err && err.detail && typeof err.detail === 'object') {
        err.detail.maintenanceRecovery = recovery
      } else if (err instanceof Error) {
        err.message += ` | maintenance-recovery=${JSON.stringify(recovery)}`
      }
    }
    await io.rm(lockPath).catch(() => {})
    throw err
  }
}

async function healthChecks(opts, io, dir) {
  const results = []
  // pm2 start returns long before next.js boots: HTTP probes must retry
  // within a bounded readiness window, or every healthy deploy would be
  // falsely rolled back.
  const probeWithRetry = async (probe, attempts = 15) => {
    for (let i = 0; i < attempts; i++) {
      try {
        if (await io.healthProbe(probe)) return true
      } catch { /* connection refused while booting — retry */ }
      await io.sleep(2000)
    }
    return false
  }
  const probes = [
    { name: 'home', kind: 'GET', url: `${opts.origin}/`, retry: true },
    { name: 'api', kind: 'GET', url: `${opts.origin}/api/posts?take=1`, retry: true },
    { name: 'mcp-initialize', kind: 'MCP', url: `${opts.origin}/mcp`, retry: true },
    { name: 'db', kind: 'DB', url: 'SELECT 1' },
    { name: 'build-marker', kind: 'BUILD_ID', url: dir },
  ]
  for (const probe of probes) {
    try {
      const ok = probe.retry ? await probeWithRetry(probe) : await io.healthProbe(probe)
      results.push({ probe: probe.name, ok })
    } catch (err) {
      results.push({ probe: probe.name, ok: false, error: String(err) })
    }
  }
  return { ok: results.every((r) => r.ok), results, at: new Date(io.now()).toISOString() }
}

async function retention(opts, pre, io) {
  const keep = opts.keepReleases ?? 2
  const entries = await io.readdir(opts.releasesRoot)
  const candidates = entries.filter((e) => /^[0-9a-f]{7,40}$/.test(e))
  // compare on directory NAMES end to end — never mix paths and names in the keep set
  const mandatory = new Set([pre.sha.slice(0, 7), pre.current.dir.split('/').pop()])
  const withTime = []
  for (const name of candidates) {
    withTime.push({ name, mtime: await io.mtime(`${opts.releasesRoot}/${name}`) })
  }
  withTime.sort((a, b) => b.mtime - a.mtime)
  const keepSet = new Set(mandatory)
  for (const entry of withTime) {
    if (keepSet.size >= keep) break
    keepSet.add(entry.name)
  }
  const doomed = candidates.filter((name) => !keepSet.has(name))
  for (const name of doomed) {
    await io.exec(`rm -rf ${opts.releasesRoot}/${name}`)
  }
  return { kept: [...keepSet], removed: doomed }
}

async function acquireLock(lockPath, io) {
  if (await io.exists(lockPath)) {
    let lock = null
    try {
      lock = await io.readJson(lockPath)
    } catch {
      lock = null // unreadable/corrupt lock file — treat as stale, reclaim
    }
    if (lock && io.pidAlive(lock.pid)) {
      throw new DeployRefused('DEPLOY_LOCKED', `another deploy (pid ${lock.pid}, sha ${String(lock.sha).slice(0, 8)}) is running`, lock)
    }
    await io.rm(lockPath) // stale lock — reclaim
  }
  await io.writeJson(lockPath, { pid: io.selfPid(), sha: 'pending', ts: io.now() })
}

async function phase(journal, name, io) {
  const state = (await io.exists(journal)) ? await io.readJson(journal) : { phases: [] }
  state.phases.push({ phase: name, at: new Date(io.now()).toISOString() })
  await io.writeJson(journal, state)
}
