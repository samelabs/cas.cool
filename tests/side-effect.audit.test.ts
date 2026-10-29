import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { PrismaClient } from '@prisma/client'
import { dropTestDatabase, provisionTestDatabase, sql } from './helpers/db'
import { TEST_DATABASE_URL } from './helpers/env'
import type { NotificationPayload, SideEffectExecutorMap } from '@/lib/services/side-effect.service'

const db = vi.hoisted(() => ({ prisma: null as unknown as PrismaClient }))
vi.mock('@/lib/db', () => db)
let pool: Pool
let outbox: typeof import('@/lib/services/side-effect.service')

beforeAll(async () => {
  await provisionTestDatabase()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  pool = new Pool({ connectionString: TEST_DATABASE_URL })
  db.prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  outbox = await import('@/lib/services/side-effect.service')
})

afterAll(async () => {
  await db.prisma?.$disconnect()
  await pool?.end()
  await dropTestDatabase()
})
afterEach(async () => { await sql('DELETE FROM "SideEffectTask"') })

async function seedTasks(ids: string[]) {
  for (const [index, id] of ids.entries()) {
    await sql(`INSERT INTO "SideEffectTask" (id, kind, payload, "createdAt", "updatedAt")
      VALUES ($1, 'notification', $2::jsonb, now() + $3 * interval '1 second', now())`,
    [id, JSON.stringify({ eventKey: id }), index])
  }
}

function executors(notification: (payload: NotificationPayload) => Promise<void>): SideEffectExecutorMap {
  return { notification, upload_cleanup: async () => {} }
}

describe('outbox selection and lease ownership', () => {
  it('an explicitly empty id selection cannot drain unrelated pending tasks', async () => {
    await seedTasks(['audit_empty'])
    const execute = vi.fn(async () => {})
    const result = await outbox.drainSideEffects({ ids: [], executors: executors(execute) })
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ attempted: 0, succeeded: 0, failed: 0, pending: 1 })
  })

  it('a queued task reclaimed by another worker is skipped before execution', async () => {
    await seedTasks(['audit_first', 'audit_second'])
    const calls: string[] = []
    const execute = executors(async (payload) => {
      calls.push(payload.eventKey!)
      if (payload.eventKey === 'audit_first') {
        // While the first executor runs, another worker takes the second
        // task after its batch claim expires. No real-time sleep needed.
        await sql(`UPDATE "SideEffectTask" SET "claimedAt" = now() - interval '61 seconds'
          WHERE id = $1`, ['audit_second'])
        const next = await outbox.drainSideEffects({ ids: ['audit_second'], executors: execute })
        expect(next.succeeded).toBe(1)
      }
    })
    const result = await outbox.drainSideEffects({
      ids: ['audit_first', 'audit_second'], executors: execute,
    })
    expect(calls).toEqual(['audit_first', 'audit_second'])
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0, pending: 0 })
  })

  it('a stale executor cannot report another owner\'s completion as its own success', async () => {
    await seedTasks(['audit_stale'])
    const result = await outbox.drainSideEffects({
      ids: ['audit_stale'],
      executors: executors(async () => {
        await sql(`UPDATE "SideEffectTask" SET "claimedAt" = now() - interval '61 seconds'
          WHERE id = $1`, ['audit_stale'])
        const current = await outbox.drainSideEffects({
          ids: ['audit_stale'], executors: executors(async () => {}),
        })
        expect(current.succeeded).toBe(1)
      }),
    })
    expect(result).toMatchObject({ attempted: 1, succeeded: 0, failed: 0, pending: 0 })
  })
})
