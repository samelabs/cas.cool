import { describe, it, expect, vi } from 'vitest'
import { dropTestDatabaseWithExecutor } from './helpers/db'

describe('Database Lifecycle: Teardown Fault Injection & Cleanup Error Exposure', () => {
  it('retries on transient errors and succeeds when subsequent attempt passes', async () => {
    let calls = 0
    const mockExecutor = vi.fn(async () => {
      calls++
      if (calls === 1) {
        throw new Error('database "cascool_test" is being accessed by other users')
      }
      // succeeds on attempt 2
    })

    await expect(dropTestDatabaseWithExecutor(mockExecutor, 0)).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it('exhausts retry attempts on persistent transient errors and throws final error', async () => {
    let calls = 0
    const mockExecutor = vi.fn(async () => {
      calls++
      throw new Error('permission denied to terminate process')
    })

    await expect(dropTestDatabaseWithExecutor(mockExecutor, 0)).rejects.toThrow(
      /Failed to drop test database after 3 attempts: permission denied to terminate process/,
    )
    expect(calls).toBe(3)
  })

  it('immediately throws unknown non-transient errors without retrying', async () => {
    let calls = 0
    const mockExecutor = vi.fn(async () => {
      calls++
      throw new Error('ECONNREFUSED: connection to 127.0.0.1:5432 failed')
    })

    await expect(dropTestDatabaseWithExecutor(mockExecutor, 0)).rejects.toThrow(
      /ECONNREFUSED/,
    )
    expect(calls).toBe(1)
  })
})
