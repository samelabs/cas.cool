'use client'

import { useSite } from '@/components/Providers'

/** Public brand text comes from SiteConfig through the shared site context. */
export function BrandWordmark() {
  const { name } = useSite()
  const separator = name.indexOf('.')
  if (separator <= 0) return name
  return <>{name.slice(0, separator)}<span className="text-ink">{name.slice(separator)}</span></>
}
