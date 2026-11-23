-- SSPACE Profile API: profile privacy support and private media metadata.
-- Existing profile IDs and auth sessions remain unchanged.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.profile_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  media_type text NOT NULL CHECK (media_type IN ('photo', 'video')),
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm')
  ),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_media_owner_created_idx
  ON public.profile_media(owner_id, created_at DESC);

ALTER TABLE public.profile_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_media FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.profile_media IS
  'Profile media metadata managed by the authenticated SSPACE Express API; no parallel user accounts are created.';