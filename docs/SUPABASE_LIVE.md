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
static host only serves the built files. GitHub Pages hosts this live build; the
Express/SQLite server (`npm run dev`) remains a separate, clearly-labelled demo.

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
- **Roles.** `passenger`, `driver` (car / motorbike), `admin`. Ordinary public signup
  creates a passenger. The single reserved owner email below may activate admin through
  normal signup **only after Supabase records email confirmation**. Client-supplied
  role metadata, lookalike addresses and Google/phone identities never grant admin.

## First admin account — choose your own password

Admin email: **trampo.the.app@gmail.com**. The old, never-used placeholder account was
removed by a guarded migration; no trips, audit events or sessions were deleted.

1. Open https://cybersafesecurity.github.io/trampo/ → **Create account** (or **Sign in →
   First time here? Set up admin account**).
2. Use `trampo.the.app@gmail.com`, enter your name, and choose your own password
   (10–128 characters) in the password and confirmation fields. No default password exists.
3. Open the newest confirmation email **in the same browser** and confirm the address.
   The database trigger then activates `admin` / `admin` and the **Operations** workspace.
4. Sign in with the password you chose if the confirmation callback does not leave you
   signed in already.

The reservation lives in the private `trampo.admin_emails` table. The frontend constant
is only a UX hint; changing it cannot grant privileges. To add another admin later,
use a server-side migration to reserve their exact email (or provision a verified user
directly). Never accept a role from signup metadata or the public API.

## Forgot password

On **Sign in**, enter the admin email and select **Forgot password?**. Supabase sends a
PKCE reset link back to the Pages URL. Open the newest email in the same browser, choose
a new password and confirm it, then select **Save new password**. The app handles the
`PASSWORD_RECOVERY` callback, validates both fields, saves through Supabase Auth, and
reloads the verified profile. Expired/reused links and mail-quota errors show actionable
messages instead of a false success notice.

`trampo.the.app@gmail.com` is the Supabase organization owner, so it is authorized to
receive messages from the built-in test mailer. That mailer allows only about **two
messages per hour** and only to project team members. Check inbox/spam before retrying.
For passenger/driver emails outside the team, configure custom SMTP in
[Supabase SMTP settings](https://supabase.com/dashboard/project/euknlccrsfvuaymuecpd/auth/smtp)
before launch. Enter SMTP credentials only in Supabase's dashboard, never in source code
or chat. Gmail SMTP, if used, requires an app password and 2-Step Verification.

## Calling / VoIP

The live build uses direct browser-to-browser WebRTC (no per-minute charge, no
recording). Public STUN (`stun:stun.l.google.com:19302`) is configured. For restrictive
mobile networks add a TURN relay by setting Edge Function secrets `TURN_URLS`,
`TURN_USERNAME`, `TURN_CREDENTIAL`. For scale, the recommended free self-hosted media
server is **LiveKit** (Apache-2.0) with **coturn**; see `docs/ARCHITECTURE.md` and
`deploy/`.

## Known limitations before a public Uganda launch

- **Email delivery** uses Supabase's built-in SMTP (≈2 emails/hour, team addresses only).
  The reserved admin/owner address can receive setup/reset mail; configure custom SMTP
  for public signup/reset volume and any non-team address.
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
