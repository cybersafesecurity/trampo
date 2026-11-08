# GitHub Pages — live Supabase app at trampo.lat

Trampo is deployed to GitHub Pages as a static frontend that talks **directly to
Supabase** (Auth, Postgres, Realtime, and the `trampo-api` Edge Function). There is
no demo mode and no Node server in this deployment — the browser calls your
Supabase project over HTTPS.

Production URL: **https://trampo.lat/**

## How it builds

The workflow `.github/workflows/pages.yml` runs on pushes to `main` and on demand
via **Actions → Deploy Trampo to GitHub Pages → Run workflow**. (The `github-pages`
environment only allows `main` to deploy, so changes reach Pages when merged to
`main`.) It:

1. `npm ci`
2. `npm run build:pages:live` — `vite build --mode live --base=/` into `dist/`.
   Root-path assets match the custom domain rather than the old `/trampo/` subpath.
3. Registers `public/CNAME` (`trampo.lat`) through the Pages settings API using the
   workflow's `pages: write` permission. **This API step is required:** GitHub Pages
   ignores an uploaded `CNAME` file when the publishing source is GitHub Actions.
4. Runs `node scripts/check-pages.mjs` to verify the domain file, root assets,
   installable PWA manifest/icons, offline shell, call worker, and live workflow.
5. Uploads `dist/` and deploys with `actions/deploy-pages`.

The build injects only **browser-safe public values** (set in the workflow `env`):

```text
VITE_TRAMPO_BACKEND=supabase
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…   # public, protected by RLS
```

The publishable key is safe to ship to browsers — all data access is gated by
row-level security and the Edge Function. No service-role or secret key is ever
placed in the frontend or the workflow.

## Owner steps: GitHub, DNS, and HTTPS

The repository/workflow can register the custom domain, but only the domain owner
can change DNS and verify the domain in GitHub organization settings.

1. In **Repository → Settings → Pages**, confirm the publishing source is
   **GitHub Actions** and the custom domain is `trampo.lat`. The deployment workflow
   sets this automatically; if the workflow token is restricted by organization
   policy, enter `trampo.lat` here and save.
2. Verify `trampo.lat` for the **cybersafesecurity** organization:
   **Organization → Settings → Pages → Add a domain**, then create the exact TXT
   challenge GitHub displays. Verification protects against Pages domain takeover.
3. At the DNS provider, configure the apex and `www` variant:

   | Type | Name | Value |
   | --- | --- | --- |
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | CNAME | `www` | `cybersafesecurity.github.io` |

   The `www` target is the account/organization Pages host, **not**
   `cybersafesecurity.github.io/trampo`. If the DNS provider supports apex
   `ALIAS`/`ANAME`, it may point `@` to `cybersafesecurity.github.io` instead of the
   four A records. Optional IPv6 AAAA records are listed in GitHub's Pages docs.
   Remove conflicting default apex A/AAAA records. **Keep existing MX, SPF, DKIM,
   DMARC, and other email TXT records**; web hosting does not require changing them.
4. Wait for DNS propagation (often minutes, sometimes up to 24 hours). In
   **Repository → Settings → Pages**, wait for the DNS check and certificate, then
   enable **Enforce HTTPS**. Do not treat `http://trampo.lat` as the production
   origin; GPS, notifications, and WebRTC need HTTPS.
5. If the optional Google geocoder key is referrer-restricted, add
   `https://trampo.lat/*` and `https://www.trampo.lat/*` to its browser-key
   restrictions.

## Supabase configuration for the custom domain

For auth and API calls to work from `https://trampo.lat`, the project must allow
that origin:

- **Auth → URL configuration:** site URL `https://trampo.lat/`; redirect allow-list
  includes `https://trampo.lat/**` and `https://www.trampo.lat/**`. The previous
  GitHub Pages URLs remain allowed during migration.
- **Edge Function secret `TRAMPO_ALLOWED_ORIGINS`:** includes
  `https://trampo.lat` and `https://www.trampo.lat` so CORS preflight/responses
  succeed. The previous GitHub Pages origin remains allowed during migration.

The frontend derives auth redirects from the current origin, so the same bundle
works at the custom-domain root and in local previews. The live test server also
redirects old `/trampo/` links to `/` without dropping callback query parameters.

## PWA

The deployed bundle is an installable PWA: manifest, maskable/app icons, a public
app-shell service worker, an honest offline fallback, and user-controlled updates.
Only public build files are cached; Supabase auth/trip/Realtime traffic is never
cached. See [PWA.md](PWA.md) for install steps and cache policy.

## Notes

- GitHub Pages serves over HTTPS once the certificate is issued and enforcement is
  enabled. Geolocation, the notification worker, and WebRTC calling require it.
- Email sign-up requires confirmation; password-reset and confirmation links return
  to the current origin using PKCE. The reserved admin is `trampo.the.app@gmail.com`:
  first-time signup lets the owner choose a password, and admin access activates only
  after email confirmation. The built-in mailer can send to this project-owner address
  (about two emails/hour); configure custom SMTP before inviting non-team users.
  See `docs/SUPABASE_LIVE.md` for the signup and forgot-password steps.
- To run the older browser-local demo instead, use `npm run build:pages`
  (mode `pages`) — it is kept for offline evaluation but is **not** what the
  workflow deploys.
