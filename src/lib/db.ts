import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX) || 10,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

// Cache on globalThis in ALL environments (including production).
// Next.js with Turbopack can re-instantiate modules per route segment;
// without globalThis caching, each instance gets a fresh Prisma client
// with an empty query plan cache — causing "cold start" latency on every
// request that touches an uncached query shape.
globalForPrisma.prisma = prisma

export default prisma
