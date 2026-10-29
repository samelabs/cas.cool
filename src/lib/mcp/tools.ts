/**
 * MCP Tool definitions, schemas, annotations, and execution handlers.
 * Single source of truth for all tools exposed via /mcp.
 */

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
import { serializeUser, userSelect } from '@/lib/serialize'

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
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
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
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const tab = parsed.data.tab ?? 'latest'
    const take = parsed.data.take ?? 20
    const { author, cas, cursor } = parsed.data
    const userId = identity.user?.id ?? null

    if (tab === 'following' && !userId) {
      return { isError: true, content: [{ type: 'text', text: 'Authentication required for following feed.' }] }
    }

    if (cas) {
      if (!CAS_FORMAT.test(cas)) {
        return { isError: true, content: [{ type: 'text', text: 'Invalid CAS number format (must match \\d{2,7}-\\d{2}-\\d).' }] }
      }
      if (tab !== 'latest') {
        return { isError: true, content: [{ type: 'text', text: 'CAS filtering requires latest feed.' }] }
      }
    }

    let resolvedAuthorId: string | undefined = undefined
    if (author) {
      if (tab !== 'latest') {
        return { isError: true, content: [{ type: 'text', text: 'Author filtering requires latest feed.' }] }
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
        return { isError: true, content: [{ type: 'text', text: 'Invalid cursor.' }] }
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
  description: 'Get a single post by its shortCode. Returns 404 error if not found or soft-deleted.',
  inputSchema: zodToInputSchema(getPostSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args, identity) => {
    const parsed = getPostSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const userId = identity.user?.id ?? null
    const post = await getPostByShortCode(parsed.data.shortCode, userId)
    if (!post || post.deletedAt) {
      return { isError: true, content: [{ type: 'text', text: 'Post not found.' }] }
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
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { shortCode, cursor, ancestorCursor } = parsed.data
    const take = parsed.data.take ?? 20
    const ancestorTake = parsed.data.ancestorTake ?? 20
    const userId = identity.user?.id ?? null

    const post = await getPostByShortCode(shortCode, userId)
    if (!post || post.deletedAt) {
      return { isError: true, content: [{ type: 'text', text: 'Post not found.' }] }
    }

    if (cursor && !validateTimelineCursor(cursor, 'latest', true)) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid cursor.' }] }
    }
    if (ancestorCursor && (typeof ancestorCursor !== 'string' || ancestorCursor.length > 512)) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid ancestorCursor.' }] }
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
          return { isError: true, content: [{ type: 'text', text: `Invalid ancestorCursor: ${err.message}` }] }
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
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    if (!canSearch(identity.user)) {
      return { isError: true, content: [{ type: 'text', text: 'Verification is required to use search.' }] }
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
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { casNumber } = parsed.data
    if (!CAS_FORMAT.test(casNumber)) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid CAS number format (must match \\d{2,7}-\\d{2}-\\d).' }] }
    }
    const chemical = await prisma.chemical.findUnique({
      where: { casNumber },
      select: { casNumber: true, name: true, smiles: true, banned: true, postCount: true, createdAt: true },
    })
    if (!chemical) {
      return { isError: true, content: [{ type: 'text', text: 'Chemical not found.' }] }
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
  description: 'Get public profile metadata and counts by username.',
  inputSchema: zodToInputSchema(getProfileSchema),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  isMutation: false,
  handler: async (args) => {
    const parsed = getProfileSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const user = await prisma.user.findUnique({
      where: { username: parsed.data.username.toLowerCase() },
      select: userSelect,
    })
    if (!user) {
      return { isError: true, content: [{ type: 'text', text: 'User not found.' }] }
    }
    const site = await getSiteConfig()
    const serialized = serializeUser(user)
    const result = {
      ...serialized,
      url: `${site.origin}/u/${serialized.username}`,
    }
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
}).strict()

const createPostTool: McpToolDefinition = {
  name: 'create_post',
  description: 'Publish a new post, reply, or quote post. Non-idempotent mutation. Requires verified status for API keys.',
  inputSchema: zodToInputSchema(createPostSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  isMutation: true,
  handler: async (args, identity) => {
    const writeErr = writeAccessError(identity)
    if (writeErr) {
      return { isError: true, content: [{ type: 'text', text: writeErr.message }] }
    }
    const parsed = createPostSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { content, parentId, quotePostId, images, casNumbers } = parsed.data
    const imagesList = images || []
    if (imagesList.length > 0 && !canUploadMedia(identity.user)) {
      return { isError: true, content: [{ type: 'text', text: 'Verification is required to upload media.' }] }
    }
    const result = await createPost(identity.user!, {
      content,
      parentId: parentId ?? null,
      quotePostId: quotePostId ?? null,
      images: imagesList,
      casNumbers: casNumbers ?? null,
    })
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] }
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
      return { isError: true, content: [{ type: 'text', text: writeErr.message }] }
    }
    const parsed = editPostSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { shortCode, content, images, casNumbers } = parsed.data
    if (images && images.length > 0 && !canUploadMedia(identity.user)) {
      return { isError: true, content: [{ type: 'text', text: 'Verification is required to upload media.' }] }
    }
    const result = await editPost(identity.user!, shortCode, {
      content,
      images,
      casNumbers: casNumbers ?? null,
    })
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] }
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
      return { isError: true, content: [{ type: 'text', text: writeErr.message }] }
    }
    const parsed = deletePostSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const result = await deletePost(identity.user!, parsed.data.shortCode)
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] }
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
      return { isError: true, content: [{ type: 'text', text: writeErr.message }] }
    }
    const parsed = setInteractionSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { shortCode, action, state } = parsed.data
    const result = await setPostInteraction(identity.user!, shortCode, action as InteractionAction, state)
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] }
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
      return { isError: true, content: [{ type: 'text', text: writeErr.message }] }
    }
    const parsed = setFollowSchema.safeParse(args)
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }] }
    }
    const { username, follow } = parsed.data
    const result = await setUserFollow(identity.user!, username, follow)
    if (!result.ok) {
      return { isError: true, content: [{ type: 'text', text: result.error.message }] }
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
