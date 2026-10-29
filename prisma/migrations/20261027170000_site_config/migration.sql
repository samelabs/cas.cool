CREATE TABLE "SiteConfig" (
  "id" INTEGER NOT NULL,
  "origin" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "tagline" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteConfig_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SiteConfig" ("id", "origin", "name", "shortName", "description", "tagline", "updatedAt")
VALUES (
  1,
  'https://cas.cool',
  'CAS.cool',
  'CAS.cool',
  'The social network for the global chemical trade',
  'Discover and share chemicals.',
  CURRENT_TIMESTAMP
);
