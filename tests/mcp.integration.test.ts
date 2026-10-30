/**
 * Official MCP SDK HTTP Integration Suite
 * Uses Client + StreamableHTTPClientTransport to test /mcp against real PostgreSQL and HTTP server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { dropTestDatabase, provisionTestDatabase, promoteUser, sql } from './helpers/db'
import { api, json, registerAndLogin, type Session } from './helpers/http'
import { startTestServer, stopTestServer } from './helpers/server'
import { SERVER_URL } from './helpers/env'

let alice: Session
let bob: Session
let aliceKey: string
let bobKey: string

async function createKey(session: { cookie: string }, name: string): Promise<string> {
  const res = await api('/api/account/api-keys', {
    method: 'POST',
    cookie: session.cookie,
    body: JSON.stringify({ name }),
  })
  if (res.status !== 201) throw new Error(`createKey failed: ${res.status}`)
  const data = await json<{ rawKey: string }>(res)
  return data.rawKey
}

function createMcpClient(rawKey: string, customFetch?: typeof fetch) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', SERVER_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${rawKey}`,
      },
    },
    fetch: customFetch,
  })
  const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' }, { capabilities: {} })
  return { client, transport }
}

beforeAll(async () => {
  await provisionTestDatabase()
  await startTestServer()

  alice = await registerAndLogin('alice_mcp')
  bob = await registerAndLogin('bob_mcp')
  await promoteUser(alice.username, { verified: true })
  // bob is unverified

  aliceKey = await createKey(alice, 'alice-mcp-key')
  bobKey = await createKey(bob, 'bob-mcp-key')

  // Seed a chemical for testing get_chemical and CAS timeline filtering
  await sql(`INSERT INTO "Chemical" (id, "casNumber", name, smiles, "postCount", "createdAt", "updatedAt")
    VALUES ('chem_ethanol', '64-17-5', 'Ethanol; ethyl alcohol', 'CCO', 1, now(), now())
    ON CONFLICT ("casNumber") DO NOTHING`)
})

afterAll(async () => {
  await stopTestServer()
  await dropTestDatabase()
})

describe('Official MCP SDK: End-to-End Streamable HTTP', () => {
  it('connects via official SDK, verifies ToolAnnotations and schemas without drift, and reads/writes flow', async () => {
    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)

    // 1. tools/list & annotations verification
    const toolsResult = await client.listTools()
    expect(toolsResult.tools.length).toBe(14)
    const toolMap = new Map(toolsResult.tools.map((t) => [t.name, t]))

    expect(toolMap.has('get_capabilities')).toBe(true)
    expect(toolMap.has('list_posts')).toBe(true)
    expect(toolMap.has('get_post')).toBe(true)
    expect(toolMap.has('get_post_discussion')).toBe(true)
    expect(toolMap.has('search_posts')).toBe(true)
    expect(toolMap.has('get_chemical')).toBe(true)
    expect(toolMap.has('get_profile')).toBe(true)
    expect(toolMap.has('create_post')).toBe(true)
    expect(toolMap.has('edit_post')).toBe(true)
    expect(toolMap.has('delete_post')).toBe(true)
    expect(toolMap.has('set_interaction')).toBe(true)
    expect(toolMap.has('set_follow')).toBe(true)

    // Verify SDK parsed ToolAnnotations
    const capsTool = toolMap.get('get_capabilities')!
    expect(capsTool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    })

    const createTool = toolMap.get('create_post')!
    expect(createTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    })

    const editTool = toolMap.get('edit_post')!
    expect(editTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })

    const deleteTool = toolMap.get('delete_post')!
    expect(deleteTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })

    const interactionTool = toolMap.get('set_interaction')!
    expect(interactionTool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })

    // 2. get_capabilities and strict parameter validation
    const badCaps = (await client.callTool({ name: 'get_capabilities', arguments: { extraUnknown: 123 } })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(badCaps.isError).toBe(true)
    expect(badCaps.content[0].text).toContain('Invalid arguments')

    const capsResult = (await client.callTool({ name: 'get_capabilities', arguments: {} })) as {
      content: Array<{ type: string; text: string }>
      structuredContent?: { permissions: { canProgrammaticWrite: boolean } }
    }
    expect(capsResult.content[0].type).toBe('text')
    const caps = JSON.parse(capsResult.content[0].text)
    expect(caps.authenticated).toBe(true)
    expect(caps.permissions.canProgrammaticWrite).toBe(true)

    // Strict schema validation rejects unknown parameters on query tools
    const badList = (await client.callTool({ name: 'list_posts', arguments: { nonExistentFilter: 'bar' } })) as { isError?: boolean }
    expect(badList.isError).toBe(true)

    // 3. get_chemical
    const chemResult = (await client.callTool({ name: 'get_chemical', arguments: { casNumber: '64-17-5' } })) as {
      content: Array<{ type: string; text: string }>
    }
    const chem = JSON.parse(chemResult.content[0].text)
    expect(chem.casNumber).toBe('64-17-5')
    expect(chem.smiles).toBe('CCO')

    // 4. create_post with whitespace normalization validation
    const emptyFail = (await client.callTool({
      name: 'create_post',
      arguments: { content: '   ' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(emptyFail.isError).toBe(true)
    expect(emptyFail.content[0].text).toContain('Content is required')

    const createResult = (await client.callTool({
      name: 'create_post',
      arguments: { content: 'Parent post for discussion 64-17-5', casNumbers: ['64-17-5'] },
    })) as { content: Array<{ type: string; text: string }> }
    const parentPost = JSON.parse(createResult.content[0].text)
    expect(parentPost.content).toBe('Parent post for discussion 64-17-5')
    expect(parentPost.shortCode).toBeTruthy()
    expect(parentPost.url).toContain(`/p/${parentPost.shortCode}`)

    // Create a reply to parentPost
    const replyResult = (await client.callTool({
      name: 'create_post',
      arguments: { content: 'Reply to parent post', parentId: parentPost.id },
    })) as { content: Array<{ type: string; text: string }> }
    const replyPost = JSON.parse(replyResult.content[0].text)
    expect(replyPost.parentId).toBe(parentPost.id)

    // 5. get_post_discussion
    const discussionResult = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: parentPost.shortCode },
    })) as { content: Array<{ type: string; text: string }> }
    const discussion = JSON.parse(discussionResult.content[0].text)
    expect(discussion.post.shortCode).toBe(parentPost.shortCode)
    expect(discussion.replies.length).toBeGreaterThanOrEqual(1)
    expect(discussion.replies.some((r: { shortCode: string }) => r.shortCode === replyPost.shortCode)).toBe(true)

    // 6. list_posts with author username resolution & CAS filter
    const authorList = JSON.parse(
      ((await client.callTool({ name: 'list_posts', arguments: { author: alice.username } })) as { content: Array<{ text: string }> }).content[0].text,
    )
    expect(authorList.posts.length).toBeGreaterThan(0)
    expect(authorList.posts.every((p: { author: { username: string } }) => p.author.username === alice.username)).toBe(true)

    const nonExistentAuthorList = JSON.parse(
      ((await client.callTool({ name: 'list_posts', arguments: { author: 'non_existent_author_xyz' } })) as { content: Array<{ text: string }> }).content[0].text,
    )
    expect(nonExistentAuthorList.posts).toEqual([])
    expect(nonExistentAuthorList.nextCursor).toBeNull()

    const casList = JSON.parse(
      ((await client.callTool({ name: 'list_posts', arguments: { cas: '64-17-5' } })) as { content: Array<{ text: string }> }).content[0].text,
    )
    expect(casList.posts.length).toBeGreaterThan(0)

    // Unsupported combinations rejected
    const badFilterComb = (await client.callTool({
      name: 'list_posts',
      arguments: { author: alice.username, tab: 'following' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(badFilterComb.isError).toBe(true)

    // 7. get_post
    const getResult = (await client.callTool({ name: 'get_post', arguments: { shortCode: parentPost.shortCode } })) as {
      content: Array<{ type: string; text: string }>
    }
    const fetched = JSON.parse(getResult.content[0].text)
    expect(fetched.id).toBe(parentPost.id)
    expect(fetched.url).toContain(`/p/${parentPost.shortCode}`)

    // 8. edit_post (without images preserves existing; with [] clears)
    const editResult = (await client.callTool({
      name: 'edit_post',
      arguments: { shortCode: parentPost.shortCode, content: 'Edited parent post' },
    })) as { content: Array<{ type: string; text: string }> }
    const edited = JSON.parse(editResult.content[0].text)
    expect(edited.content).toBe('Edited parent post')

    // 9. set_interaction (like)
    const likeResult = (await client.callTool({
      name: 'set_interaction',
      arguments: { shortCode: parentPost.shortCode, action: 'like', state: true },
    })) as { content: Array<{ type: string; text: string }> }
    const like = JSON.parse(likeResult.content[0].text)
    expect(like.liked).toBe(true)

    // 10. set_follow
    const followResult = (await client.callTool({
      name: 'set_follow',
      arguments: { username: bob.username, follow: true },
    })) as { content: Array<{ type: string; text: string }> }
    const follow = JSON.parse(followResult.content[0].text)
    expect(follow.following).toBe(true)

    // 11. delete_post
    const deleteResult = (await client.callTool({
      name: 'delete_post',
      arguments: { shortCode: replyPost.shortCode },
    })) as { content: Array<{ type: string; text: string }> }
    const del = JSON.parse(deleteResult.content[0].text)
    expect(del.success).toBe(true)

    // 12. get_post on soft-deleted post returns 404 contract ('Post not found.')
    const deletedGet = (await client.callTool({
      name: 'get_post',
      arguments: { shortCode: replyPost.shortCode },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(deletedGet.isError).toBe(true)
    expect(deletedGet.content[0].text).toContain('Post not found.')

    await client.close()
  })

  it('handles unknown tool calls with official protocol error McpError(-32602)', async () => {
    const { client, transport } = createMcpClient(aliceKey)
    await client.connect(transport)

    await expect(
      client.callTool({ name: 'unregistered_tool', arguments: {} }),
    ).rejects.toThrow(McpError)

    await client.close()
  })

  it('unverified user connects, sees only read tools, and cannot write even if calling write tool directly', async () => {
    const { client, transport } = createMcpClient(bobKey)
    await client.connect(transport)

    // Unverified account only sees read tools (8 — read tools + the read-only notification inbox)
    const toolsResult = await client.listTools()
    expect(toolsResult.tools.length).toBe(8)
    const toolNames = toolsResult.tools.map((t) => t.name)
    expect(toolNames).not.toContain('create_post')
    expect(toolNames).toContain('get_capabilities')
    expect(toolNames).toContain('list_posts')
    expect(toolNames).toContain('get_post_discussion')

    // Hand-crafted call to create_post must be rejected by server-side authorization
    const rejected = (await client.callTool({
      name: 'create_post',
      arguments: { content: 'bypassing tools list' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0].text).toContain('Current verification is required')

    // Verify Bob's posts count did not change in DB
    const [row] = await sql<{ count: string }>(`SELECT count(*)::text FROM "Post" WHERE "authorId" = (SELECT id FROM "User" WHERE username = $1)`, [bob.username])
    expect(row.count).toBe('0')

    await client.close()
  })

  it('full MCP permission lifecycle on single key: unverified -> verified -> expired -> restricted -> suspended -> revoked', async () => {
    const lifecycleUser = await registerAndLogin('mcp_lifecycle_user')
    const key = await createKey(lifecycleUser, 'lifecycle-key')

    // Maintain a single continuous MCP Client across status transitions
    const { client, transport } = createMcpClient(key)
    await client.connect(transport)

    // 1. Initial state: unverified -> read succeeds, write rejected
    const read1 = (await client.callTool({ name: 'list_posts', arguments: {} })) as { isError?: boolean }
    expect(read1.isError).toBeFalsy()
    const write1 = (await client.callTool({ name: 'create_post', arguments: { content: 'unverified write' } })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(write1.isError).toBe(true)
    expect(write1.content[0].text).toContain('Current verification is required')

    // 2. Promote to verified -> same client executes write successfully
    await promoteUser(lifecycleUser.username, { verified: true })
    const write2 = (await client.callTool({ name: 'create_post', arguments: { content: 'verified write success' } })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(write2.isError).toBeFalsy()
    expect(write2.content[0].text).toContain('verified write success')

    // 3. Expire verification -> same client, write is immediately rejected by server-side gate
    await sql(`UPDATE "User" SET "verificationExpiresAt" = timezone('utc', now()) - interval '1 hour' WHERE "username" = $1`, [lifecycleUser.username])
    const write3 = (await client.callTool({ name: 'create_post', arguments: { content: 'expired verification write' } })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(write3.isError).toBe(true)
    expect(write3.content[0].text).toContain('Current verification is required')

    // 4. Restrict account -> same client, write rejected with inactive status
    await sql(`UPDATE "User" SET status = 'restricted', "verificationExpiresAt" = null WHERE "username" = $1`, [lifecycleUser.username])
    const write4 = (await client.callTool({ name: 'create_post', arguments: { content: 'restricted write' } })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(write4.isError).toBe(true)
    expect(write4.content[0].text).toContain('Account is not active.')

    // Close client before testing credential revocation/suspension (401 at auth layer)
    await client.close()

    // 5. Suspend account -> HTTP 401 authentication rejection
    await sql(`UPDATE "User" SET status = 'suspended' WHERE "username" = $1`, [lifecycleUser.username])
    const suspRes = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(suspRes.status).toBe(401)
    const suspBody = (await suspRes.json()) as { error: { message: string } }
    expect(suspBody.error.message.length).toBeGreaterThan(0)

    // 6. Revoke key -> HTTP 401 authentication rejection
    await sql(`UPDATE "User" SET status = 'active' WHERE "username" = $1`, [lifecycleUser.username])
    await sql(`UPDATE "ApiKey" SET "revokedAt" = now() WHERE "userId" = (SELECT id FROM "User" WHERE "username" = $1)`, [lifecycleUser.username])
    const revokeRes = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    })
    expect(revokeRes.status).toBe(401)
    const revokeBody = (await revokeRes.json()) as { error: { message: string } }
    expect(revokeBody.error.message.length).toBeGreaterThan(0)
  })

  it('protocol boundaries: rejects illegal origin (403 on POST and GET), batch arrays (400), and huge payload (413)', async () => {
    // 1. Illegal Origin -> 403 on POST
    const badOriginPost = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceKey}`,
        Origin: 'https://attacker.example.com',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(badOriginPost.status).toBe(403)

    // 2. Illegal Origin -> 403 on GET
    const badOriginGet = await fetch(`${SERVER_URL}/mcp`, {
      method: 'GET',
      headers: {
        Origin: 'https://attacker.example.com',
      },
    })
    expect(badOriginGet.status).toBe(403)

    // 3. Batch requests -> 400
    const batchRes = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ]),
    })
    expect(batchRes.status).toBe(400)
    const batchBody = (await batchRes.json()) as { error: { code: number } }
    expect(batchBody.error.code).toBe(-32600)

    // 4. Huge body (>64KB) -> 413
    const hugeContent = 'a'.repeat(70 * 1024)
    const hugeRes = await fetch(`${SERVER_URL}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_post', arguments: { content: hugeContent } } }),
    })
    expect(hugeRes.status).toBe(413)

    // 5. Allowed methods GET / DELETE -> 405
    const getRes = await fetch(`${SERVER_URL}/mcp`, { method: 'GET' })
    expect(getRes.status).toBe(405)
    const delRes = await fetch(`${SERVER_URL}/mcp`, { method: 'DELETE' })
    expect(delRes.status).toBe(405)
  })

  it('bidirectional rate limiting: bounded true burst exhausts quota across REST↔MCP; keys isolated', async () => {
    const user1 = await registerAndLogin('rate_user_1')
    await promoteUser(user1.username, { verified: true })
    const key1 = await createKey(user1, 'key-1')

    const user2 = await registerAndLogin('rate_user_2')
    await promoteUser(user2.username, { verified: true })
    const key2 = await createKey(user2, 'key-2')

    // The token bucket refills continuously (write tier: 60 tokens / 60s =
    // 1 token per second). A test that fires exactly `capacity` requests
    // and then demands a 429 assumes zero refill during the run — false on
    // any machine (this suite previously took ~5s for that loop, silently
    // refilling ~5 tokens). Instead: keep firing a BOUNDED burst until the
    // bucket is provably exhausted, then assert the enforcement bounds —
    // allowed ≤ capacity + elapsed refill, and 429 MUST occur within the
    // cap because consumption (1/request) outpaces refill (1/s).
    const WRITE_CAPACITY = 60
    const BURST_CAP = 200

    const restWrite = (bearer: string) =>
      api('/api/notifications/read', { method: 'POST', bearer }).then((r) => r.status === 429)
    const mcpWrite = (bearer: string, id: number) =>
      fetch(`${SERVER_URL}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name: 'set_interaction', arguments: { shortCode: 'none', action: 'like', state: true } },
        }),
      }).then((r) => r.status === 429)

    async function drainUntilLimited(probe: () => Promise<boolean>) {
      const startedAt = Date.now()
      let allowed = 0
      for (let i = 0; i < BURST_CAP; i++) {
        if (await probe()) {
          return { allowed, elapsedMs: Date.now() - startedAt }
        }
        allowed++
      }
      return null
    }

    // ── Direction A: REST burst on key1 until provably exhausted ──
    const dirA = await drainUntilLimited(() => restWrite(key1))
    expect(dirA).not.toBeNull()
    const refillA = Math.ceil((dirA!.elapsedMs / 1000) * (60 / 60))
    expect(dirA!.allowed).toBeGreaterThanOrEqual(WRITE_CAPACITY)
    expect(dirA!.allowed).toBeLessThanOrEqual(WRITE_CAPACITY + refillA)

    // MCP mutating calls on key1 share the same exhausted bucket. At the
    // 429 moment the bucket holds <1 token; a follow-up probe within the
    // same sub-second window can only pass at a refill boundary, so a
    // bounded sequence of back-to-back probes must hit 429 (each allowed
    // probe re-drains a full token).
    let mcp429 = false
    for (let i = 0; i < 10 && !mcp429; i++) {
      mcp429 = await mcpWrite(key1, 1000 + i)
    }
    expect(mcp429).toBe(true)

    // ── Key isolation: key2 (different user + key) is untouched. The probe
    // uses the READ tier so key2's write bucket stays pristine for the
    // direction-B drain below.
    const user2First = await api('/api/notifications', { bearer: key2 })
    expect(user2First.status).toBe(200)

    // ── Direction B: MCP burst on key2 until provably exhausted ──
    const dirB = await drainUntilLimited(() => mcpWrite(key2, 2000))
    expect(dirB).not.toBeNull()
    const refillB = Math.ceil((dirB!.elapsedMs / 1000) * (60 / 60))
    expect(dirB!.allowed).toBeGreaterThanOrEqual(WRITE_CAPACITY)
    expect(dirB!.allowed).toBeLessThanOrEqual(WRITE_CAPACITY + refillB)

    // REST write on key2 immediately shares the exhausted bucket.
    let rest429User2 = false
    for (let i = 0; i < 10 && !rest429User2; i++) {
      rest429User2 = await restWrite(key2)
    }
    expect(rest429User2).toBe(true)
  })

  it('bounds discussion context: limits deep ancestor queries, isolates unrelated branches, traverses soft-deleted boundaries, and paginates independently', async () => {
    const threadUser = await registerAndLogin('mcp_thread_user')
    await promoteUser(threadUser.username, { verified: true })
    const key = await createKey(threadUser, 'thread-key')
    const [userRow] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE username = $1`, [threadUser.username])
    const threadUserId = userRow.id

    // 1. Seed root post A0
    await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
      VALUES ('p_a0', 'sc_a0', $1, 'Root post A0', '{}'::text[], now() - interval '1 hour', now() - interval '1 hour')`, [threadUserId])

    // 2. Build a deep chain of 25 ancestors: A0 -> A1 -> A2 -> ... -> A25
    let prevId = 'p_a0'
    const ancestorIds = ['p_a0']
    const ancestorShortCodes = ['sc_a0']
    for (let i = 1; i <= 25; i++) {
      const id = `p_a${i}`
      const sc = `sc_a${i}`
      await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", "conversationId", content, images, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 'p_a0', $5, '{}'::text[], now() - interval '1 hour' + $6 * interval '10 seconds', now())`,
        [id, sc, threadUserId, prevId, `Ancestor A${i}`, i])
      prevId = id
      ancestorIds.push(id)
      ancestorShortCodes.push(sc)
    }

    // 3. Create 20 unrelated sibling branches off A0 and A10
    for (let i = 1; i <= 10; i++) {
      await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", "conversationId", content, images, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, 'p_a0', 'p_a0', $4, '{}'::text[], now(), now())`,
        [`p_sib0_${i}`, `sc_sib0_${i}`, threadUserId, `Sibling off A0 #${i}`])
      await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", "conversationId", content, images, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, 'p_a10', 'p_a0', $4, '{}'::text[], now(), now())`,
        [`p_sib10_${i}`, `sc_sib10_${i}`, threadUserId, `Sibling off A10 #${i}`])
    }

    // 4. Create target post T replying to A25
    const targetId = 'p_target'
    const targetSc = 'sc_target'
    await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", "conversationId", content, images, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'p_a25', 'p_a0', 'Target post T replying to A25', '{}'::text[], now(), now())`,
      [targetId, targetSc, threadUserId])

    // 5. Soft-delete multiple consecutive ancestors spanning the page boundary:
    // With ancestorTake: 10, Page 1 gets A16..A25 (boundary node is A16), Page 2 gets A6..A15.
    // Soft-delete A17, A16 (boundary), A15, A14
    await sql(`UPDATE "Post" SET "deletedAt" = now(), content = '' WHERE id IN ('p_a17', 'p_a16', 'p_a15', 'p_a14')`)

    // 6. Create 25 replies to target post T
    for (let i = 1; i <= 25; i++) {
      await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", "conversationId", content, images, "createdAt", "updatedAt")
        VALUES ($1, $2, $3, $4, 'p_a0', $5, '{}'::text[], now() + $6 * interval '10 milliseconds', now())`,
        [`p_rep_${i}`, `sc_rep_${i}`, threadUserId, targetId, `Reply to T #${i}`, i])
    }

    const { client, transport } = createMcpClient(key)
    await client.connect(transport)

    // ── Step 1: Initial Discussion Request (Page 1 ancestors + Page 1 replies) ──
    const disc1Res = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorTake: 10, take: 15 },
    })) as { content: Array<{ text: string }> }
    const disc1 = JSON.parse(disc1Res.content[0].text)

    expect(disc1.post.shortCode).toBe(targetSc)
    expect(disc1.ancestors.length).toBe(10)
    expect(disc1.hasMoreAncestors).toBe(true)
    expect(disc1.ancestorsTruncated).toBe(true)
    expect(disc1.oldestAncestorId).toBe('p_a16')
    expect(disc1.nextAncestorCursor).toBeTruthy()
    expect(disc1.nextAncestorCursor).not.toBe('p_a16') // Cryptographically signed opaque cursor

    // Chronological order: direct parent (A25) must be the last item in ancestors
    expect(disc1.ancestors[disc1.ancestors.length - 1].id).toBe('p_a25')
    expect(disc1.ancestors[0].id).toBe('p_a16')

    // Boundary ancestor A16 and predecessor A17 are soft-deleted tombstones
    const a16Found = disc1.ancestors.find((a: { id: string }) => a.id === 'p_a16')
    expect(a16Found).toBeTruthy()
    expect(a16Found.deletedAt).toBeTruthy()
    expect(a16Found.content).toBe('')

    const a17Found = disc1.ancestors.find((a: { id: string }) => a.id === 'p_a17')
    expect(a17Found).toBeTruthy()
    expect(a17Found.deletedAt).toBeTruthy()

    // Sibling branches must NOT appear in ancestors
    for (const anc of disc1.ancestors) {
      expect(anc.content).not.toContain('Sibling off')
    }

    // Replies on page 1 bounded to 15
    expect(disc1.replies.length).toBe(15)
    expect(disc1.hasMoreReplies).toBe(true)
    expect(disc1.nextCursor).toBeTruthy()

    // ── Step 2: Advance Replies ONLY (cursor provided, ancestorCursor omitted) ──
    // Does NOT query ancestors and does NOT falsely overwrite hasMoreAncestors to false
    const repPage2Res = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, cursor: disc1.nextCursor, take: 15 },
    })) as { content: Array<{ text: string }> }
    const repPage2 = JSON.parse(repPage2Res.content[0].text)

    expect(repPage2.replies.length).toBe(10)
    expect(repPage2.hasMoreReplies).toBe(false)
    expect(repPage2.nextCursor).toBeNull()
    // Ancestors should not be returned or reset
    expect(repPage2.ancestors).toBeUndefined()
    expect(repPage2.hasMoreAncestors).toBeUndefined()

    // ── Step 3: Advance Ancestors across Soft-Deleted Boundary Node A16 ──
    // Target post remains T (targetSc); ancestorCursor passes 'p_a16'
    const ancPage2Res = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: disc1.nextAncestorCursor, ancestorTake: 10 },
    })) as { content: Array<{ text: string }> }
    const ancPage2 = JSON.parse(ancPage2Res.content[0].text)

    expect(ancPage2.post.shortCode).toBe(targetSc)
    expect(ancPage2.ancestors.length).toBe(10)
    expect(ancPage2.hasMoreAncestors).toBe(true)
    expect(ancPage2.nextAncestorCursor).toBeTruthy()
    expect(ancPage2.nextAncestorCursor).not.toBe('p_a6')
    expect(ancPage2.oldestAncestorId).toBe('p_a6')

    // Page 2 contains A6 through A15
    expect(ancPage2.ancestors[0].id).toBe('p_a6')
    expect(ancPage2.ancestors[ancPage2.ancestors.length - 1].id).toBe('p_a15')

    // A15 and A14 are tombstones
    const a15Found = ancPage2.ancestors.find((a: { id: string }) => a.id === 'p_a15')
    expect(a15Found).toBeTruthy()
    expect(a15Found.deletedAt).toBeTruthy()
    expect(a15Found.content).toBe('')

    const a14Found = ancPage2.ancestors.find((a: { id: string }) => a.id === 'p_a14')
    expect(a14Found).toBeTruthy()
    expect(a14Found.deletedAt).toBeTruthy()

    // Replies are NOT re-queried or reset
    expect(ancPage2.replies).toBeUndefined()
    expect(ancPage2.nextCursor).toBeUndefined()

    // ── Step 4: Advance Ancestors to Root (Page 3) ──
    const ancPage3Res = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: ancPage2.nextAncestorCursor, ancestorTake: 10 },
    })) as { content: Array<{ text: string }> }
    const ancPage3 = JSON.parse(ancPage3Res.content[0].text)

    expect(ancPage3.ancestors.length).toBe(6) // A0 through A5
    expect(ancPage3.hasMoreAncestors).toBe(false)
    expect(ancPage3.nextAncestorCursor).toBeNull()
    expect(ancPage3.ancestors[0].id).toBe('p_a0') // Root post
    expect(ancPage3.ancestors[ancPage3.ancestors.length - 1].id).toBe('p_a5')

    // Verify full chain concatenation: Page 3 + Page 2 + Page 1 = 26 total (A0..A25) with zero duplicates
    const allAncestors = [...ancPage3.ancestors, ...ancPage2.ancestors, ...disc1.ancestors]
    expect(allAncestors.length).toBe(26)
    const allIds = allAncestors.map((a: { id: string }) => a.id)
    const expectedIds = Array.from({ length: 26 }, (_, i) => `p_a${i}`)
    expect(allIds).toEqual(expectedIds)

    // ── Step 5: Verify get_post on soft-deleted boundary node A16 still returns 404 ──
    const singleGet = (await client.callTool({
      name: 'get_post',
      arguments: { shortCode: 'sc_a16' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(singleGet.isError).toBe(true)
    expect(singleGet.content[0].text).toContain('Post not found.')

    // ── Step 6: Verify REST endpoint GET /api/posts?ancestorsOf=... and consistency with MCP ──
    // Page 1 REST: returns same post IDs as disc1 and signed opaque cursor
    const rest1 = await api(`/api/posts?ancestorsOf=${targetId}&take=10`)
    expect(rest1.status).toBe(200)
    const rest1Data = await rest1.json()
    expect(rest1Data.posts.length).toBe(10)
    expect(rest1Data.hasMoreAncestors).toBe(true)
    expect(rest1Data.nextCursor).toBeTruthy()
    expect(rest1Data.posts.map((p: { id: string }) => p.id)).toEqual(disc1.ancestors.map((a: { id: string }) => a.id))

    // Page 2 REST: using signed cursor, crossing deleted boundary node p_a16
    const rest2 = await api(`/api/posts?ancestorsOf=${targetId}&cursor=${encodeURIComponent(rest1Data.nextCursor)}&take=10`)
    expect(rest2.status).toBe(200)
    const rest2Data = await rest2.json()
    expect(rest2Data.posts.length).toBe(10)
    expect(rest2Data.hasMoreAncestors).toBe(true)
    expect(rest2Data.nextCursor).toBeTruthy()
    expect(rest2Data.posts.map((p: { id: string }) => p.id)).toEqual(ancPage2.ancestors.map((a: { id: string }) => a.id))

    // Page 3 REST: reaching root post A0
    const rest3 = await api(`/api/posts?ancestorsOf=${targetId}&cursor=${encodeURIComponent(rest2Data.nextCursor)}&take=10`)
    expect(rest3.status).toBe(200)
    const rest3Data = await rest3.json()
    expect(rest3Data.posts.length).toBe(6)
    expect(rest3Data.hasMoreAncestors).toBe(false)
    expect(rest3Data.nextCursor).toBeNull()
    expect(rest3Data.posts.map((p: { id: string }) => p.id)).toEqual(ancPage3.ancestors.map((a: { id: string }) => a.id))

    // ── Step 7: Create Discussion B & Assert Cross-Discussion Cursor Rejection ──
    const targetBId = 'p_target_b'
    const targetBSc = 'sc_target_b'
    await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", "parentId", content, images, "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'p_a10', 'Discussion B target replying to A10', '{}'::text[], now(), now())`,
      [targetBId, targetBSc, threadUserId])

    // Discussion A cursor supplied to Discussion B must be strictly rejected
    const crossDiscRest = await api(`/api/posts?ancestorsOf=${targetBId}&cursor=${encodeURIComponent(rest1Data.nextCursor)}&take=10`)
    expect(crossDiscRest.status).toBe(400)
    const crossDiscRestJson = await crossDiscRest.json()
    expect(crossDiscRestJson.error.message).toContain('does not belong to the requested target post')

    const crossDiscMcp = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetBSc, ancestorCursor: rest1Data.nextCursor, ancestorTake: 10 },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(crossDiscMcp.isError).toBe(true)
    expect(crossDiscMcp.content[0].text).toContain('does not belong to the requested target post')

    // ── Step 8: Assert Tampering & Raw-ID Bypass Rejection ──
    // 8a. Raw ID bypass rejection
    const rawIdRest = await api(`/api/posts?ancestorsOf=${targetId}&cursor=p_a16&take=10`)
    expect(rawIdRest.status).toBe(400)
    const rawIdMcp = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: 'p_a16' },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(rawIdMcp.isError).toBe(true)

    // 8b. Tampered signature rejection
    const rawToken = Buffer.from(rest1Data.nextCursor, 'base64url').toString('utf8')
    const [tId, bId, sig] = rawToken.split(':')
    const tamperedSigToken = Buffer.from(`${tId}:${bId}:bad_signature_tampered`).toString('base64url')

    const badSigRest = await api(`/api/posts?ancestorsOf=${targetId}&cursor=${tamperedSigToken}&take=10`)
    expect(badSigRest.status).toBe(400)
    const badSigMcp = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: tamperedSigToken },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(badSigMcp.isError).toBe(true)
    expect(badSigMcp.content[0].text).toContain('Invalid or tampered ancestor cursor signature')

    // 8c. Tampered boundary ID rejection
    const tamperedBoundaryToken = Buffer.from(`${tId}:p_a0:${sig}`).toString('base64url')
    const badBoundRest = await api(`/api/posts?ancestorsOf=${targetId}&cursor=${tamperedBoundaryToken}&take=10`)
    expect(badBoundRest.status).toBe(400)
    const badBoundMcp = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: tamperedBoundaryToken },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(badBoundMcp.isError).toBe(true)

    // 8d. Tampered target ID rejection
    const tamperedTargetToken = Buffer.from(`other_post:${bId}:${sig}`).toString('base64url')
    const badTargetRest = await api(`/api/posts?ancestorsOf=${targetId}&cursor=${tamperedTargetToken}&take=10`)
    expect(badTargetRest.status).toBe(400)
    const badTargetMcp = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: targetSc, ancestorCursor: tamperedTargetToken },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(badTargetMcp.isError).toBe(true)

    // ── Step 9: Root posts must consume the SAME ancestor-cursor contract ──
    // A real token issued for ANOTHER discussion, replayed against a root
    // post (no ancestors): REST answers 400; MCP must reject it too, not
    // silently succeed with empty ancestors. Root WITHOUT a cursor still
    // answers an empty ancestor page.
    await sql(`INSERT INTO "Post" (id, "shortCode", "authorId", content, images, "createdAt", "updatedAt")
      VALUES ('p_rootpost', 'sc_rootpost', $1, 'root post', '{}'::text[], now(), now())`, [threadUserId])
    const foreignToken = disc1.nextAncestorCursor as string
    expect(foreignToken).toBeTruthy()

    const rootForeign = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: 'sc_rootpost', ancestorCursor: foreignToken },
    })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(rootForeign.isError).toBe(true)

    const rootBareId = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: 'sc_rootpost', ancestorCursor: 'p_a16' },
    })) as { isError?: boolean }
    expect(rootBareId.isError).toBe(true)

    const rootRest = await api(`/api/posts?ancestorsOf=p_rootpost&cursor=${encodeURIComponent(foreignToken)}`, { bearer: key })
    expect(rootRest.status).toBe(400)

    const rootInitial = (await client.callTool({
      name: 'get_post_discussion',
      arguments: { shortCode: 'sc_rootpost' },
    })) as { structuredContent?: { ancestors?: unknown[] } }
    expect(rootInitial.structuredContent?.ancestors).toEqual([])

    await client.close()
  })
})
