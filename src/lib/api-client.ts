/**
 * Client-side API helper — single fetch wrapper for all Route Handler calls.
 *
 * Every component uses this instead of Server Actions. Handles:
 *   - JSON serialization / parsing
 *   - Error extraction (returns { ok, data, error })
 *   - Same-origin credentials (cookies)
 */

export interface ApiResult<T> {
  ok: boolean
  data: T | null
  error: string | null
  status: number
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult<T>> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {
      ...headers,
    },
  }

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body
    } else {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
  }

  const res = await fetch(url, init)
  const text = await res.text()

  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  if (!res.ok) {
    const errorBody = parsed as { error?: { code?: string; message?: string } } | null
    return {
      ok: false,
      data: null,
      error: errorBody?.error?.message || `Request failed (${res.status})`,
      status: res.status,
    }
  }

  return {
    ok: true,
    data: parsed as T,
    error: null,
    status: res.status,
  }
}

/** GET request. */
export function get<T>(url: string): Promise<ApiResult<T>> {
  return request<T>('GET', url)
}

/** POST request with JSON body. */
export function post<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>('POST', url, body)
}

/** POST request with FormData (multipart upload). */
export function postForm<T>(url: string, formData: FormData): Promise<ApiResult<T>> {
  return request<T>('POST', url, formData)
}

/** PATCH request with JSON body. */
export function patch<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>('PATCH', url, body)
}

/** DELETE request. */
export function del<T>(url: string): Promise<ApiResult<T>> {
  return request<T>('DELETE', url)
}

/** SWR-compatible fetcher (GET, returns parsed JSON or throws). */
export async function swrFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || `Request failed (${res.status})`)
  }
  return res.json()
}
