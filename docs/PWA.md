# Trampo PWA

Trampo is an installable Progressive Web App. The production deployment at
`https://trampo.lat/` can be added to an Android, iOS, Windows, macOS, or Linux
home screen / app launcher and opens in a standalone Trampo window.

This is a PWA, not an Android APK. It does not require Play Store publishing or a
signing keystore. A Trusted Web Activity APK can be added later if store-style
Android distribution is needed.

## What is included

- `manifest.webmanifest` generated for the deployed base path, with Trampo name,
  standalone display, theme/background colors, start URL, scope, and app shortcuts.
- Raster icons generated from the existing Trampo mark:
  - `icons/icon-192.png` and `icons/icon-512.png` for install prompts;
  - `icons/maskable-512.png` for Android adaptive/maskable icons;
  - `icons/apple-touch-icon.png` for iOS Add to Home Screen;
  - `icons/badge-96.png` for notification badges.
- A single service worker (`sw.js`) that handles both the public app shell and
  incoming-call notification focus. `call-sw.js` remains as a compatibility entry
  that delegates to `sw.js` for older registrations.
- An in-app install entry point on the sign-in screen and top bar, plus a
  **Trampo on your device** card in My profile.
- An honest offline fallback (`offline.html`) and online/offline banners.
- User-controlled updates: a new worker waits until the user chooses
  **Update and restart**. Updates are not forced during an active trip or call.

## What is cached — and what is never cached

The worker precaches only public, same-origin build files: the HTML shell,
hashed JavaScript/CSS, self-hosted fonts, icons, and the offline fallback.

It does **not** cache:

- Supabase Auth, REST, Realtime, or Edge Function traffic;
- `/api`, `/auth`, `/functions`, `/rest`, `/realtime`, or `/share` routes;
- URLs containing one-time credentials such as `code`, `token`, `access_token`,
  `refresh_token`, `token_hash`, or auth error parameters;
- map tiles, driver locations, boarding PINs, trip statuses, or profile data.

Navigation is network-first. If the network is unavailable, Trampo shows the
offline screen instead of a stale trip workspace. Signing in, booking, live trip
updates, maps, and WebRTC calling require a connection. Installing the PWA does
not enable closed-app push notifications; keep Trampo open and connected for
incoming-call alerts.

## Install

### Android / Chrome

1. Open `https://trampo.lat/` in Chrome.
2. Tap the in-app **Install Trampo app** button, or Chrome menu ⋮ → **Install app**
   / **Add to Home screen**.
3. Launch Trampo from the home screen or app drawer.

### iPhone / iPad

1. Open `https://trampo.lat/` in Safari.
2. Tap **Share** → **Add to Home Screen**.
3. Launch Trampo from the home screen.

### Desktop Chrome / Edge

Use the install icon in the address bar, the in-app install button, or the browser
menu → **Install Trampo**.

Installation requires HTTPS. Localhost is treated as secure for development, but
the Vite dev server intentionally uses the notification-only worker so hot reload
is not trapped behind an app-shell cache.

## Build and verification

```bash
npm run icons:generate   # regenerate PNG icons after changing public/favicon.svg
npm run build:live       # live Supabase bundle + PWA artifacts in dist-live/
npm run build:pages:live # production Pages bundle + PWA artifacts in dist/
npm run test:pages       # artifact checks: CNAME, root assets, manifest, icons, worker
npm run test:e2e:live    # includes e2e-live/pwa.spec.js
```

`scripts/finalize-pwa.mjs` runs after Vite. It bundles `src/service-worker.ts`,
injects a content-hashed precache list, writes the base-aware manifest, and emits
`pwa-version.json`. The GitHub Pages workflow deploys the resulting `dist/`.

## Update behavior

1. A new deployment changes the hashed build files and `sw.js`.
2. The browser installs the new worker in the background and precaches the new
   public shell.
3. Trampo shows **A Trampo update is ready**.
4. The user chooses **Update and restart** when safe. The new worker activates,
   old Trampo caches are removed, and the window reloads once.

If a trip or call is active, the update banner asks the user to finish first.
