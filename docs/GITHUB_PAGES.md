# GitHub Pages — live Supabase app

Trampo is deployed to GitHub Pages as a static frontend that talks **directly to
Supabase** (Auth, Postgres, Realtime, and the `trampo-api` Edge Function). There is
no demo mode and no Node server in this deployment — the browser calls your
Supabase project over HTTPS.

Public URL: **https://cybersafesecurity.github.io/trampo/**

## How it builds

The workflow `.github/workflows/pages.yml` runs on pushes to `main` and on demand
via **Actions → Deploy Trampo to GitHub Pages → Run workflow**. (The `github-pages`
environment only allows `main` to deploy, so changes reach Pages when merged to
`main`.) It:

1. `npm ci`
2. `npm run build:pages:live` — `vite build --mode live --base=./` into `dist/`.
   The relative base (`./`) makes the assets load correctly under the `/trampo/`
   subpath.
3. Uploads `dist/` and deploys with `actions/deploy-pages`.

The build injects only **browser-safe public values** (set in the workflow `env`):

```text
VITE_TRAMPO_BACKEND=supabase
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   # public, protected by RLS
```

The publishable key is safe to ship to browsers — all data access is gated by
row-level security and the Edge Function. No service-role or secret key is ever
placed in the frontend or the workflow.

## Supabase configuration for the Pages origin

For auth and API calls to work from `https://cybersafesecurity.github.io`, the
project must allow that origin:

- **Auth → URL configuration:** `https://cybersafesecurity.github.io/trampo/**`
  (and the origin `/**`) in the redirect allow-list; site URL set to the Pages URL.
- **Edge Function secret `TRAMPO_ALLOWED_ORIGINS`:** includes
  `https://cybersafesecurity.github.io` so CORS preflight/responses succeed.

Both are already configured for this project. If you fork or move the deployment,
add the new origin to both places.

## Notes

- GitHub Pages serves over HTTPS, which geolocation, the service worker-less
  realtime client, and WebRTC calling all require.
- Email sign-up requires confirmation; password-reset and confirmation links
  return to the Pages URL. Configure custom SMTP before inviting real users (the
  built-in Supabase email service is heavily rate-limited).
- To run the older browser-local demo instead, use `npm run build:pages`
  (mode `pages`) — it is kept for offline evaluation but is **not** what the
  workflow deploys.
