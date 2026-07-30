'use client'

import { useEffect, useRef, useState } from 'react'

export interface PullToRefreshState {
  pullDistance: number
  isPulling: boolean
  isRefreshing: boolean
  isArmed: boolean
}

interface PullToRefreshOptions {
  onRefresh: () => Promise<void>
  threshold?: number
  maxPull?: number
  resistance?: number
}

/**
 * Touch-only pull-to-refresh gesture hook.
 *
 * Activates when the user touches the screen at scrollY === 0 and drags
 * downward. Applies rubber-band resistance so the pull gets harder the
 * further you drag. On release past `threshold`, calls `onRefresh` and
 * shows a spinner until the promise resolves.
 *
 * Desktop / non-touch devices: returns a permanently idle state (the
 * effect attaches no listeners).
 *
 * Requires `overscroll-behavior-y: contain` on the root scroller (html)
 * to suppress the browser's native pull-to-refresh — set in globals.css.
 */
export function usePullToRefresh({
  onRefresh,
  threshold = 65,
  maxPull = 110,
  resistance = 0.45,
}: PullToRefreshOptions): PullToRefreshState {
  const [pullDistance, setPullDistance] = useState(0)
  const [isPulling, setIsPulling] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Refs mirror state for use inside event handlers without re-attaching
  // listeners on every state change.
  const startYRef = useRef(0)
  const trackingRef = useRef(false)
  const pullDistRef = useRef(0)
  const visualPullingRef = useRef(false)
  const refreshingRef = useRef(false)
  const onRefreshRef = useRef(onRefresh)
  const thresholdRef = useRef(threshold)

  useEffect(() => { onRefreshRef.current = onRefresh }, [onRefresh])
  useEffect(() => { thresholdRef.current = threshold }, [threshold])

  useEffect(() => {
    // Skip on non-touch devices — pull-to-refresh is touch-only.
    if (!('ontouchstart' in window)) return

    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 0 || refreshingRef.current) return
      if (e.touches.length !== 1) return
      startYRef.current = e.touches[0].clientY
      trackingRef.current = true
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!trackingRef.current || refreshingRef.current) return
      const deltaY = e.touches[0].clientY - startYRef.current

      if (deltaY <= 0) {
        if (pullDistRef.current !== 0) {
          pullDistRef.current = 0
          setPullDistance(0)
          visualPullingRef.current = false
          setIsPulling(false)
        }
        return
      }

      // Prevent native overscroll/refresh behaviour
      if (window.scrollY === 0) {
        e.preventDefault()
      }

      const distance = Math.min(deltaY * resistance, maxPull)
      pullDistRef.current = distance
      setPullDistance(distance)

      if (!visualPullingRef.current && distance > 2) {
        visualPullingRef.current = true
        setIsPulling(true)
      }
    }

    const onTouchEnd = async () => {
      if (!trackingRef.current) return
      trackingRef.current = false

      if (pullDistRef.current >= thresholdRef.current) {
        // Triggered — hold at threshold height and refresh
        visualPullingRef.current = false
        setIsPulling(false)
        refreshingRef.current = true
        setIsRefreshing(true)
        pullDistRef.current = thresholdRef.current
        setPullDistance(thresholdRef.current)

        try {
          await onRefreshRef.current()
        } finally {
          refreshingRef.current = false
          setIsRefreshing(false)
          setPullDistance(0)
          pullDistRef.current = 0
        }
      } else {
        visualPullingRef.current = false
        setIsPulling(false)
        setPullDistance(0)
        pullDistRef.current = 0
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', onTouchEnd, { passive: true })

    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [threshold, maxPull, resistance])

  return {
    pullDistance,
    isPulling,
    isRefreshing,
    isArmed: pullDistance >= threshold,
  }
}
