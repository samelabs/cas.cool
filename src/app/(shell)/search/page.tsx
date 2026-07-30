import { redirect } from 'next/navigation'

// The shared search box and hashtag links submit to /search?q=… . Forward to
// the Explore page which renders the results.
export default async function SearchRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(sp)) {
    const val = Array.isArray(v) ? v[0] : v
    if (val) qs.set(k, val)
  }
  const query = qs.toString()
  redirect(query ? `/explore?${query}` : '/explore')
}
