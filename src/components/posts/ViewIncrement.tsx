'use client'

import { useEffect, useRef } from 'react'
import { incrementView } from '@/actions/posts'

/**
 * Fire-and-forget view increment on mount.
 * Calls the incrementView Server Action once when the post detail page loads.
 */
export default function ViewIncrement({ postId }: { postId: string }) {
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    fired.current = true
    incrementView(postId).catch(() => {})
  }, [postId])

  return null
}
