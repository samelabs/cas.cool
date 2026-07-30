function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export const config = {
  host: process.env.PUBLIC_API_HOST || '127.0.0.1',
  port: boundedInteger('PUBLIC_API_PORT', 8001, 1, 65535),
  dbPoolSize: boundedInteger('PUBLIC_API_DB_POOL_SIZE', 5, 1, 20),
  bodyLimitBytes: boundedInteger('PUBLIC_API_BODY_LIMIT_BYTES', 64 * 1024, 1024, 1024 * 1024),
  requestTimeoutMs: boundedInteger('PUBLIC_API_REQUEST_TIMEOUT_MS', 15_000, 1000, 60_000),
} as const

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.')
}
