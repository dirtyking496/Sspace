# SSPACE Profile API

Standalone Node.js/Express service for profile and profile-media endpoints. It reuses the existing Supabase Auth session and the existing public.profiles user IDs. It does not create accounts or change the website's production deployment.

## Runtime

- Node.js 22 or newer
- PostgreSQL connection to the existing SSPACE Supabase project
- Persistent volume mounted at /data
- HTTPS public service URL

## Required environment variables

- DATABASE_URL: dedicated PostgreSQL connection string for the API role
- SUPABASE_URL: existing SSPACE Supabase project URL
- SUPABASE_ANON_KEY: existing publishable/anon key; this is public by design
- FRONTEND_ORIGINS: comma-separated allowed website origins
- UPLOAD_DIR: persistent volume path, set to /data on Railway

Optional: PG_POOL_MAX, MAX_PHOTO_MB, MAX_VIDEO_MB.

Never put a database password or service_role key in VITE_* variables, source control, or browser code.

## Migration and database role

Review and apply migrations/20261123002000_profile_media_api.sql to the existing Sspace Supabase project before exposing this API. It adds profiles.is_private (default false), creates public.profile_media, enables RLS, and provisions a dedicated NOLOGIN role named sspace_profile_api with only the required column/table grants and media-table policies. It does not replace existing profiles or authentication.

After the migration, assign a unique strong password to sspace_profile_api using a secure SQL session, enable LOGIN for that role, and store its connection string only in Railway's encrypted DATABASE_URL variable. Never use the postgres admin password or a service_role key for the running API. Do not grant direct media-table access to anon or authenticated.

The current profiles table already has a public SELECT policy; the API enforces is_private before returning profiles or media. Keep the role credential private because it can read public profile fields and manage media metadata.

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

Set the service root directory to /profile-api, start command to npm start, healthcheck path to /health, and attach a persistent volume mounted at /data. Do not deploy this service on the Vercel static frontend.
