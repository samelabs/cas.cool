import 'server-only'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { CorePost, SafeChemical, SafePost } from '@/lib/types'

/**
 * Attach cas.cool's compound tags to a page of core posts in ONE bounded
 * query (post ids + quoted-post ids collected first). The feed/post core
 * never loads or serializes the Chemical relation — this module is where
 * core posts become the product's public post views.
 */
export async function attachPostChemicals(
  posts: CorePost[],
  db: Pick<Prisma.TransactionClient, 'post'> = prisma,
): Promise<SafePost[]> {
  const ids = new Set<string>()
  const collect = (post: CorePost) => {
    ids.add(post.id)
    if (post.quotedPost) collect(post.quotedPost)
  }
  posts.forEach(collect)
  if (ids.size === 0) return []

  const rows = await db.post.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      // Only the fields embedded in posts. name + smiles are deliberately
      // excluded: system-maintained metadata shown ONLY on the CAS detail
      // page. Post cards show just the CAS number as a tag.
      chemicals: { select: { id: true, casNumber: true, postCount: true } },
    },
  })
  const byPost = new Map<string, SafeChemical[]>(
    rows.map((row) => [row.id, row.chemicals as SafeChemical[]]),
  )
  const attach = (post: CorePost): SafePost => ({
    ...post,
    quotedPost: post.quotedPost ? attach(post.quotedPost) : null,
    chemicals: byPost.get(post.id) ?? [],
  })
  return posts.map(attach)
}

export async function attachPostChemical(
  post: CorePost,
  db?: Pick<Prisma.TransactionClient, 'post'>,
): Promise<SafePost> {
  return (await attachPostChemicals([post], db))[0]
}
