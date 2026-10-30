/**
 * /api/admin/site
 *
 * GET   — read public site configuration (Admin read).
 * PATCH — update public site profile (Admin write).
 *
 * Enforces admin authorization, rate-limiting, and validation.
 * Target is fixed to SiteConfig row 1.
 * Origin and keyPrefix are infrastructure parameters and are not modified here.
 */

import { NextRequest } from 'next/server'
import { t } from '@/lib/i18n'
import { requireAdmin } from '@/lib/api-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { revalidateSiteConfig } from '@/lib/site'

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status })
}

export async function GET() {
  const auth = await requireAdmin('read')
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'read')
  if (limited) return limited

  const site = await prisma.siteConfig.findUnique({ where: { id: 1 } })
  if (!site) return jsonError(404, 'not_found', t.admin.siteProfile.validation.rowMissing)

  return Response.json({
    site: {
      origin: site.origin,
      name: site.name,
      shortName: site.shortName,
      keyPrefix: site.keyPrefix,
      description: site.description,
      tagline: site.tagline,
      analyticsId: site.analyticsId,
      githubUrl: site.githubUrl,
      updatedAt: site.updatedAt.toISOString(),
    },
  })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin('write')
  if (!auth.ok) return auth.response

  const limited = checkRateLimit(auth.identity, 'write')
  if (limited) return limited

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return jsonError(400, 'bad_request', t.admin.siteProfile.validation.invalidJson)
  }

  const v = t.admin.siteProfile.validation

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 50) {
    return jsonError(400, 'bad_request', v.nameRequired)
  }

  const shortName = typeof body.shortName === 'string' ? body.shortName.trim() : ''
  if (!shortName || shortName.length > 30) {
    return jsonError(400, 'bad_request', v.shortNameRequired)
  }

  const tagline = typeof body.tagline === 'string' ? body.tagline.trim() : ''
  if (!tagline || tagline.length > 200) {
    return jsonError(400, 'bad_request', v.taglineRequired)
  }

  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description || description.length > 500) {
    return jsonError(400, 'bad_request', v.descriptionRequired)
  }

  let analyticsId: string | null = null
  if (body.analyticsId !== undefined) {
    if (body.analyticsId === null || body.analyticsId === '') {
      analyticsId = null
    } else if (typeof body.analyticsId === 'string') {
      const trimmed = body.analyticsId.trim()
      if (trimmed.length > 100) {
        return jsonError(400, 'bad_request', v.analyticsIdTooLong)
      }
      analyticsId = trimmed || null
    } else {
      return jsonError(400, 'bad_request', v.invalidAnalyticsId)
    }
  }

  let githubUrl: string | null = null
  if (body.githubUrl !== undefined) {
    if (body.githubUrl === null || body.githubUrl === '') {
      githubUrl = null
    } else if (typeof body.githubUrl === 'string') {
      const trimmed = body.githubUrl.trim()
      if (trimmed) {
        try {
          const parsed = new URL(trimmed)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return jsonError(400, 'bad_request', v.invalidGithubUrl)
          }
        } catch {
          return jsonError(400, 'bad_request', v.invalidUrl)
        }
        githubUrl = trimmed
      }
    } else {
      return jsonError(400, 'bad_request', v.githubUrlType)
    }
  }

  const updated = await prisma.siteConfig.update({
    where: { id: 1 },
    data: {
      name,
      shortName,
      tagline,
      description,
      ...(body.analyticsId !== undefined ? { analyticsId } : {}),
      ...(body.githubUrl !== undefined ? { githubUrl } : {}),
    },
  })

  // Invalidate cached site configuration
  revalidateSiteConfig()

  return Response.json({
    site: {
      origin: updated.origin,
      name: updated.name,
      shortName: updated.shortName,
      keyPrefix: updated.keyPrefix,
      description: updated.description,
      tagline: updated.tagline,
      analyticsId: updated.analyticsId,
      githubUrl: updated.githubUrl,
      updatedAt: updated.updatedAt.toISOString(),
    },
  })
}
