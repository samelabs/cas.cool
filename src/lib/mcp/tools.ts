/**
 * MCP Tool definitions, schemas, annotations, and execution handlers.
 * Single source of truth for all tools exposed via /mcp.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { prisma } from '@/lib/db'
import { getSiteConfig } from '@/lib/site'
import { computeCapabilities, canSearch, canUploadMedia } from '@/lib/permissions'
import { writeAccessError, type AuthIdentity } from '@/lib/api-auth'
import { validateTimelineCursor } from '@/lib/pagination'
import {
  getTimelinePage,
  getPostByShortCode,
  getPostChain,
  PostServiceError,
} from '@/lib/services/post.service'
import { searchPostsFirstPage, searchPostsAfterCursor } from '@/lib/services/search.service'
import { createPost, editPost, deletePost } from '@/lib/services/post-write.service'
import { setPostInteraction, type InteractionAction } from '@/lib/services/interaction.service'
import { setUserFollow } from '@/lib/services/follow.service'
import {
  getNotificationsPage,
  getUnreadNotificationCount,
  InvalidNotificationCursorError,
} from '@/lib/services/notify.service'
import { serializeUser, userSelect } from '@/lib/serialize'

/** Retention window for create_post idempotency keys. */
export const POST_REQUEST_KEY_TTL_MS = 24 * 60 * 60 * 1000

interface ToolErrorOptions {
  /** Programmatic next step — stable text the agent can act on. */
  recovery?: string
  retryAfterSec?: number
}

/**
 * Stable, machine-judgeable tool error: `structuredContent.error` carries a
 * code (matchable without NLP), the human message, an optional recovery
 * direction and retryAfterSec for rate limits. The text content mirrors it
 * for clients that only read text.
 */
type McpToolResult = {
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
}

function toolError(code: string, message: string, opts: ToolErrorOptions = {}): McpToolResult {
  const error: Record<string, unknown> = { code, message }
  if (opts.recovery) error.recovery = opts.recovery
  if (opts.retryAfterSec !== undefined) error.retryAfterSec = opts.retryAfterSec
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `${message}${opts.recovery ? ` Recovery: ${opts.recovery}` : ''}`,
    }],
    structuredContent: { error },
  }
}

const NOT_FOUND_RECOVERY = 'The object may have been deleted, or the identifier is wrong. Refresh your view via list_posts or search_posts before acting further.'
const PERMISSION_RECOVERY = 'Re-run get_capabilities to see the current effective permissions; the account standing (verification/restriction) controls write access dynamically.'

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
    [key: string]: unknown
  }
  annotations?: ToolAnnotations
  isMutation: boolean
  handler: (args: unknown, identity: AuthIdentity) => Promise<{
    isError?: boolean
    content: Array<{ type: 'text'; text: string }>
    structuredContent?: unknown
  }>
}

/**
 * Generate standard JSON Schema from a ZodObject without drift.
 * Emits full constraints, properties, required fields, and strict additionalProperties.
 */
export function zodToInputSchema(schema: z.ZodObject<z.ZodRawShape>): {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
} {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
  return {
    ...jsonSchema,
    type: 'object',
    properties: (jsonSchema.properties as Record<string, unknown>) || {},
  }
}

const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/

// ── Read Tools ───────────────────────────────────────────────

const getCapabilitiesSchema = z.object({}).strict()

const getCapabilitiesTool: McpToolDefinition = {
  name: 'get_capabilities',
  description: 'Get current caller identity, verification status, effective permissions, and rate limits.',
  inputSchema: zodToInputSchema(getCapabilitiesSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = getCapabilitiesSchema.safeParse(args ?? {})
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const caps = computeCapabilities(identity)
    return {
      content: [{ type: 'text', text: JSON.stringify(caps, null, 2) }],
      structuredContent: caps,
    }
  },
}

const listPostsSchema = z.object({
  tab: z.enum(['latest', 'foryou', 'following']).describe('Timeline feed tab').optional(),
  author: z.string().describe('Filter by author username (latest tab only)').optional(),
  cas: z.string().describe('Filter by CAS Registry Number (e.g. 64-17-5, latest tab only)').optional(),
  cursor: z.string().describe('Keyset or timestamp cursor for pagination').optional(),
  take: z.number().int().min(1).max(50).describe('Number of posts to return (1-50)').optional(),
}).strict()

const listPostsTool: McpToolDefinition = {
  name: 'list_posts',
  description: 'List posts from the timeline (tabs: latest, foryou, following). Supports cursor pagination, CAS filtering, and author username filtering.',
  inputSchema: zodToInputSchema(listPostsSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = listPostsSchema.safeParse(args || {})
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const tab = parsed.data.tab ?? 'latest'
    const take = parsed.data.take ?? 20
    const { author, cas, cursor } = parsed.data
    const userId = identity.user?.id ?? null

    if (tab === 'following' && !userId) {
      return toolError('unauthorized', 'Authentication required for following feed.', { recovery: 'Provide a valid API key via the Authorization header.' })
    }

    if (cas) {
      if (!CAS_FORMAT.test(cas)) {
        return toolError('invalid_arguments', 'Invalid CAS number format (must match \\d{2,7}-\\d{2}-\\d).')
      }
      if (tab !== 'latest') {
        return toolError('invalid_arguments', 'CAS filtering requires latest feed.')
      }
    }

    let resolvedAuthorId: string | undefined = undefined
    if (author) {
      if (tab !== 'latest') {
        return toolError('invalid_arguments', 'Author filtering requires latest feed.')
      }
      const targetUser = await prisma.user.findUnique({
        where: { username: author.toLowerCase() },
        select: { id: true },
      })
      if (!targetUser) {
        // Unknown user: return empty feed cleanly
        const emptyResult = { posts: [], nextCursor: null }
        return {
          content: [{ type: 'text', text: JSON.stringify(emptyResult, null, 2) }],
          structuredContent: emptyResult,
        }
      }
      resolvedAuthorId = targetUser.id
    }

    if (cursor) {
      const isSpecialFilter = Boolean(resolvedAuthorId || cas)
      if (!validateTimelineCursor(cursor, tab, isSpecialFilter)) {
        return toolError('invalid_cursor', 'Invalid cursor.', { recovery: 'Only pass cursor/nextCursor values returned by the same tool.' })
      }
    }

    const site = await getSiteConfig()
    const page = await getTimelinePage({
      tab,
      author: resolvedAuthorId,
      cas,
      cursor,
      take,
      userId,
    })

    const postsWithUrls = page.posts.map((post) => ({
      ...post,
      url: `${site.origin}/p/${post.shortCode}`,
    }))

    const result = { posts: postsWithUrls, nextCursor: page.nextCursor }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

const getPostSchema = z.object({
  shortCode: z.string().min(1).max(32).describe('The shortCode of the post'),
}).strict()

const getPostTool: McpToolDefinition = {
  name: 'get_post',
  description: 'Get a single post by its shortCode. Returns a not_found error if missing or soft-deleted.',
  inputSchema: zodToInputSchema(getPostSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = getPostSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const userId = identity.user?.id ?? null
    const post = await getPostByShortCode(parsed.data.shortCode, userId)
    if (!post || post.deletedAt) {
      return toolError('not_found', 'Post not found.', { recovery: NOT_FOUND_RECOVERY })
    }
    const site = await getSiteConfig()
    const result = {
      ...post,
      url: `${site.origin}/p/${post.shortCode}`,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

const getPostDiscussionSchema = z.object({
  shortCode: z.string().min(1).max(32).describe('The shortCode of the target post'),
  cursor: z.string().describe('Pagination cursor for subsequent direct replies').optional(),
  take: z.number().int().min(1).max(50).describe('Number of direct replies to return (1-50, default 20)').optional(),
  ancestorTake: z.number().int().min(1).max(50).describe('Maximum number of ancestors to return (1-50, default 20)').optional(),
  ancestorCursor: z.string().describe('Pass nextAncestorCursor from the previous response for the same target post.').optional(),
}).strict()

const getPostDiscussionTool: McpToolDefinition = {
  name: 'get_post_discussion',
  description: 'Read a full discussion thread: target post, ancestor conversation chain, and paginated replies.',
  inputSchema: zodToInputSchema(getPostDiscussionSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = getPostDiscussionSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { shortCode, cursor, ancestorCursor } = parsed.data
    const take = parsed.data.take ?? 20
    const ancestorTake = parsed.data.ancestorTake ?? 20
    const userId = identity.user?.id ?? null

    const post = await getPostByShortCode(shortCode, userId)
    if (!post || post.deletedAt) {
      return toolError('not_found', 'Post not found.', { recovery: NOT_FOUND_RECOVERY })
    }

    if (cursor && !validateTimelineCursor(cursor, 'latest', true)) {
      return toolError('invalid_cursor', 'Invalid cursor.', { recovery: 'Only pass cursor/nextCursor values returned by the same tool.' })
    }
    if (ancestorCursor && (typeof ancestorCursor !== 'string' || ancestorCursor.length > 512)) {
      return toolError('invalid_cursor', 'Invalid ancestorCursor.', { recovery: 'Only pass nextAncestorCursor values returned by get_post_discussion for the same target post.' })
    }

    const isInitialCall = cursor === undefined && ancestorCursor === undefined
    const shouldFetchAncestors = ancestorCursor !== undefined || isInitialCall
    const shouldFetchReplies = cursor !== undefined || isInitialCall

    const site = await getSiteConfig()
    const attachUrl = <T extends { shortCode: string | null }>(p: T) => ({
      ...p,
      url: p.shortCode ? `${site.origin}/p/${p.shortCode}` : null,
    })

    const result: Record<string, unknown> = {
      post: attachUrl(post),
    }

    // Fetch bounded ancestors whenever ancestors are in play. This ALWAYS
    // routes through the shared chain service — including for ROOT posts —
    // so a supplied ancestorCursor is signature-verified and target-bound
    // before any query; a root post with a foreign/tampered/bare cursor is
    // rejected exactly like a reply would be, and a root post WITHOUT a
    // cursor simply returns an empty ancestor page.
    if (shouldFetchAncestors) {
      try {
        const chainResult = await getPostChain(post.id, post.conversationId || post.parentId, userId, {
          limit: ancestorTake,
          cursor: ancestorCursor || null,
        })
        result.ancestors = chainResult.ancestors.map(attachUrl)
        result.ancestorsTruncated = chainResult.hasMoreAncestors
        result.hasMoreAncestors = chainResult.hasMoreAncestors
        result.oldestAncestorId = chainResult.oldestAncestorId
        result.nextAncestorCursor = chainResult.nextAncestorCursor
      } catch (err: unknown) {
        if (err instanceof PostServiceError) {
          return toolError('invalid_cursor', `Invalid ancestorCursor: ${err.message}`, { recovery: 'Only pass nextAncestorCursor values returned by get_post_discussion for the same target post.' })
        }
        throw err
      }
    }

    // Fetch replies when initial call or explicitly advancing replies
    if (shouldFetchReplies) {
      const repliesPage = await getTimelinePage({
        tab: 'latest',
        repliesOf: post.id,
        cursor,
        take,
        userId,
      })
      result.replies = repliesPage.posts.map(attachUrl)
      result.hasMoreReplies = Boolean(repliesPage.nextCursor)
      result.nextCursor = repliesPage.nextCursor
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

const searchPostsSchema = z.object({
  query: z.string().min(2).max(200).describe('Search term or CAS number'),
  cursor: z.string().describe('Keyset cursor for subsequent pages').optional(),
  limit: z.number().int().min(1).max(50).describe('Number of posts to return (1-50)').optional(),
}).strict()

const searchPostsTool: McpToolDefinition = {
  name: 'search_posts',
  description: 'Search posts by keyword or CAS number. Requires verified membership.',
  inputSchema: zodToInputSchema(searchPostsSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = searchPostsSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    if (!canSearch(identity.user)) {
      return toolError('forbidden', 'Verification is required to use search.', { recovery: PERMISSION_RECOVERY })
    }
    const { query, cursor } = parsed.data
    const limit = parsed.data.limit ?? 20
    const userId = identity.user?.id ?? null
    const site = await getSiteConfig()
    const page = cursor
      ? await searchPostsAfterCursor(query, userId, cursor, limit)
      : await searchPostsFirstPage(query, userId, limit)

    const postsWithUrls = page.posts.map((post) => ({
      ...post,
      url: `${site.origin}/p/${post.shortCode}`,
    }))

    const result = { posts: postsWithUrls, nextCursor: page.nextCursor }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

const getChemicalSchema = z.object({
  casNumber: z.string().min(3).max(20).describe('CAS Registry Number (e.g. 64-17-5)'),
}).strict()

const getChemicalTool: McpToolDefinition = {
  name: 'get_chemical',
  description: 'Get chemical compound details, SMILES, and community post stats by CAS number.',
  inputSchema: zodToInputSchema(getChemicalSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args) => {
    const parsed = getChemicalSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { casNumber } = parsed.data
    if (!CAS_FORMAT.test(casNumber)) {
      return toolError('invalid_arguments', 'Invalid CAS number format (must match \\d{2,7}-\\d{2}-\\d).')
    }
    const chemical = await prisma.chemical.findUnique({
      where: { casNumber },
      select: { casNumber: true, name: true, smiles: true, banned: true, postCount: true, createdAt: true },
    })
    if (!chemical) {
      return toolError('not_found', 'Chemical not found.', { recovery: 'Check the CAS number format and spelling; discover existing ones via list_posts with a cas filter.' })
    }
    const site = await getSiteConfig()
    const result = {
      ...chemical,
      url: `${site.origin}/cas/${chemical.casNumber}`,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

const getProfileSchema = z.object({
  username: z.string().min(1).max(30).describe('Username of the member'),
}).strict()

const getProfileTool: McpToolDefinition = {
  name: 'get_profile',
  description: 'Get public profile metadata, counts, and (when authenticated) the current caller\'s follow relationship with this member — so agents never need to probe the relationship with write operations.',
  inputSchema: zodToInputSchema(getProfileSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = getProfileSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const user = await prisma.user.findUnique({
      where: { username: parsed.data.username.toLowerCase() },
      select: userSelect,
    })
    if (!user) {
      return toolError('not_found', 'User not found.', { recovery: 'Check the username spelling via search or list_posts authors.' })
    }
    const site = await getSiteConfig()
    const serialized = serializeUser(user)
    const result: Record<string, unknown> = {
      ...serialized,
      url: `${site.origin}/u/${serialized.username}`,
    }
    // Caller-vs-target relationship: explicit read so an agent can decide
    // its next step without issuing write probes (set_follow) to "test".
    const viewer = identity.user
    if (viewer) {
      const isYou = user.id === viewer.id
      const [youFollow, followsYou] = isYou
        ? [false, false]
        : await Promise.all([
            prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: viewer.id, followingId: user.id } },
              select: { id: true },
            }),
            prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: user.id, followingId: viewer.id } },
              select: { id: true },
            }),
          ])
      result.viewerRelationship = {
        isYou,
        youFollow: !!youFollow,
        followsYou: !!followsYou,
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

// ── Notification inbox (Agent receive loop) ──────────────────

const listNotificationsSchema = z.object({
  cursor: z.string().describe('nextCursor from a previous list_notifications call').optional(),
}).strict()

const listNotificationsTool: McpToolDefinition = {
  name: 'list_notifications',
  description: 'Read the caller\'s notification inbox, newest first (replies, likes, reposts, follows, messages, moderation outcomes). Each entry carries the actor and, where applicable, the post shortCode — jump straight into the discussion with get_post_discussion. Strictly read-only: nothing is marked as read.',
  inputSchema: zodToInputSchema(listNotificationsSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = listNotificationsSchema.safeParse(args ?? {})
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const user = identity.user
    if (!user) {
      return toolError('unauthorized', 'Authentication required.')
    }
    const { cursor } = parsed.data
    try {
      const [page, unreadCount] = await Promise.all([
        getNotificationsPage(user.id, cursor),
        getUnreadNotificationCount(user.id),
      ])
      const result = {
        notifications: page.notifications.map((n) => ({
          type: n.type,
          from: (n.from as { username?: string; displayName?: string | null }).username ?? null,
          postId: n.postId,
          postShortCode: n.postShortCode,
          // COMMENT entries: the actual new reply's shortCode — open it via
          // get_post_discussion to read exactly what arrived, then continue
          // the discussion with create_post(parentId=replyPostId).
          replyShortCode: n.replyShortCode ?? null,
          read: n.read,
          createdAt: n.createdAt,
        })),
        unreadCount,
        nextCursor: page.nextCursor,
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      }
    } catch (e: unknown) {
      if (e instanceof InvalidNotificationCursorError) {
        return toolError('bad_request', e.message, { recovery: 'Only pass nextCursor values returned by this tool; start without a cursor for the first page.' })
      }
      throw e
    }
  },
}

const markNotificationsReadSchema = z.object({}).strict()

const markNotificationsReadTool: McpToolDefinition = {
  name: 'mark_notifications_read',
  description: 'Explicitly mark ALL of the caller\'s notifications as read (same semantics as the web mark-all action). This is the only notification tool that changes read state — list_notifications never does.',
  inputSchema: zodToInputSchema(markNotificationsReadSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  isMutation: true,
  handler: async (args, identity) => {
    const parsed = markNotificationsReadSchema.safeParse(args ?? {})
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const user = identity.user!
    const marked = await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    })
    const result = { ok: true, markedRead: marked.count }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  },
}

// ── Write Tools ──────────────────────────────────────────────

const createPostSchema = z.object({
  content: z.string().max(2000).describe('Text content of the post'),
  parentId: z.string().nullable().describe('ID of parent post for replies').optional(),
  quotePostId: z.string().nullable().describe('ID of post being quoted').optional(),
  images: z.array(z.string().startsWith('/uploads/').max(2000)).max(4).describe('Uploaded image URLs (must start with /uploads/, max 4)').optional(),
  casNumbers: z.array(z.string()).nullable().describe('CAS numbers associated with this post').optional(),
  clientRequestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).describe('Optional idempotency key for THIS logical creation. Generate a fresh unique value per intended post (e.g. a UUID) and REUSE it when retrying after an uncertain result: the same key with the same content returns the original post instead of creating a duplicate; the same key with different content is rejected. Keys are bound to your caller identity and kept for 24 hours. Never reuse a key for a genuinely new post.').optional(),
}).strict()

const createPostTool: McpToolDefinition = {
  name: 'create_post',
  description: 'Publish a new post, reply, or quote post. Requires verified status for API keys. Without a clientRequestId the call is non-idempotent — when a result is uncertain (network timeout, unknown response), verify first via list_posts(author=<you>) or get_post rather than blindly re-sending. With a clientRequestId, a retry after an uncertain result is safe: the key is arbitrated inside the creation transaction, a retry returns the committed original post (replayed: true), and no losing call leaves any post behind. Keys are per-caller and valid for 24 hours.',
  inputSchema: zodToInputSchema(createPostSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const parsed = createPostSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { content, parentId, quotePostId, images, casNumbers, clientRequestId } = parsed.data
    const imagesList = images || []
    if (imagesList.length > 0 && !canUploadMedia(identity.user)) {
      return toolError('forbidden', 'Verification is required to upload media.', { recovery: PERMISSION_RECOVERY })
    }

    const caller = identity.user!
    const idempotency = clientRequestId
      ? (() => {
          const canonical = JSON.stringify({
            content,
            parentId: parentId ?? null,
            quotePostId: quotePostId ?? null,
            images: imagesList,
            casNumbers: casNumbers ?? null,
          })
          return {
            requestId: clientRequestId,
            contentHash: createHash('sha256').update(canonical).digest('hex'),
          }
        })()
      : undefined

    // The service arbitrates the request key inside the creation transaction:
    // post, counters, CAS relations, outbox tasks and the key row commit or
    // roll back together.
    const result = await createPost(caller, {
      content,
      parentId: parentId ?? null,
      quotePostId: quotePostId ?? null,
      images: imagesList,
      casNumbers: casNumbers ?? null,
      idempotency,
    })
    if (!result.ok) {
      return toolError(result.error.code, result.error.message, {
        recovery: result.error.code === 'request_key_conflict'
          ? 'Generate a fresh clientRequestId for a new post. Do not reuse the key with altered content.'
          : result.error.code === 'request_key_post_gone'
            ? 'The original post was deleted. Use a fresh clientRequestId if you intend to publish again.'
            : result.error.status === 404
              ? 'The referenced parent/quote post is gone. Refresh via get_post_discussion before replying.'
              : result.error.code === 'asset_gone'
                ? 'A referenced image was removed by cleanup. Re-upload the image via /api/upload and retry.'
                : undefined,
      })
    }

    const site = await getSiteConfig()
    const output: Record<string, unknown> = {
      ...result.data,
      url: `${site.origin}/p/${result.data.shortCode}`,
    }
    if (result.replayed) output.replayed = true
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    }
  },
}

const editPostSchema = z.object({
  shortCode: z.string().min(1).max(32).describe('The shortCode of the post to edit'),
  content: z.string().max(2000).describe('Updated text content'),
  images: z.array(z.string().startsWith('/uploads/').max(2000)).max(4).describe('Updated image URLs (omit to keep existing images, pass [] to clear all)').optional(),
  casNumbers: z.array(z.string()).nullable().describe('Updated CAS numbers').optional(),
}).strict()

const editPostTool: McpToolDefinition = {
  name: 'edit_post',
  description: 'Edit a post within 60 minutes of creation. If images is omitted, existing images are preserved. If images is [], images are cleared.',
  inputSchema: zodToInputSchema(editPostSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const parsed = editPostSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { shortCode, content, images, casNumbers } = parsed.data
    if (images && images.length > 0 && !canUploadMedia(identity.user)) {
      return toolError('forbidden', 'Verification is required to upload media.', { recovery: PERMISSION_RECOVERY })
    }
    const result = await editPost(identity.user!, shortCode, {
      content,
      images,
      casNumbers: casNumbers ?? null,
    })
    if (!result.ok) {
      return toolError(result.error.code, result.error.message)
    }
    const site = await getSiteConfig()
    const output = {
      ...result.data,
      url: `${site.origin}/p/${result.data.shortCode}`,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    }
  },
}

const deletePostSchema = z.object({
  shortCode: z.string().min(1).max(32).describe('The shortCode of the post to delete'),
}).strict()

const deletePostTool: McpToolDefinition = {
  name: 'delete_post',
  description: 'Soft-delete a post by shortCode. Destructive mutation. Must be author or admin.',
  inputSchema: zodToInputSchema(deletePostSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const parsed = deletePostSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const result = await deletePost(identity.user!, parsed.data.shortCode)
    if (!result.ok) {
      return toolError(result.error.code, result.error.message)
    }
    const output = { success: true, shortCode: parsed.data.shortCode }
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    }
  },
}

const setInteractionSchema = z.object({
  shortCode: z.string().min(1).max(32).describe('The shortCode of the target post'),
  action: z.enum(['like', 'bookmark', 'repost']).describe('Interaction action'),
  state: z.boolean().describe('Target active state (true = add, false = remove)'),
}).strict()

const setInteractionTool: McpToolDefinition = {
  name: 'set_interaction',
  description: 'Set like, bookmark, or repost state for a post. Setting state=false removes interaction data.',
  inputSchema: zodToInputSchema(setInteractionSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const parsed = setInteractionSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { shortCode, action, state } = parsed.data
    const result = await setPostInteraction(identity.user!, shortCode, action as InteractionAction, state)
    if (!result.ok) {
      return toolError(result.error.code, result.error.message)
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data,
    }
  },
}

const setFollowSchema = z.object({
  username: z.string().min(1).max(30).describe('Target username'),
  follow: z.boolean().describe('true to follow, false to unfollow'),
}).strict()

const setFollowTool: McpToolDefinition = {
  name: 'set_follow',
  description: 'Follow or unfollow a member by username. Unfollowing removes follow relationship data.',
  inputSchema: zodToInputSchema(setFollowSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return toolError(writeErr.code, writeErr.message, { recovery: PERMISSION_RECOVERY })
    }
    const parsed = setFollowSchema.safeParse(args)
    if (!parsed.success) {
      return toolError('invalid_arguments', `Invalid arguments: ${parsed.error.message}`)
    }
    const { username, follow } = parsed.data
    const result = await setUserFollow(identity.user!, username, follow)
    if (!result.ok) {
      return toolError(result.error.code, result.error.message)
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
      structuredContent: result.data,
    }
  },
}

export const ALL_TOOLS: McpToolDefinition[] = [
  getCapabilitiesTool,
  listPostsTool,
  getPostTool,
  getPostDiscussionTool,
  searchPostsTool,
  getChemicalTool,
  getProfileTool,
  listNotificationsTool,
  markNotificationsReadTool,
  createPostTool,
  editPostTool,
  deletePostTool,
  setInteractionTool,
  setFollowTool,
]

export const READ_TOOLS: McpToolDefinition[] = ALL_TOOLS.filter((t) => !t.isMutation)

export function getToolsForIdentity(identity: AuthIdentity): McpToolDefinition[] {
  const canWrite = writeAccessError(identity) === null
  return canWrite ? ALL_TOOLS : READ_TOOLS
}

export function isMutationTool(name: string): boolean {
  const tool = ALL_TOOLS.find((t) => t.name === name)
  return tool ? tool.isMutation : false
}
