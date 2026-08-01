'use client'

import { useState } from 'react'
import { t } from '@/lib/i18n'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { extractCASNumber } from '@/lib/utils'
import { maxPostLength } from '@/lib/permissions'
import type { SafePost } from '@/lib/types'
import { post } from '@/lib/api-client'

export interface ReplyBoxProps {
  parentId: string
  /** Called with the fully-serialized post returned by the API (HTTP 201). */
  onReply?: (post: SafePost) => void
}

export default function ReplyBox({ parentId, onReply }: ReplyBoxProps) {
  const { currentUser } = useAuth()
  const { showToast } = useToast()

  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (!currentUser) return null

  const MAX = maxPostLength(currentUser)
  const remaining = MAX - content.length
  const overLimit = remaining < 0
  const empty = content.trim().length === 0
  const canSubmit = !empty && !overLimit && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const casNumber = extractCASNumber(content)
      const result = await post<SafePost>('/api/posts', {
        content,
        parentId,
        casNumbers: casNumber ? [casNumber] : [],
        images: [],
      })
      if (!result.ok) {
        throw new Error(result.error || t.messages.failedToReply)
      }
      // Action returns the full serialized post — feed it to the parent
      // for an instant optimistic update. No router.refresh() needed.
      const created = result.data!
      onReply?.(created)
      setContent('')
      showToast(t.messages.replyPosted, 'success', 2000)
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const counterColor = overLimit
    ? 'text-danger'
    : remaining <= 100
      ? 'text-warning'
      : 'text-ink-faint'

  return (
    <div className="border-b border-line bg-brand-tint/30 p-4">
      <div className="flex gap-3">
        <Avatar
          src={currentUser.avatar}
          name={currentUser.displayName || currentUser.username}
          username={currentUser.username}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={2}
            placeholder={t.messages.replyPlaceholder}
            maxLength={MAX + 50}
            className="w-full resize-none bg-transparent text-lg text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
            <span
              className={cn('text-sm tabular-nums', counterColor)}
            >
              {remaining}
            </span>
            <Button
              type="button"
              size="sm"
              loading={submitting}
              disabled={!canSubmit}
              onClick={submit}
            >
              Reply
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
