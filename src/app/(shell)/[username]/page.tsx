import { redirect } from 'next/navigation'

// /[username] is the canonical handle route from the original spec, but the
// shared UI components (Sidebar, PostCard, ProfileCard, …) all link to
// /u/[username]. Keep this route working by forwarding to the canonical URL.
export default async function UsernameRedirectPage({
  params,
}: {
  params: Promise<{ username: string }>
}) {
  const { username } = await params
  redirect(`/u/${username}`)
}
