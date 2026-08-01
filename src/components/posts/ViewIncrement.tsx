'use client'

import { useEffect, useRef } from 'react'
import { post } from '@/lib/api-client'

/**
 * Fire-and-forget view increment on mount.
 * Calls POST /api/posts/[code]/view once when the post detail page loads.
 */
export default function ViewIncrement({ code }: { code: string }) {
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    post('/api/posts/' + code + '/view').catch(() => {})
  }, [code])

  return null
}
