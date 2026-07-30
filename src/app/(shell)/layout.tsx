import { getCurrentUser } from '@/lib/auth'
import Sidebar from '@/components/layout/Sidebar'
import RightPanel from '@/components/layout/RightPanel'
import MobileNav from '@/components/layout/MobileNav'
import { BadgeProvider } from '@/components/BadgeProvider'
import { getLayoutData } from '@/lib/services/layout.service'

export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const currentUser = await getCurrentUser()

  const { trending, suggestions, notificationCount, messageCount, needsDocuments } =
    await getLayoutData(currentUser?.id ?? null, currentUser?.verificationStatus)

  return (
    <BadgeProvider initialNotificationCount={notificationCount} initialMessageCount={messageCount}>
      <div className="mx-auto flex w-full max-w-[1290px] justify-center">
        {/* Left sidebar — hidden on mobile, icon-only at md, full at xl */}
        <aside className="sticky top-0 hidden h-[100dvh] shrink-0 md:block md:w-[72px] xl:w-[275px]">
          <Sidebar
            currentUser={currentUser}
            needsDocuments={needsDocuments}
          />
        </aside>

        {/* Main feed column */}
        <main className="min-h-[100dvh] w-full min-w-0 flex-1 border-line/50 pb-14 md:border-x md:pb-0 xl:max-w-[600px]">
          {children}
        </main>

        {/* Right panel — hidden below lg */}
        <aside className="sticky top-0 hidden h-[100dvh] w-[350px] shrink-0 overflow-y-auto lg:block">
          <RightPanel trending={trending} suggestions={suggestions} />
        </aside>
      </div>

      {/* Bottom nav — mobile only */}
      <MobileNav />
    </BadgeProvider>
  )
}
