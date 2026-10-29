import { SERVER_URL } from './env'

export interface Session {
  username: string
  email: string
  cookie: string
  password: string
}

export async function api(
  path: string,
  init: RequestInit & { bearer?: string; cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.bearer) headers.set('Authorization', `Bearer ${init.bearer}`)
  if (init.cookie) headers.set('Cookie', init.cookie)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${SERVER_URL}${path}`, { ...init, headers })
}

/** Register a fresh user and return their session cookie. Unique per call. */
export async function registerAndLogin(seed: string): Promise<Session> {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const username = `t_${seed}_${tag}`.slice(0, 20)
  const email = `${username}@test.local`
  const password = 'password-123'

  const res = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, username, password }),
  })
  if (res.status !== 201) {
    throw new Error(`register failed (${res.status}): ${await res.text()}`)
  }
  const cookie = sessionCookie(res)
  if (!cookie) throw new Error('register did not set feed_session cookie')
  return { username, email, cookie, password }
}

export function sessionCookie(res: Response): string | null {
  const setCookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const c of setCookies) {
    const pair = c.split(';')[0]
    if (pair.startsWith('feed_session=')) return pair
  }
  return null
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}
