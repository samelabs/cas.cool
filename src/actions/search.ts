'use server'

import { getCurrentUser } from '@/lib/auth'
import { canSearch } from '@/lib/permissions'
import { ActionResult, ActionError } from './_shared'
import { withResult } from './_guards'
import { searchPostsFirstPage, getSearchSuggestions } from '@/lib/services/search.service'
import type { SafePost, SafeUser } from '@/lib/types'

export interface SearchResult {
  posts: SafePost[]
  nextCursor: string | null
  users?: SafeUser[]
  chemicals?: Array<{ casNumber: string; name: string | null; postCount: number }>
}

export async function searchPosts(query: string, cursor?: string, take?: number): Promise<ActionResult<SearchResult>> {
  return withResult(async () => {
    const q = query.trim()
    if (q.length < 2) return { posts: [], nextCursor: null }
    if (q.length > 200) throw new ActionError('BAD_REQUEST', 'Query too long.')

    const user = await getCurrentUser()
    if (!user || !canSearch(user)) throw new ActionError('FORBIDDEN', 'Verification required to search.')

    const firstPage = await searchPostsFirstPage(q, user.id, take)

    // Suggestions only on first page (no cursor)
    if (!cursor) {
      const { users, chemicals } = await getSearchSuggestions(q)
      return {
        posts: firstPage.posts,
        nextCursor: firstPage.nextCursor,
        users,
        chemicals,
      }
    }

    return firstPage
  })
}
