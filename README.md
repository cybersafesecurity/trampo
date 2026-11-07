# Trampo — Your city. Your ride.

An Uganda-first, responsive ride-hailing application with a working Node/SQLite backend, React interface, GPS-verified trip starts, matched-only browser audio calling, role-specific profiles for admins/car drivers/motorbike riders/passengers, Google sign-in, driver onboarding, operations review, VIP selection, and Night Shield safety tools.

**Head office:** Plot 14 Martyrs Drive, Ntinda Ministers Village, Kampala, Uganda.

> **Interactive prototype, not a licensed transport or emergency service.** The default fleet is simulated. No real ride, payment, background check, SMS, or emergency responder is dispatched. Browser GPS and peer-to-peer audio are real when permissions, HTTPS, and network conditions allow.

## Run locally

Requires **Node.js 22.13+** (the built-in `node:sqlite` module is experimental on Node 22) and npm.

```bash
npm install
npm run dev
```

Open **http://localhost:3000**. The server binds to `0.0.0.0` for the Arena live preview. The first visitor in a fresh browser session enters the labelled passenger demo. Use the account menu or the **Open driver controls** button inside a demo trip to explore other roles.

### Production-style static build

```bash
npm run build
DEMO_MODE=false NODE_ENV=production PUBLIC_ORIGIN=https://your-domain.example npm start
```

This serves the built frontend and API from one origin. It deliberately disables demo accounts, simulated GPS, and unverified-phone login. **Do not launch commercially yet:** see [the production checklist](docs/PRODUCTION_CHECKLIST.md). Use HTTPS and a persistent database volume. Configure the exact public origin behind a reverse proxy.

## Profiles & Google sign-in

Open **My profile** from the sidebar or avatar. Admins get staff details and a user directory; car drivers and motorbike riders get vehicle/partner profiles; passengers get ride preferences. Vehicle changes require operations re-review. Google sign-in uses a secure server-side OAuth flow and creates passenger accounts only.

To enable Google, copy `.env.example` to `.env`, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `PUBLIC_ORIGIN`, then register `<origin>/api/auth/google/callback` as the Google Web OAuth redirect URI. Restart the server. Without credentials the button is honestly disabled. See [docs/PROFILES_AND_GOOGLE.md](docs/PROFILES_AND_GOOGLE.md).

## GitHub Pages

A static GitHub Pages build is included: `npm run build:pages`, then `npm run preview:pages`. The workflow in `.github/workflows/pages.yml` deploys that build when Pages is set to **GitHub Actions** in repository settings. The Pages version is a browser-only demo with localStorage state; it cannot run the Node/SQLite backend, server-enforced GPS gate, WebSocket signaling, or real calls. See [docs/GITHUB_PAGES.md](docs/GITHUB_PAGES.md).

## Take the demo for a ride

1. Choose **Garden City**, or search for a saved Uganda destination. You can also enter exact coordinates.
2. Select **Boda**, **Comfort**, or **VIP**, then request the ride.
3. A seed demo passenger is matched to a simulated driver. Expand **Demo controls** and choose **Simulate driver arrival**.
4. Confirm **I’m in the right vehicle** in the passenger app. At night, also confirm a well-lit pickup point.
5. Choose **Open driver controls**. The simulated driver's demo PIN is explicitly shown; enter it and choose **Verify & start trip**.
6. The server independently checks both GPS fixes, passenger confirmation, the PIN, and the driver's shift checklist before changing the trip state.
7. Try the free call, share a read-only trip link, or record a demo SOS alert.
8. In driver controls, simulate arrival at the destination and complete the trip. Return to the passenger account to view the receipt and rate the journey.

**New passenger accounts do not auto-dispatch to demo drivers.** Register a real driver profile, approve it in Operations, complete its checklist, enable device GPS, go online, and accept a matching request. This supports a genuine two-device GPS test.

## What works

- Responsive passenger, driver, and operations workspaces; mobile navigation.
- Boda, Comfort, and VIP ride selection; saved Uganda destinations and custom coordinates.
- Immediate requests and scheduled requests (15 minutes to 30 days ahead), trip history, cancellation before start, receipts, and ratings.
- Server-authoritative trip state and transactional driver acceptance; one active trip per participant.
- **Start gate:** both location fixes must be ≤15 seconds old, accuracy ≤50 m, and separation ≤35 m by day / ≤25 m at night. The passenger must confirm boarding within two minutes, and the driver must supply the trip PIN. Five incorrect PIN attempts lock the start attempt.
- **Private calling:** real WebRTC audio, microphone permission, mute, answer/decline/hang-up, and WebSocket signaling. Only the matched passenger and driver can initiate or join; calls end when the trip ends. Phone numbers are not exchanged by the calling UI. Audio is not recorded.
- Driver registration with vehicle, permit, and insurance references; pending review; operations approval/rejection; shift checklist; online/offline state; device GPS watch.
- **Night Shield:** 19:00–06:00 East Africa Time, tighter GPS threshold, well-lit pickup confirmation, five-minute safety check-ins, and operations escalation two minutes after a missed check-in.
- Trusted contacts, expiring/revocable read-only trip links, SOS alert recording, operations resolution notes, and trip audit events.
- VIP service presentation and booking flow, including scheduled airport/business journeys.
- Persistent SQLite accounts, hashed passwords, hashed session tokens, HttpOnly/SameSite cookies, origin/header checks, input validation, rate limits, and role/participant authorization.

## Free VoIP recommendation

**Recommended for scale: self-hosted [LiveKit](https://github.com/livekit/livekit), paired with [coturn](https://github.com/coturn/coturn).** LiveKit provides an open-source WebRTC media server and self-hosting path; its server is Apache-2.0 licensed. coturn is a free open-source TURN/STUN relay implementation. [2](https://docs.livekit.io/intro/about/) [1](https://docs.livekit.io/home/self-hosting/vm/) [1](https://github.com/coturn/coturn)

**What this repository actually implements:** direct browser-to-browser WebRTC audio, with Trampo's own authenticated WebSocket server for signaling. It does not require a paid calling API and does not secretly depend on LiveKit Cloud. Optional public STUN and operator-supplied TURN settings are supported.

“Free” means no proprietary server license or per-minute calling charge in this implementation. **Hosting, bandwidth, TURN relay traffic, domain/TLS operation, and support are not free.** Normal internet data charges still apply. A free-tier VM can host a small pilot if its provider terms permit it, but capacity and reliability must be tested.

For restrictive mobile networks, deploy coturn with short-lived credentials. For a larger fleet, replace the direct-peer media path with a self-hosted LiveKit SFU and server-issued room tokens restricted to the active trip. See [architecture](docs/ARCHITECTURE.md) and `deploy/` examples.

## Safety positioning

SafeBoda already publicly describes live location sharing, SOS, helmet prompts, and 24/7 support. [1](https://www.safeboda.com/safeboda-blog/safeboda-safety-features-ranked-among-driver-and-customer-favorites) Trampo does **not** claim those are missing from SafeBoda or that its own features are proven competitor exclusives. Its proposed differentiators are the combined server-enforced GPS/PIN/boarding gate, privacy-first matched calling, and the Night Shield check-in workflow.

GPS reported by a client can be spoofed. A proximity check is not proof of identity or a guarantee of safety. SOS currently records an internal alert only; it is not connected to police, ambulance services, or a staffed response centre.

## Tests

```bash
npm test                 # Domain + API integration tests, isolated in-memory databases
npm run check            # TypeScript
npm run build            # Production frontend build
npx playwright install chromium
npm run test:e2e         # Full ride, mobile safety, registration, real two-browser audio
```

In the restricted Arena sandbox, the browser suite can use the npm-distributed Chromium instead of the blocked Playwright CDN:

```bash
TRAMPO_SANDBOX_BROWSER=true npm run test:e2e
```

The browser suite starts its own isolated server on port 3002 and uses synthetic microphone input. It does not alter the live preview database.

## Repository map

```text
server/                 Express API, SQLite persistence, trip state, GPS rules, WebRTC signaling
src/                    React app, responsive design, passenger/driver/operations views
public/                 Local brand and VIP image assets
tests/                  Node domain and API integration tests
e2e/                    Playwright browser flows
deploy/                 Example LiveKit and coturn configurations (not deployed)
docs/                   Architecture, calling migration, and production launch checklist
```

Runtime SQLite files, environment secrets, browser reports, and build output are ignored by Git. The VIP photograph is AI-generated editorial artwork, not a photograph of an actual operating Trampo vehicle.
