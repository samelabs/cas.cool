// Shared TypeScript types used across the app

export type VerificationStatus = 'unverified' | 'pending' | 'verified'
export type UserStatus = 'active' | 'restricted' | 'suspended'

export interface SafeUser {
  id: string
  email?: string
  username: string
  displayName: string | null
  bio: string | null
  avatar: string | null
  banner: string | null
  location: string | null
  website: string | null
  role: string
  verificationStatus: string // unverified | pending | verified
  verifiedAt: Date | null
  verificationExpiresAt: Date | null
  status: string // active | restricted | suspended
  createdAt: Date
  // Denormalized counts (same pattern as Post.likeCount etc.)
  postCount: number
  followerCount: number
  followingCount: number
  _count?: {
    posts: number
    followers: number
    following: number
  }
}

/** Shorthand for VerifiedBadge rendering — true only when fully verified. */
export function isVerified(user: Pick<SafeUser, 'verificationStatus'>): boolean {
  return user.verificationStatus === 'verified'
}
export interface VerificationSubmission {
  id: string
  userId: string
  idName: string
  idNumber: string
  idFrontImage: string
  idBackImage: string
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy: string | null
  reviewedAt: Date | null
  expiresAt: Date | null
  reviewNote: string | null
  submittedAt: Date
}

export interface SafeChemical {
  id: string
  casNumber: string
  postCount: number
}

export interface SafePost {
  id: string
  shortCode: string | null
  authorId: string
  parentId: string | null
  /** Conversation root post ID. null for root posts; root.id for all replies. */
  conversationId: string | null
  /** Username of the parent post's author (for "Replying to @xxx" on profile replies tab). */
  replyToUsername?: string | null
  content: string
  quotePostId: string | null
  quotedPost?: SafePost | null
  chemicals: SafeChemical[]
  images: string[]
  views: number
  createdAt: Date
  updatedAt?: Date
  editedAt?: Date | null
  deletedAt?: Date | null
  author: SafeUser
  _count?: {
    replies: number
    likes: number
    reposts: number
    bookmarks: number
  }
  liked?: boolean
  reposted?: boolean
  bookmarked?: boolean
}

export interface SafeConversation {
  id: string
  otherUser: SafeUser
  lastMessage?: {
    content: string
    createdAt: Date
    senderId: string
  }
  unreadCount: number
}

export interface SafeNotification {
  id: string
  type: 'LIKE' | 'COMMENT' | 'FOLLOW' | 'REPOST' | 'MESSAGE' | 'MENTION' | 'REPORT_RESOLVED'
  from: SafeUser
  postId: string | null
  postShortCode?: string | null
  read: boolean
  createdAt: Date
}
