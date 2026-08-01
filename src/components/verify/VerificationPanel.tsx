'use client'

import { useState, useRef, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { t } from '@/lib/i18n'
import { postForm, post } from '@/lib/api-client'

export interface VerificationPanelProps {
  variant?: 'initial' | 'supplemental'
  existingSubmission: {
    idName: string
    idNumber: string
    idFrontImage: string
    idBackImage: string
    reviewNote: string | null
  } | null
}

export default function VerificationPanel({ variant = 'initial', existingSubmission }: VerificationPanelProps) {
  const router = useRouter()
  const { showToast } = useToast()

  const [idName, setIdName] = useState(existingSubmission?.idName ?? '')
  const [idNumber, setIdNumber] = useState(existingSubmission?.idNumber ?? '')
  const [idFrontImage, setIdFrontImage] = useState(existingSubmission?.idFrontImage ?? '')
  const [idBackImage, setIdBackImage] = useState(existingSubmission?.idBackImage ?? '')
  const [uploadingFront, setUploadingFront] = useState(false)
  const [uploadingBack, setUploadingBack] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const frontInputRef = useRef<HTMLInputElement>(null)
  const backInputRef = useRef<HTMLInputElement>(null)

  const uploadFile = async (file: File): Promise<string | null> => {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('purpose', 'verification')
    const result = await postForm<{ url: string; filename: string; bytes: number }>('/api/upload', formData)
    if (!result.ok || !result.data) return null
    return result.data.url
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!idName.trim() || !idNumber.trim()) {
      showToast(t.verify.allFieldsRequired, 'error')
      return
    }
    if (!idFrontImage || !idBackImage) {
      showToast(t.verify.bothSidesRequired, 'error')
      return
    }
    setSubmitting(true)
    try {
      const result = await post('/api/account/verification', {
        idName: idName.trim(),
        idNumber: idNumber.trim(),
        idFrontImage,
        idBackImage,
      })
      if (!result.ok) {
        throw new Error(result.error || t.verify.submissionFailed)
      }
      showToast(t.verify.submitted, 'success')
      router.refresh()
    } catch (err) {
      showToast(err instanceof Error ? err.message : t.errors.somethingWrong, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls =
    'w-full rounded-lg border border-line-strong bg-canvas px-3 py-2.5 text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand'
  const labelCls = 'mb-1 block text-sm font-medium text-ink-muted'

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h3 className="mb-1 text-base font-bold text-ink">
        {variant === 'supplemental' ? t.verify.completeDocs : t.verify.submitDocs}
      </h3>
      <p className="mb-4 text-sm text-ink-muted">
        {variant === 'supplemental'
          ? t.verify.panelHintSupplemental
          : t.verify.panelHintNew}
      </p>

      {existingSubmission?.reviewNote && (
        <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3">
          <p className="text-sm font-semibold text-danger">{t.verify.previousRejected}</p>
          <p className="mt-1 text-sm text-ink-muted">{existingSubmission.reviewNote}</p>
          <p className="mt-1 text-xs text-ink-faint">{t.verify.resubmitInfo}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name + ID number */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>
              Full legal name <span className="text-danger">*</span>
            </label>
            <input
              className={inputCls}
              value={idName}
              onChange={(e) => setIdName(e.target.value)}
              maxLength={100}
              placeholder={t.verify.legalNamePlaceholder}
            />
          </div>
          <div>
            <label className={labelCls}>
              ID number <span className="text-danger">*</span>
            </label>
            <input
              className={inputCls}
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value)}
              maxLength={50}
              placeholder={t.verify.idNumberPlaceholder}
            />
          </div>
        </div>

        {/* ID photo uploads */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Front */}
          <div>
            <label className={labelCls}>
              ID document — front side <span className="text-danger">*</span>
            </label>
            <div
              className="group relative h-44 cursor-pointer overflow-hidden rounded-lg border-2 border-dashed border-line-strong bg-canvas transition-colors hover:border-brand"
              onClick={() => !uploadingFront && frontInputRef.current?.click()}
            >
              {idFrontImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={idFrontImage} alt={t.admin.idFront} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-faint">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-8 w-8">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                  <span className="text-xs">{t.verify.uploadFrontSide}</span>
                </div>
              )}
              {uploadingFront && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <span className="text-xs font-semibold text-white">Uploading…</span>
                </div>
              )}
            </div>
            <input
              ref={frontInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setUploadingFront(true)
                try {
                  const url = await uploadFile(file)
                  if (!url) throw new Error()
                  setIdFrontImage(url)
                } catch {
                  showToast(t.verify.uploadFailed, 'error')
                } finally {
                  setUploadingFront(false)
                  if (frontInputRef.current) frontInputRef.current.value = ''
                }
              }}
            />
          </div>

          {/* Back */}
          <div>
            <label className={labelCls}>
              ID document — back side <span className="text-danger">*</span>
            </label>
            <div
              className="group relative h-44 cursor-pointer overflow-hidden rounded-lg border-2 border-dashed border-line-strong bg-canvas transition-colors hover:border-brand"
              onClick={() => !uploadingBack && backInputRef.current?.click()}
            >
              {idBackImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={idBackImage} alt={t.admin.idBack} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 text-ink-faint">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-8 w-8">
                    <rect width="18" height="18" x="3" y="3" rx="2" />
                    <circle cx="9" cy="9" r="2" />
                    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                  </svg>
                  <span className="text-xs">{t.verify.uploadBackSide}</span>
                </div>
              )}
              {uploadingBack && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                  <span className="text-xs font-semibold text-white">Uploading…</span>
                </div>
              )}
            </div>
            <input
              ref={backInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setUploadingBack(true)
                try {
                  const url = await uploadFile(file)
                  if (!url) throw new Error()
                  setIdBackImage(url)
                } catch {
                  showToast(t.verify.uploadFailed, 'error')
                } finally {
                  setUploadingBack(false)
                  if (backInputRef.current) backInputRef.current.value = ''
                }
              }}
            />
          </div>
        </div>

        {/* Privacy notice */}
        <div className="rounded-lg bg-canvas px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-faint">
            Any government-issued identification document from any country is accepted
            (national identity card, passport, or driver&apos;s license).
            Submitted documents are reviewed exclusively by platform administrators and
            are not displayed publicly.
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            type="submit"
            loading={submitting}
            disabled={!idName.trim() || !idNumber.trim() || !idFrontImage || !idBackImage}
          >
            Submit verification request
          </Button>
        </div>
      </form>
    </section>
  )
}
