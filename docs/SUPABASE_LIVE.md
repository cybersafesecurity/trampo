# Trampo on Supabase (live, no demo)

This is the real, account-backed Trampo. It uses **Supabase Auth (email + password)**,
**Supabase Postgres** (private `trampo` schema), a single **Edge Function** (`trampo-api`),
**Supabase Realtime** for matched-trip call signalling, and **pg_cron** for scheduled
dispatch / Night Shield / missed check-in escalation. There are no demo accounts, no
simulated GPS, and no automatic demo dispatch in this mode.

Project: `trampo` · ref `euknlccrsfvuaymuecpd` · region `eu-west-2`.

## Run the live build

```bash
cp .env.live.example .env.live      # then fill in the two public values below
npm install
npm run build:live                  # outputs dist-live/
npm run preview:live                # serves dist-live/ on 0.0.0.0:3000
```

`.env.live` (only publishable, browser-safe values — never a service/secret key):

```
VITE_TRAMPO_BACKEND=supabase
VITE_SUPABASE_URL=https://euknlccrsfvuaymuecpd.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
```

The browser talks to Supabase directly (Auth, the Edge Function, and Realtime). The
static host only serves the built files. The Express/SQLite server (`npm run dev`) and
the GitHub Pages build remain available as a separate, clearly-labelled demo.

## What is enforced server-side

- **GPS-verified start.** A trip cannot start unless both phones report a browser GPS
  fix ≤15 s old, accuracy ≤50 m, and separation ≤35 m by day / ≤25 m at night, **and**
  the passenger confirmed boarding within 2 minutes, **and** the driver enters the
  4-digit PIN, **and** the driver's shift checklist is <12 h old. (5 wrong PINs lock it.)
- **Matched-only calling.** Free WebRTC audio is offered only to the two participants of
  an `assigned`/`in_progress` trip, and ends when the trip ends. Realtime channel
  membership (`trip:<id>`) is gated by RLS on `realtime.messages`.
- **Approved drivers only.** Drivers register, stay `pending`, and must be approved in
  Operations (with a recorded document check) before going online and accepting trips.
- **Roles.** `passenger`, `driver` (car / motorbike), `admin`. Public signup always
  creates a passenger; **admin is never grantable from signup or Google**.

## First admin account

The first admin is provisioned for **kampalanalf@gmail.com** (email already confirmed,
role `admin`). No password was set or shared. To sign in:

1. Open the live app → **Sign in** → **Forgot password?**
2. Enter `kampalanalf@gmail.com`, open the reset email, and choose a new password.
3. You land in the app as an admin; the **Operations** workspace is available.

Admins are provisioned server-side only. To add another admin later, confirm the
person's email, then set `trampo.profiles.role='admin'` and `account_type='admin'` for
that verified user id via SQL (never through the public API).

## Calling / VoIP

The live build uses direct browser-to-browser WebRTC (no per-minute charge, no
recording). Public STUN (`stun:stun.l.google.com:19302`) is configured. For restrictive
mobile networks add a TURN relay by setting Edge Function secrets `TURN_URLS`,
`TURN_USERNAME`, `TURN_CREDENTIAL`. For scale, the recommended free self-hosted media
server is **LiveKit** (Apache-2.0) with **coturn**; see `docs/ARCHITECTURE.md` and
`deploy/`.

## Known limitations before a public Uganda launch

- **Email delivery** uses Supabase's built-in SMTP (≈2 emails/hour). Configure custom
  SMTP for real signup/reset volume.
- **No phone OTP** — booking requires a confirmed **email** + real GPS, not a verified phone.
- **Google sign-in** is implemented in the demo backend but **not enabled** on this
  Supabase project (the button is honestly disabled). Email + password is the live method.
- **No document upload/KYC, no in-app payments, no external emergency dispatch.** SOS
  records an alert to Trampo Operations only. Driver "approval" is an operational
  document check, not automated verification.
- **No TURN relay is configured yet**, so calls may fail on symmetric-NAT carrier
  networks until one is added.
- Maps are illustrative; fares are estimates, not road-metered. See
  `docs/PRODUCTION_CHECKLIST.md`.

## Backend layout

- `supabase/migrations/` — schema, logic, dispatch, scheduler, GPS fix (applied in order).
- `supabase/functions/trampo-api/index.ts` — the deployed Edge Function. It verifies the
  caller's Supabase JWT (except `/health`, `/config`, `/shared/*`), then calls the
  service-role-only `public.trampo_dispatch` RPC. CORS is restricted to
  `TRAMPO_ALLOWED_ORIGINS`.
- The `trampo` schema is private; clients can only reach it through the Edge Function.
