# SSPACE Profile API

Standalone Node.js/Express service for profile and profile-media endpoints. It reuses each visitor's existing Supabase Auth session and the existing public.profiles user IDs. It does not create accounts, require a PostgreSQL password, or change the website's production deployment.

## Runtime

- Node.js 22 or newer
- Existing SSPACE Supabase project through its Data API
- Persistent volume mounted at /data
- HTTPS public service URL

## Required environment variables

- SUPABASE_URL: existing SSPACE Supabase project URL
- SUPABASE_ANON_KEY: existing publishable key (public client key)
- FRONTEND_ORIGINS: comma-separated allowed website origins
- UPLOAD_DIR: persistent volume path, set to /data on Railway

Optional: MAX_PHOTO_MB and MAX_VIDEO_MB.

No DATABASE_URL, database password, service_role key, or Supabase secret key is used by this API. Each API request verifies the existing bearer token and forwards that same user-scoped token to Supabase PostgREST. Row Level Security decides which profiles and media rows that user may access.

## Database

The migration `sspace_profile_media_api_v45` has been applied to the existing Sspace project. It adds `profiles.is_private`, creates `public.profile_media`, enables RLS, and restricts private profile reads to the owner. A second migration grants authenticated users access only to their own media and media belonging to publicly visible profiles. It does not replace existing profiles or authentication.

## Endpoints

- GET /health
- GET /api/profil/me
- GET /api/profil/:userId
- GET /api/profil/:userId/media
- POST /api/profil/me/photo
- POST /api/profil/me/video
- GET /api/profil/media/:mediaId/content
- DELETE /api/profil/media/:mediaId

Every /api/profil route requires Authorization: Bearer <existing Supabase access token>. Uploaded files are signature-checked; SVG is not accepted. Photos are limited to 8 MB by default, videos to 50 MB. Files are not served from a public static directory.

## Railway

Set the service root directory to /profile-api, start command to npm start, healthcheck path to /health, and attach a persistent volume mounted at /data. The volume stores uploaded media only; metadata remains in Supabase. Do not deploy this service on the Vercel static frontend.
