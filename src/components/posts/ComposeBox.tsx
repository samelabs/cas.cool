'use client'

import { useRef, useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/components/Providers'
import { useToast } from '@/components/ui/Toast'
import { ImageIcon, XIcon, FlaskIcon } from '@/components/icons'
import { AutoResizeTextarea } from '@/components/ui/AutoResizeTextarea'
import { extractCASNumber } from '@/lib/utils'
import { postUrl } from '@/lib/shortCode'
import { cn } from '@/lib/cn'
import { maxPostLength, canUploadMedia } from '@/lib/permissions'
import Link from 'next/link'
import { uploadImage as uploadImageAction } from '@/actions/profile'
import { compressImage } from '@/lib/client-image'
import type { SafePost } from '@/lib/types'
import { t } from '@/lib/i18n'
import { createPost, updatePost } from '@/actions/posts'

const CAS_FORMAT = /^\d{2,7}-\d{2}-\d$/
const MAX_IMAGES = 4

export interface ComposeBoxProps {
  placeholder?: string
  onPosted?: (post: SafePost) => void
  compact?: boolean
  autoFocus?: boolean
  quotePostId?: string | null
  quotePost?: SafePost | null
  editPost?: SafePost | null
  hideAvatar?: boolean
}

export function ComposeBox({
  placeholder = t.compose.placeholder,
  onPosted,
  compact = false,
  autoFocus = false,
  quotePostId = null,
  quotePost = null,
  editPost = null,
  hideAvatar = false,
}: ComposeBoxProps) {
  const router = useRouter()
  const { currentUser } = useAuth()
  const { showToast } = useToast()

  const [content, setContent] = useState(() => editPost?.content ?? '')
  const [images, setImages] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Manually specified CAS numbers (via flask button)
  const [casNumbers, setCasNumbers] = useState<string[]>(() => editPost?.chemicals.map((c) => c.casNumber) ?? [])
  const [casInput, setCasInput] = useState('')
  const [showCasInput, setShowCasInput] = useState(false)

  // Existing images from the post being edited (server URLs like /uploads/xxx.webp)
  const [existingImages, setExistingImages] = useState<string[]>(() => editPost?.images ?? [])

  // Object URLs for selected images — derived from `images`, cleaned up on change.
  // useMemo + useEffect cleanup is the React-idiomatic pattern for derived
  // resources with side effects (createObjectURL / revokeObjectURL).
  const imageUrls = useMemo(() => images.map((f) => URL.createObjectURL(f)), [images])
  useEffect(() => {
    return () => imageUrls.forEach((u) => URL.revokeObjectURL(u))
  }, [imageUrls])

  // Auto-detect CAS from content (shows a preview chip)
  const detectedCAS = extractCASNumber(content)

  const charLimit = maxPostLength(currentUser)
  const remaining = charLimit - content.length
  const overLimit = remaining < 0
  const totalImages = existingImages.length + images.length
  const empty = content.trim().length === 0 && totalImages === 0
  const canSubmit = !empty && !overLimit && !submitting
  const mediaAllowed = canUploadMedia(currentUser)

  const [compressing, setCompressing] = useState(false)

  const onPickImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    const room = MAX_IMAGES - totalImages
    if (room <= 0) {
      showToast(t.compose.tooManyImages(MAX_IMAGES), 'error')
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    if (files.length > room) {
      showToast(t.compose.imagesExceeded(room, MAX_IMAGES), 'error')
    }
    const toAdd = files.slice(0, room)

    // Client-side compression: resize + WebP encode before upload.
    // Keeps images under the Server Action body limit and gives
    // a friendly error here instead of a framework 413.
    setCompressing(true)
    try {
      const compressed: File[] = []
      for (const file of toAdd) {
        const result = await compressImage(file)
        if (!result) {
          showToast(`Unsupported image: ${file.name}`, 'error')
          continue
        }
        compressed.push(new File([result.blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' }))
      }
      setImages((prev) => [...prev, ...compressed])
    } catch {
      showToast(t.errors.uploadFailed, 'error')
    } finally {
      setCompressing(false)
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  const removeExistingImage = (idx: number) => {
    setExistingImages((prev) => prev.filter((_, i) => i !== idx))
  }

  const addCasNumber = () => {
    const trimmed = casInput.trim()
    if (!trimmed) return
    if (!CAS_FORMAT.test(trimmed)) {
      showToast(t.compose.casInvalid, 'error')
      return
    }
    if (!casNumbers.includes(trimmed)) {
      setCasNumbers([...casNumbers, trimmed])
    }
    setCasInput('')
    setShowCasInput(false)
  }

  const removeCasNumber = (cas: string) => {
    setCasNumbers(casNumbers.filter(c => c !== cas))
  }

  const reset = () => {
    setContent('')
    setImages([])
    setExistingImages([])
    setCasNumbers([])
    setCasInput('')
    setShowCasInput(false)
  }

  const handleSubmit = async () => {
    if (!currentUser) {
      showToast(t.compose.pleaseSignIn, 'info')
      router.push('/login')
      return
    }
    if (!canSubmit) return
    setSubmitting(true)

    // Combine manual CAS + auto-detected CAS (deduplicated)
    const allCas = [...new Set([...casNumbers, ...(detectedCAS ? [detectedCAS] : [])])]

    try {
      // ── Upload new image files via Server Action ──
      const uploadedUrls: string[] = []
      for (const file of images) {
        const result = await uploadImageAction(file, 'post')
        if (!result.ok) {
          throw new Error(result.error || t.errors.uploadFailed)
        }
        uploadedUrls.push(result.data.url)
      }

      // Final image list: kept existing images (edit) + newly uploaded
      const finalImages = [...existingImages, ...uploadedUrls]

      if (editPost) {
        // --- Edit mode ---
        const result = await updatePost(editPost.id, content, finalImages, allCas)
        if (!result.ok) {
          throw new Error(result.error || t.compose.failedToEdit)
        }
        showToast(t.compose.postUpdated, 'success', 2000)
        router.push(postUrl(editPost))
      } else {
        // --- Create mode ---
        const result = await createPost({
          content,
          casNumbers: allCas,
          images: finalImages,
          ...(quotePostId ? { quotePostId } : {}),
        })
        if (!result.ok) {
          throw new Error(result.error || t.compose.failedToPost)
        }

        const created = result.data
        showToast(t.compose.posted, 'success', 2000)
        reset()

        // If a parent provided onPosted, hand off the new post and STAY on the
        // current page (e.g. timeline prepend). Otherwise navigate to the new
        // post's detail page. Never router.refresh() — that flashes the page.
        if (onPosted) {
          onPosted(created)
        } else {
          router.push(postUrl(created))
        }
      }
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

  // All CAS chips: manually specified + auto-detected
  const allCasChips = [...new Set([...casNumbers, ...(detectedCAS ? [detectedCAS] : [])])]

  return (
    <div className={cn('w-full overflow-hidden p-4', compact && 'px-4 py-3')}>
      <div className="flex gap-3">
        {currentUser && !hideAvatar && (
          <Link href={`/u/${currentUser.username}`} className="shrink-0">
            <Avatar
              src={currentUser.avatar}
              name={currentUser.displayName || currentUser.username}
              username={currentUser.username}
              size="md"
            />
          </Link>
        )}

        <div className="min-w-0 flex-1">
          <AutoResizeTextarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            autoFocus={autoFocus}
            minRows={compact ? 2 : 3}
            maxHeight={300}
            placeholder={placeholder}
            maxLength={charLimit + 50}
            className="text-lg"
          />

          {/* CAS number chips — manual + auto-detected */}
          {allCasChips.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {allCasChips.map((cas) => {
                const isManual = casNumbers.includes(cas)
                return (
                  <span
                    key={cas}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md bg-brand-tint px-2 py-0.5 font-mono text-sm text-brand-ink',
                      !isManual && 'ring-1 ring-brand/20',
                    )}
                  >
                    <FlaskIcon className="h-3.5 w-3.5" /> {cas}
                    {isManual && (
                      <button
                        type="button"
                        onClick={() => removeCasNumber(cas)}
                        className="ml-0.5 text-brand-ink/50 hover:text-danger"
                        aria-label={t.compose.removeCas(cas)}
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
          )}

          {/* CAS input (collapsible) */}
          {showCasInput && (
            <div className="mb-2 flex items-center gap-2">
              <FlaskIcon className="h-4 w-4 shrink-0 text-brand" />
              <input
                type="text"
                value={casInput}
                onChange={(e) => setCasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addCasNumber() }
                  if (e.key === 'Escape') { setShowCasInput(false); setCasInput('') }
                }}
                placeholder={t.compose.casPlaceholder}
                className="min-w-0 flex-1 rounded-lg bg-surface-hover px-3 py-1.5 font-mono text-base text-ink placeholder:text-ink-faint focus:bg-surface focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                onClick={addCasNumber}
                className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-strong"
              >
                Add
              </button>
            </div>
          )}

          {/* Quote post preview */}
          {quotePost && (
            <div className="mb-2 rounded-xl bg-surface-hover px-3 py-2 text-sm">
              <span className="font-semibold text-ink">
                @{quotePost.author.username}
              </span>
              <p className="mt-0.5 line-clamp-2 text-ink-muted">{quotePost.content}</p>
            </div>
          )}

          {/* Image previews — existing (edit mode) + newly picked */}
          {(existingImages.length > 0 || imageUrls.length > 0) && (
            <div className="mb-2 grid grid-cols-4 gap-2">
              {existingImages.map((url, i) => (
                <div key={`e${i}`} className="relative aspect-square overflow-hidden rounded-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeExistingImage(i)}
                    className="absolute right-1 top-1 rounded-full bg-surface/80 p-1 text-ink hover:bg-surface"
                    aria-label={t.compose.removeImage}
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {imageUrls.map((url, i) => (
                <div key={`n${i}`} className="relative aspect-square overflow-hidden rounded-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(i)}
                    className="absolute right-1 top-1 rounded-full bg-surface/80 p-1 text-ink hover:bg-surface"
                    aria-label={t.compose.removeImage}
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Footer */}
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
            <div className="flex items-center gap-1">
              {mediaAllowed && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    multiple={MAX_IMAGES - totalImages > 1}
                    className="hidden"
                    onChange={onPickImages}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={totalImages >= MAX_IMAGES || compressing}
                    className="rounded-full p-2 text-brand transition-colors hover:bg-brand-tint disabled:opacity-40"
                    aria-label={t.compose.addImages}
                    title={t.compose.addImagesTitle(MAX_IMAGES)}
                  >
                    {compressing ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" /> : <ImageIcon className="h-5 w-5" />}
                  </button>
                  {totalImages > 0 && (
                    <span className="text-xs tabular-nums text-ink-muted">
                      {totalImages}/{MAX_IMAGES}
                    </span>
                  )}
                </>
              )}

              {/* Flask button — specify CAS number */}
              <button
                type="button"
                onClick={() => setShowCasInput(!showCasInput)}
                className={cn(
                  'rounded-full p-2 transition-colors hover:bg-brand-tint',
                  showCasInput || casNumbers.length > 0 ? 'text-brand bg-brand-tint' : 'text-brand'
                )}
                aria-label={t.compose.addCasNumber}
                title={t.compose.addCasTitle}
              >
                <FlaskIcon className="h-5 w-5" />
              </button>

              <span className={cn('ml-1 text-sm tabular-nums', counterColor)}>
                {remaining}
              </span>
            </div>

            <Button
              type="button"
              size="sm"
              loading={submitting}
              disabled={!canSubmit}
              onClick={handleSubmit}
            >
              {editPost ? t.compose.save : t.compose.post}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ComposeBox
