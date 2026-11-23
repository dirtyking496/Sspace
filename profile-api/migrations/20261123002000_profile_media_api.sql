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

-- Enforce profile privacy in direct Supabase reads as well as the Express API.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Profiles are public" ON public.profiles;
CREATE POLICY "Profiles are public"
  ON public.profiles FOR SELECT TO public
  USING (NOT is_private OR id = auth.uid());

ALTER TABLE public.profile_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.profile_media FROM PUBLIC, anon, authenticated;

-- A dedicated NOLOGIN role is created by the migration. A separate secret is
-- assigned to it at deployment time and stored only in Railway's variables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sspace_profile_api') THEN
    EXECUTE 'CREATE ROLE sspace_profile_api NOLOGIN';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO sspace_profile_api;
GRANT SELECT (id, username, display_name, avatar_url, cover_url, status_text, is_private)
  ON public.profiles TO sspace_profile_api;
GRANT SELECT, INSERT, DELETE ON public.profile_media TO sspace_profile_api;

-- The server-only role can read profiles and media metadata; the Express
-- handlers enforce ownership/privacy using the verified Supabase user ID.
DROP POLICY IF EXISTS "SSPACE API reads profiles" ON public.profiles;
CREATE POLICY "SSPACE API reads profiles"
  ON public.profiles FOR SELECT TO sspace_profile_api
  USING (true);

DROP POLICY IF EXISTS "SSPACE API reads profile media" ON public.profile_media;
CREATE POLICY "SSPACE API reads profile media"
  ON public.profile_media FOR SELECT TO sspace_profile_api
  USING (true);

DROP POLICY IF EXISTS "SSPACE API inserts profile media" ON public.profile_media;
CREATE POLICY "SSPACE API inserts profile media"
  ON public.profile_media FOR INSERT TO sspace_profile_api
  WITH CHECK (true);

DROP POLICY IF EXISTS "SSPACE API deletes profile media" ON public.profile_media;
CREATE POLICY "SSPACE API deletes profile media"
  ON public.profile_media FOR DELETE TO sspace_profile_api
  USING (true);

COMMENT ON TABLE public.profile_media IS
  'Profile media metadata managed by the authenticated SSPACE Express API; no parallel user accounts are created.';
