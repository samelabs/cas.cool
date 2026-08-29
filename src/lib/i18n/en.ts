/**
 * CAS.cool — English language pack (i18n baseline)
 *
 * This is the single source of truth for all user-facing text.
 * Import via `import { t } from '@/lib/i18n'`.
 *
 * Terminology rules:
 *  - "CAS.cool" — always this capitalization
 *  - "post" lowercase as common noun, "Post" as UI button/label
 *  - "Sign in" / "Sign out" (not Log in/out)
 *  - No exclamation marks in toast/error messages
 *  - Professional, concise, industry-standard vocabulary
 */

export const en = {
  // ─── Brand ─────────────────────────────────────────────
  brand: {
    name: 'CAS.cool',
    tagline: 'Discover and share chemicals.',
  },

  // ─── Navigation ────────────────────────────────────────
  nav: {
    home: 'Home',
    explore: 'Explore',
    notifications: 'Notifications',
    messages: 'Messages',
    bookmarks: 'Bookmarks',
    profile: 'Profile',
    settings: 'Settings',
    verify: 'Verify',
    admin: 'Admin',
    newPost: 'New post',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    logOut: 'Log out',
    activities: (count: number) => `${count} activities`,
  },

  // ─── Common UI ─────────────────────────────────────────
  common: {
    dismiss: 'Dismiss',
    loadingEllipsis: 'Loading…',
    loadingMore: 'Loading more…',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    search: 'Search',
    posts: (count: number) =>
      `${count} ${count === 1 ? 'post' : 'posts'}`,
    editedAt: (time: string) => `Edited ${time}`,
    moreOptions: 'More options',
    uploading: 'Uploading…',
    deleting: 'Deleting…',
    submitting: 'Submitting…',
    verified: 'Verified',
    notVerified: 'Not verified',
    underReview: 'Under review',
    signIn: 'Sign in',
    createAccount: 'Create account',
    openInNew: 'View this post on CAS.cool',
    active: 'Active',
    restricted: 'Restricted',
    suspended: 'Suspended',
    close: 'Close',
    previous: 'Previous',
    next: 'Next',
    imageViewer: 'Image viewer',
    post: 'Post',
  },

  // ─── Auth ──────────────────────────────────────────────
  auth: {
    // Login
    loginTitle: 'Sign in to CAS.cool',
    loginSubtitle: 'Discover and share chemicals.',
    emailOrUsername: 'Email or username',
    emailOrUsernamePlaceholder: 'you@example.com or @username',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    signIn: 'Sign in',
    welcomeBack: 'Welcome back',
    newToCascool: 'New to CAS.cool?',
    createAccount: 'Create account',
    invalidCredentials: 'Invalid email, username, or password.',
    // Register
    registerTitle: 'Join CAS.cool',
    registerSubtitle: 'Join the community for chemistry.',
    displayName: 'Display name',
    displayNamePlaceholder: 'Your name',
    username: 'Username',
    usernamePlaceholder: 'your_name',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    passwordMin: 'At least 8 characters',
    confirmPassword: 'Confirm password',
    confirmPasswordPlaceholder: 'Re-enter your password',
    createAccountBtn: 'Create account',
    alreadyHaveAccount: 'Already have an account?',
    // Validation
    errUsernameShort: 'Username must be at least 3 characters.',
    errUsernameTaken: 'That username is already taken.',
    errPasswordShort: 'Password must be at least 8 characters.',
    errPasswordMismatch: 'Passwords do not match.',
    errRegisterFailed: 'Registration failed.',
    accountCreated: 'Account created — welcome to CAS.cool',
    // Username availability
    checking: 'Checking…',
    usernameTaken: 'That username is taken.',
    usernameAvailable: 'Available.',
    usernameHint: 'Letters, numbers and underscores.',
    // Sign out
    signedOut: 'Signed out',
  },

  // ─── Compose ───────────────────────────────────────────
  compose: {
    title: 'Compose',
    newPost: 'New Post',
    editPost: 'Edit Post',
    quotePost: 'Quote Post',
    placeholder: 'Share a chemical insight...',
    quotePlaceholder: 'Add a comment...',
    post: 'Post',
    save: 'Save',
    addCasNumber: 'Add CAS number',
    addCasTitle: 'Tag a chemical by CAS number',
    casPlaceholder: 'Enter CAS number (e.g. 64-17-5)',
    removeCas: (cas: string) => `Remove ${cas}`,
    casInvalid: 'Invalid CAS format (e.g. 64-17-5)',
    addImages: 'Add images',
    addImagesTitle: (max: number) => `Add images (max ${max})`,
    removeImage: 'Remove image',
    tooManyImages: (max: number) => `You can only add up to ${max} images.`,
    imagesExceeded: (room: number, max: number) =>
      `Only ${room} more ${room === 1 ? 'image' : 'images'} allowed (max ${max}).`,
    pleaseSignIn: 'Please sign in to post.',
    posted: 'Posted',
    postUpdated: 'Post updated',
    failedToPost: 'Failed to post',
    failedToEdit: 'Failed to save edit',
  },

  // ─── Post Actions ──────────────────────────────────────
  postActions: {
    reply: 'Reply',
    repost: 'Repost',
    undoRepost: 'Undo repost',
    quote: 'Quote',
    like: 'Like',
    unlike: 'Unlike',
    views: 'Views',
    bookmark: 'Bookmark',
    removeBookmark: 'Remove bookmark',
    actionFailed: 'Action failed',
    pleaseSignIn: 'Please sign in first',
  },

  // ─── Post Menu ─────────────────────────────────────────
  postMenu: {
    editPost: 'Edit post',
    reportPost: 'Report post',
    share: 'Share',
    copyLink: 'Copy link',
    linkCopied: 'Link copied to clipboard',
    copyFailed: 'Failed to copy',
    deletePost: 'Delete post',
    deleteConfirm: 'Delete this post?',
    deleteWarning: 'This action cannot be undone.',
    postDeleted: 'Post deleted',
    failedToDelete: 'Failed to delete post',
    postBy: (username: string) => `Post by @${username}`,
  },

  // ─── Share ─────────────────────────────────────────────
  share: {
  },

  // ─── Post Card ─────────────────────────────────────────
  postCard: {
    reposted: 'Reposted',
    quoted: 'Quoted',
    cas: (casNumber: string) => `CAS ${casNumber}`,
    viewImage: 'View image',
    postImage: 'Post image',
    viewImageN: (n: number) => `View image ${n}`,
    postImageN: (n: number) => `Post image ${n}`,
    openPost: 'Open post',
    deleted: 'This post was deleted',
  },

  // ─── Feed / Timeline ───────────────────────────────────
  feed: {
    latest: 'Latest',
    following: 'Following',
    noPostsYet: 'No posts yet',
    noPostsFollowing: 'No posts from people you follow yet',
    followingEmptyHint: 'Follow people to fill your timeline.',
    forYouEmptyHint: 'Be the first to share something.',
    failedToLoad: 'Failed to load posts. Please try again.',
    nothingHereYet: 'Nothing here yet',
    endOfFeed: "You're all caught up",
    newPostsAvailable: 'New posts available',
  },

  // ─── Profile ───────────────────────────────────────────
  profile: {
    editProfile: 'Edit profile',
    message: 'Message',
    following: 'Following',
    followers: 'Followers',
    unfollow: 'Unfollow',
    follow: 'Follow',
    followed: 'Followed',
    unfollowed: 'Unfollowed',
    pleaseSignInToFollow: 'Please sign in to follow people.',
    requestFailed: 'Request failed',
    tabs: {
      posts: 'Posts',
      replies: 'Replies',
      media: 'Media',
      likes: 'Likes',
    },
    notFound: 'User not found',
    reportUser: 'Report user',
  },

  // ─── Messages ──────────────────────────────────────────
  messages: {
    title: 'Messages',
    conversation: 'Conversation',
    newConversation: 'New message',
    sayHello: 'Say hello',
    placeholderNew: 'Start a new message',
    send: 'Send',
    youPrefix: 'You: ',
    conversationDeleted: (name: string) => `Conversation with ${name} deleted.`,
    failedToDelete: 'Failed to delete conversation.',
    messageFailed: 'Message could not be sent.',
    replyPlaceholder: 'Post your reply',
    replyPosted: 'Reply posted',
    failedToReply: 'Failed to reply',
    noConversations: 'No conversations yet',
    startFromProfile: 'Start a conversation from someone\'s profile.',
    sayHelloToStart: 'Say hello to start the conversation.',
  },

  // ─── Notifications ─────────────────────────────────────
  notifications: {
    title: 'Notifications',
    emptyTitle: 'No notifications yet',
    emptyHint: 'When someone interacts with you, it will show up here.',
    unread: 'Unread',
    copy: {
      LIKE: 'liked your post',
      COMMENT: 'replied to your post',
      FOLLOW: 'followed you',
      REPOST: 'reposted your post',
      MESSAGE: 'sent you a message',
      MENTION: 'mentioned you',
      REPORT_RESOLVED: 'resolved a report',
    } as const,
  },

  // ─── Explore / Search ──────────────────────────────────
  explore: {
    title: 'Explore',
    trendingChemicals: 'Trending Chemicals',
    noTrending: 'No trending chemicals yet.',
    trending: (i: number) => `#${i} · Trending`,
    people: 'People',
    whoToFollow: 'Who to Follow',
    noSuggestions: 'No suggestions available yet.',
    findMorePeople: 'Find more people',
    searchPlaceholder: 'Search posts, CAS numbers, chemicals…',
    sidebarSearchPlaceholder: 'Search chemicals, CAS, people',
    noResults: (q: string) => `No results for "${q}"`,
    noPosts: 'No posts yet',
  },

  // ─── Bookmarks ─────────────────────────────────────────
  bookmarks: {
    title: 'Bookmarks',
    saved: (count: number) => `${count} saved`,
    empty: 'No bookmarks yet',
  },

  // ─── Settings ──────────────────────────────────────────
  settings: {
    title: 'Settings',
    profile: 'Profile',
    profileDesc: 'Update your photo, name, bio, and personal details',
    security: 'Security',
    securityDesc: 'Change your password and manage account security',
    banner: 'Banner',
    uploadAvatar: 'Upload avatar',
    clickToUploadBanner: 'Click to upload banner',
    changeBanner: 'Change banner',
    removeBanner: 'Remove banner',
    bannerUpdated: 'Banner updated',
    bannerUploadFailed: 'Banner upload failed.',
    bannerRemoved: 'Banner removed',
    bannerRemoveFailed: 'Failed to remove banner',
    bannerVerificationRequired: 'Banner upload requires identity verification.',
    bannerConfirmUpload: 'Apply',
    avatarUpdated: 'Avatar updated',
    avatarUploadFailed: 'Upload failed.',
    avatarHint: 'Click avatar to upload (jpg, png, webp, gif · max 10MB)',
    avatarVerifyHint: 'Verify identity to upload avatar',
    displayName: 'Display name',
    bio: 'Bio',
    location: 'Location',
    locationPlaceholder: 'Shanghai, CN',
    website: 'Website',
    websitePlaceholder: 'https://company.com',
    saveProfile: 'Save profile',
    profileUpdated: 'Profile updated.',
    profileSaveFailed: 'Could not save profile.',
    getVerified: 'Get verified',
    viewDetails: 'View',
    currentPassword: 'Current password',
    newPassword: 'New password',
    changePassword: 'Change password',
    passwordChanged: 'Password changed. You have been signed out on other devices.',
    passwordShort: 'New password must be at least 8 characters.',
    passwordTooLong: 'Password must be at most 128 characters.',
    passwordChangeFailed: 'Could not change password.',
  },

  // ─── Verification ──────────────────────────────────────
  verify: {
    title: 'Identity Verification',
    verified: 'Verified',
    confirmed: 'Your identity has been confirmed.',
    verifiedOn: (date: string) => `Verified on ${date}.`,
    validUntil: (date: string) => `Valid until ${date}.`,
    documentsRequired: 'Verification documents required',
    adminGrantedL1: 'Your verified status was granted by an administrator.',
    adminGrantedL2: 'To maintain verification through annual review, please submit your identity documents below.',
    underReview: 'Under Review',
    submissionReceived: (date: string) => `Your submission was received on ${date}.`,
    reviewPending: 'Our team will review your documents and respond shortly.',
    benefits: 'Verification Benefits',
    capability: 'Capability',
    unverifiedCol: 'Unverified',
    verifiedCol: 'Verified',
    postLength: 'Post length',
    charLimitUnverified: '300 chars',
    charLimitVerified: '2,000 chars',
    postImages: 'Post images',
    none: '—',
    upTo4: 'Up to 4',
    avatarBanner: 'Avatar & banner',
    search: 'Search',
    dm: 'Direct messaging',
    dmUnverified: 'Followers only',
    dmVerified: 'All users',
    annualReview: 'Annual Review',
    annualReviewDesc:
      'Verification is valid for 12 months from the date of approval. Before your verification expires, you will be notified to submit a renewal request with current documents. Failure to renew before the expiry date will result in the loss of verified status and its associated permissions.',
    submittedInfo: 'Submitted Information',
    legalName: 'Legal name',
    idNumber: 'ID number',
    // Panel
    submitDocs: 'Submit Verification Documents',
    completeDocs: 'Complete Verification Documents',
    panelHintNew: 'Complete the form below to request identity verification. All fields are required.',
    panelHintSupplemental: 'Your verified status is active. Submit your identity documents to maintain it through annual review.',
    legalNamePlaceholder: 'As shown on your ID document',
    idNumberPlaceholder: 'National ID, passport, or license number',
    allFieldsRequired: 'Please complete all required fields.',
    bothSidesRequired: 'Please upload both sides of your ID document.',
    submitted: 'Verification submitted.',
    submissionFailed: 'Submission failed.',
    uploadFailed: 'Upload failed.',
    previousRejected: 'Previous submission was rejected',
    resubmitInfo: 'You may resubmit with corrected information.',
    uploadFrontSide: 'Click to upload front side',
    uploadBackSide: 'Click to upload back side',
    acceptedDocs: 'Any government-issued identification document from any country is accepted (national identity card, passport, or driver\'s license). Submitted documents are reviewed exclusively by platform administrators and are not displayed publicly.',
    submitRequest: 'Submit verification request',
  },

  // ─── Report ────────────────────────────────────────────
  report: {
    title: (type: 'post' | 'user') => `Report ${type}`,
    reasons: {
      spam: 'Spam or repetitive content',
      harassment: 'Harassment or abuse',
      misinformation: 'Misinformation',
      illegal_substance: 'Illegal substance or activity',
      scam_fraud: 'Scam or fraud',
      impersonation: 'Impersonation',
      other: 'Something else',
    } as const,
    detailsPlaceholder: 'Additional details (optional)',
    whyReporting: 'Why are you reporting this?',
    submit: 'Submit report',
    submitted: 'Report submitted. Thank you.',
    failed: 'Failed to submit report.',
    // Admin-facing reason labels (short form)
    reasonLabels: {
      spam: 'Spam',
      harassment: 'Harassment',
      misinformation: 'Misinformation',
      illegal_substance: 'Illegal substance',
      scam_fraud: 'Scam / Fraud',
      impersonation: 'Impersonation',
      other: 'Other',
    } as const,
  },

  // ─── Admin ─────────────────────────────────────────────
  admin: {
    panelTitle: 'Admin Panel',
    tabs: {
      verifications: 'Verifications',
      users: 'Users',
      reports: 'Reports',
    },
    // Reports
    pending: 'Pending',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
    all: 'All',
    noReports: 'No reports',
    loadingFailed: 'Failed to load reports',
    resolvedToast: 'Report resolved',
    resolveFailed: 'Failed to resolve',
    dismissedToast: 'Report dismissed',
    dismissFailed: 'Failed to dismiss',
    postReport: 'Post report',
    userReport: 'User report',
    reportedUser: 'Reported user:',
    reportedBy: 'Reported by',
    actions: {
      suspendUser: 'Suspend user',
      warnOnly: 'Warn only',
      dismiss: 'Dismiss',
    },
    // Users
    usersLoadFailed: 'Failed to load',
    verificationRevoked: 'Verification revoked',
    userVerified: 'User verified',
    searchUsername: 'Search username',
    noUsersFound: 'No users found',
    searchHint: 'Search by username or pick a status filter',
    verifyBtn: 'Verify',
    verifiedBtn: '✓ Verified',
    // Verifications
    verificationsLoadFailed: 'Failed to load',
    noSubmissions: 'No submissions',
    pendingTab: 'Pending',
    approvedTab: 'Approved',
    rejectedTab: 'Rejected',
    allTab: 'All',
    submittedLabel: 'Submitted',
    approve: 'Approve',
    reject: 'Reject',
    approveToast: 'Verification approved',
    approveFailed: 'Failed to approve',
    confirmReject: 'Confirm reject',
    rejectToast: 'Verification rejected',
    rejectFailed: 'Failed to reject',
    approvedPrefix: '✓ Approved',
    rejectedPrefix: '✗ Rejected',
    onDate: (date: string) => `on ${date}`,
    noteLabel: (note: string) => `Note: ${note}`,
    expiresLabel: (date: string) => `Expires: ${date}`,
    idFront: 'ID front',
    idBack: 'ID back',
  },

  // ─── About ─────────────────────────────────────────────
  about: {
    title: 'About',
    whatIs: 'What is CAS.cool?',
    description:
      'CAS.cool is an open-source web app built with Next.js, React, and PostgreSQL. Source code is publicly available on GitHub.',
    features: 'Features',
    casNumbered: 'CAS-Numbered Posts',
    casNumberedDesc: 'Tag any post with a CAS Registry Number to link it to a specific chemical compound.',
    quoteRepost: 'Quote & Repost',
    quoteRepostDesc: 'Repost or quote other users\' posts with your own commentary.',
    directMessaging: 'Direct Messaging',
    directMessagingDesc: 'Send private messages to other registered users.',
    smartSearch: 'Search',
    smartSearchDesc: 'Search posts and users by CAS number, chemical name, or keyword.',
    cta: 'Create an account to start posting.',
  },

  // ─── Errors ────────────────────────────────────────────
  errors: {
    somethingWrong: 'Something went wrong',
    unexpectedError: 'An unexpected error occurred. Please try again.',
    notFound404: '404',
    notFoundMessage: "This page doesn't exist or may have been removed.",
    backToHome: 'Back to CAS.cool',
    unauthorized: 'Unauthorized',
    failedToSendMessage: 'Failed to send message',
    uploadFailed: 'Upload failed',
    failed: 'Failed',
  },

  // ─── API Keys (external API management) ────────────────
  api: {
    title: 'API Keys',
    description: 'Generate API keys to access cas.cool programmatically. Available for verified members only.',
    createKey: 'Create new key',
    keyNamePlaceholder: 'e.g. My chemistry bot',
    create: 'Create key',
    noKeys: 'No API keys yet.',
    rawKeyWarning: 'Copy this key now. You won\'t be able to see it again.',
    rawKeyCopied: 'Copied to clipboard',
    copyKey: 'Copy key',
    revoke: 'Revoke',
    revokeConfirm: 'Revoke this API key? This cannot be undone.',
    lastUsed: 'Last used',
    never: 'Never',
    createdAt: 'Created',
    verificationRequired: 'API access is available for verified members only.',
    keyCreated: 'API key created successfully.',
    keyRevoked: 'API key revoked.',
    expiresAt: 'Expires',
  },

  // ─── SEO / Meta ────────────────────────────────────────
  seo: {
    siteName: 'CAS.cool',
    titleDefault: 'CAS.cool — Chemical Social Network',
    titleTemplate: '%s · CAS.cool',
    description:
      'CAS.cool is the community to discover and share chemicals — explore compounds by CAS Registry Number, share knowledge, and connect with people worldwide.',
    keywords: [
      'chemistry', 'chemical', 'CAS number', 'CAS registry',
      'compounds', 'molecules', 'cas.cool',
    ],
    og: {
      title: 'CAS.cool — Chemical Social Network',
      description: 'Discover and share chemicals by CAS Registry Number.',
      siteName: 'CAS.cool',
    },
    twitter: {
      title: 'CAS.cool — Chemical Social Network',
      description: 'Discover and share chemicals.',
    },
    // Home page
    homeTitle: 'Discover & Share Chemical Knowledge',
    homeDescription:
      'Discover and share chemicals. Explore compounds by CAS Registry Number, share knowledge, and connect with the chemistry community.',
    // Dynamic pages
    postNotFound: 'Post not found',
    postByAuthor: (author: string) => `${author} on CAS.cool`,
    postWithCas: (author: string, cas: string) => `${author} posted CAS ${cas}`,
    casInvalid: 'Invalid CAS Number',
    casTitle: (cas: string, name: string | null) =>
      name ? `CAS ${cas} — ${name}` : `CAS ${cas}`,
    aboutDescription: 'About CAS.cool — discover and share chemicals.',
    verifyTitle: 'Identity Verification — CAS.cool',
    verifyDescription: 'Verify your identity to unlock full platform access.',
  },
} as const

export type Dictionary = typeof en
