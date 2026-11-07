# GitHub Pages deployment

GitHub Pages hosts static files only. It cannot run Trampo's Node/SQLite API, WebSocket signaling, server-enforced GPS gate, or real WebRTC call setup. This repository therefore includes a **browser-only Pages demo** built with `npm run build:pages`.

## What the Pages site includes

- The full Trampo responsive UI: booking, VIP, safety centre, driver hub, operations, activity, and shared-trip view.
- A localStorage-backed demo state: simulated fleet, trip requests, GPS/PIN demo flow, driver registration/review, contacts, alerts, ratings, and receipts.
- Role-specific profile pages and local demo profile editing for admins, car drivers, motorbike riders and passengers.
- Clear labelling that the site is a static demo. Calling buttons explain that live calling requires the full backend. Google sign-in is disabled on Pages because secure OAuth needs the Node backend and a protected client secret.
- Hash-based share links that work in the same browser profile where they were created. They are not public cross-device tracking links.

## Deploy

1. Push this repository to GitHub.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. The included workflow `.github/workflows/pages.yml` builds `dist` with `npm run build:pages` and deploys it.
4. For a project repository named `trampo`, the expected URL is `https://<owner>.github.io/trampo/`.

The workflow triggers on pushes to `main` and the current Arena working branch, and can also be run manually from the Actions tab.

If the repository is private, GitHub Pages availability depends on the account/organization plan. Making the repository public is a visibility decision and should be done deliberately by the owner.

## Local static preview

```bash
npm run build:pages
npm run preview:pages
```

Open the printed local URL. The build uses a relative base path so it can be served from a repository subpath.

## Full application

For real backend behavior, run `npm run dev` or deploy the Node server separately. The Pages site is a showcase/demo, not the production ride-hailing service.
