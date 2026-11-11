import { getCurrentUser } from '@/lib/auth'
import Sidebar from '@/components/layout/Sidebar'
import RightPanel from '@/components/layout/RightPanel'
import MobileNav from '@/components/layout/MobileNav'
import { BadgeProvider } from '@/components/BadgeProvider'
import { getLayoutData } from '@/lib/services/layout.service'

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const currentUser = await getCurrentUser()

  const { trending, notificationCount, messageCount, needsDocuments } =
    await getLayoutData(currentUser?.id ?? null, currentUser?.verificationStatus)

  return (
    <BadgeProvider initialNotificationCount={notificationCount} initialMessageCount={messageCount}>
      {/* App-shell layering (mobile): the viewport-height row pins the app
          and the feed column (main) is the scroll container — the document
          itself never scrolls, so the soft keyboard cannot push page
          content. Desktop keeps normal document scrolling (h-auto). */}
      <div className="mx-auto flex w-full max-w-[1290px] justify-center h-[100dvh] md:h-auto">
        {/* Left sidebar — hidden on mobile, icon-only at md, full at xl */}
        <aside className="sticky top-0 hidden max-h-[100dvh] shrink-0 md:block md:w-[72px] xl:w-[275px]">
          <Sidebar
            currentUser={currentUser}
            needsDocuments={needsDocuments}
          />
        </aside>

        {/* Main feed column.
            scrollbar-gutter: stable reserves scrollbar space on every page
            so that switching between long (scrollable) and short (non-
            scrollable) pages never causes horizontal layout shift. */}
        <main
          id="feed-scroller"
          className="flex w-full min-w-0 flex-1 flex-col border-line/50 pb-[calc(env(safe-area-inset-bottom)+5rem)] max-md:h-full max-md:min-h-0 max-md:overflow-y-auto max-md:overscroll-contain md:min-h-[100dvh] md:border-x md:pb-0 xl:max-w-[600px] [scrollbar-gutter:stable]"
        >
          {children}
        </main>

        {/* Right panel — hidden below lg */}
        <aside className="sticky top-0 hidden max-h-[100dvh] w-[350px] shrink-0 overflow-y-auto lg:block">
          <RightPanel trending={trending} />
        </aside>
      </div>

      {/* Bottom nav — mobile only */}
      <MobileNav />
    </BadgeProvider>
  )
}
