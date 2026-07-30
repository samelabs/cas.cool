/**
 * User service — profile lookups, trending, suggestions.
 * Shared by Server Components (SSR) and Server Actions.
 */

import { cache } from 'react'
import { prisma } from '@/lib/db'
import { userSelect, serializeUser, serializeUsers } from '@/lib/serialize'
import type { SafeUser } from '@/lib/types'

// ─── User Lookups ─────────────────────────────────────────────

// All lookups wrapped in React cache() to deduplicate calls within a single
// request (e.g. generateMetadata + page component both calling
// getUserWithCounts for the same username → 1 DB round-trip instead of 2).

export const getUserByUsername = cache(async (username: string): Promise<SafeUser | null> => {
  const raw = await prisma.user.findUnique({ where: { username }, select: { ...userSelect } })
  return raw ? serializeUser(raw) : null
})

export const getUserById = cache(async (userId: string): Promise<SafeUser | null> => {
  const raw = await prisma.user.findUnique({ where: { id: userId }, select: { ...userSelect } })
  return raw ? serializeUser(raw) : null
})

export const getUserCounts = cache(async (userId: string): Promise<{ posts: number; followers: number; following: number }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { postCount: true, followerCount: true, followingCount: true },
  })
  return user
    ? { posts: user.postCount, followers: user.followerCount, following: user.followingCount }
    : { posts: 0, followers: 0, following: 0 }
})

export const getUserWithCounts = cache(async (username: string): Promise<SafeUser | null> => {
  // getUserByUsername already returns _count populated from denormalized scalars.
  return getUserByUsername(username)
})

// ─── Trending ─────────────────────────────────────────────────

export interface TrendingChemical {
  casNumber: string
  name: string | null
  postCount: number
}

export async function getTrendingChemicals(limit: number = 5): Promise<TrendingChemical[]> {
  try {
    return await prisma.chemical.findMany({
      where: { postCount: { gt: 0 } },
      orderBy: { postCount: 'desc' },
      take: limit,
      select: { casNumber: true, name: true, postCount: true },
    })
  } catch {
    return []
  }
}

// ─── Follow Suggestions ───────────────────────────────────────

export async function getFollowSuggestions(
  userId: string,
  limit: number = 5,
): Promise<SafeUser[]> {
  try {
    const users = await prisma.user.findMany({
      where: {
        id: { not: userId },
        followers: { none: { followerId: userId } },
      },
      select: userSelect,
      orderBy: { followerCount: 'desc' },
      take: limit,
    })
    return serializeUsers(users)
  } catch {
    return []
  }
}
