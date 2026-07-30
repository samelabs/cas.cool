import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { config } from './config'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: config.dbPoolSize,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'cascool-public-api',
})

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect()
  await pool.end()
}
