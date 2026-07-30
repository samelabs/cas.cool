'use client'

import { useState } from 'react'
import Link from 'next/link'
import { getInitials } from '@/lib/utils'
import { cn } from '@/lib/cn'
import type { SafeUser } from '@/lib/types'

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl'

export interface AvatarProps {
  user?: SafeUser
  src?: string | null
  name?: string
  username?: string
  size?: AvatarSize
  href?: string
  className?: string
}

const SIZE_BOX: Record<AvatarSize, string> = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
  xl: 'w-24 h-24',
  '2xl': 'w-32 h-32',
  '3xl': 'w-40 h-40',
}

const SIZE_TEXT: Record<AvatarSize, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
  xl: 'text-3xl',
  '2xl': 'text-4xl',
  '3xl': 'text-5xl',
}

function hueFor(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) % 360
  }
  return h
}

export function Avatar({
  user,
  src,
  name,
  username,
  size = 'md',
  href,
  className,
}: AvatarProps) {
  const imageSrc = src ?? user?.avatar ?? null
  const resolvedName = name ?? user?.displayName ?? user?.username ?? '?'
  const resolvedUsername = username ?? user?.username
  const initials = getInitials(resolvedName) || '?'
  const seed = resolvedUsername || resolvedName || 'user'
  const bg = `hsl(${hueFor(seed)} 55% 45%)`

  const [imgError, setImgError] = useState(false)
  const showImage = imageSrc && !imgError

  const inner = showImage ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageSrc}
      alt={resolvedName}
      className="h-full w-full rounded-[inherit] object-cover"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setImgError(true)}
    />
  ) : (
    <span
      className={cn(
        'flex h-full w-full items-center justify-center rounded-[inherit] font-bold text-white',
        SIZE_TEXT[size],
      )}
      style={{ backgroundColor: bg }}
    >
      {initials}
    </span>
  )

  // Padding-based seal: the container provides a thin solid background ring
  // (p-0.5 + bg-surface) that closes the sub-pixel anti-alias gap at the
  // rounded edge. The image rounds itself via rounded-[inherit] — no
  // overflow-hidden clipping, so no container-edge sampling seam.
  const node = (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-surface p-0.5',
        SIZE_BOX[size],
        className,
      )}
    >
      {inner}
    </span>
  )

  const linkHref = href ?? (user ? `/u/${user.username}` : undefined)

  if (linkHref) {
    return (
      <Link href={linkHref} className={cn('shrink-0 rounded-full hover:opacity-90 transition-opacity', className)}>
        {node}
      </Link>
    )
  }
  return node
}

export default Avatar
