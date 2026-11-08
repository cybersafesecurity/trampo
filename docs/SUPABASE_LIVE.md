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

- **Boarding start gate.** Fixed 50 m proximity, freshness and accuracy checks
  are disabled so a matched passenger/driver can verify and start without a pending GPS
  match message. The passenger must still confirm boarding within 2 minutes, the driver
  must enter the 4-digit PIN, and the driver's shift checklist must be <12 h old.
  Night trips still require the well-lit pickup acknowledgement. (5 wrong PINs lock it.)
- **Matched-only calling.** Free WebRTC audio is offered only to the two participants of
  an `assigned`/`in_progress` trip, and ends when the trip ends. Realtime channel
  membership (`trip:<id>`) is gated by RLS on `realtime.messages`.
- **Approved drivers only.** Drivers register, stay `pending`, and must be approved in
  Operations (with a recorded document check) before going online and being matched.
- **Roles.** `passenger`, `driver` (car / motorbike), `admin`. Ordinary public signup
  creates a passenger. The single reserved owner email below may activate admin through
  normal signup **only after Supabase records email confirmation**. Client-supplied
  role metadata, lookalike addresses and Google/phone identities never grant admin.

## First admin account — choose your own password

Admin email: **trampo.the.app@gmail.com**. The old, never-used placeholder account was
removed by a guarded migration; no trips, audit events or sessions were deleted.

1. Open https://trampo.lat/ → **Create account** (or **Sign in →
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

## Email rate limits — use custom SMTP, not the test mailer

Supabase's built-in SMTP is only for testing: it sends to project team members and is
currently limited to about **2 messages/hour project-wide**. Raising the app cooldown
cannot bypass that service limit. For real signup/reset volume:

1. Choose an SMTP provider (Brevo, Resend, Postmark, SendGrid, AWS SES, or Gmail SMTP
   with an app password for small/internal use). Verify the sending domain/address and
   create SMTP credentials.
2. Open [Supabase SMTP settings](https://supabase.com/dashboard/project/euknlccrsfvuaymuecpd/auth/smtp),
   enable **Custom SMTP**, and enter host, port, username, password, sender name and
   sender email. Enter credentials only in Supabase's dashboard/secret store, never in
   Git or chat.
3. In [Auth rate limits](https://supabase.com/dashboard/project/euknlccrsfvuaymuecpd/auth/rate-limits),
   raise the email-send limit to match the provider (Supabase defaults to 30/hour after
   custom SMTP; increase gradually while watching deliverability).
4. Keep email confirmation enabled. Test signup and forgot-password with a non-team
   address, and add SPF/DKIM/DMARC records for the sending domain.

Common examples: Brevo `smtp-relay.brevo.com:587`; Resend `smtp.resend.com:465` with
username `resend`; Gmail `smtp.gmail.com:587` with a Google app password (requires
2-Step Verification and is not ideal for production volume).

## Google sign-in (live Supabase build)

The live button uses `supabase.auth.signInWithOAuth` / `linkIdentity`, not the demo
Node endpoint. It enables itself when Supabase Auth reports the Google provider on.
To turn it on:

1. In Google Cloud Console, configure the OAuth consent screen and create an OAuth
   client ID of type **Web application**.
2. Add this authorized redirect URI exactly:
   `https://euknlccrsfvuaymuecpd.supabase.co/auth/v1/callback`.
3. In [Supabase Google provider settings](https://supabase.com/dashboard/project/euknlccrsfvuaymuecpd/auth/providers),
   enable Google and paste the client ID and client secret. The secret stays in Supabase.
4. Keep the Pages URL in Auth redirect allow-list (already configured). Reload the app;
   **Continue with Google** should become available.

Google verifies email, not phone. New Google-only accounts are passengers; Google never
grants admin or driver approval. To connect Google to an existing password account, sign
in first and use **My profile → Connect Google account**; if Supabase manual identity
linking is disabled, enable it in Auth settings before linking. The reserved admin email
still activates admin only through confirmed email/password signup, not Google-only signup.

## Calling / VoIP

The live build uses direct browser-to-browser WebRTC (no per-minute charge, no
recording). Incoming calls can show browser notifications, ring, vibrate, and flash
the title after the user explicitly enables call alerts from the bell menu or incoming
call screen. Alerts are device-local and stop on answer/decline/end; they are not
closed-app push and require the Trampo page to stay open and connected. Public STUN (`stun:stun.l.google.com:19302`) is configured. For restrictive
mobile networks add a TURN relay by setting Edge Function secrets `TURN_URLS`,
`TURN_USERNAME`, `TURN_CREDENTIAL`. For scale, the recommended free self-hosted media
server is **LiveKit** (Apache-2.0) with **coturn**; see `docs/ARCHITECTURE.md` and
`deploy/`.

## Known limitations before a public Uganda launch

- **Email delivery** uses Supabase's built-in SMTP (≈2 emails/hour, team addresses only).
  The reserved admin/owner address can receive setup/reset mail; configure custom SMTP
  for public signup/reset volume and any non-team address.
- **No phone OTP** — booking requires a confirmed **email** + real GPS, not a verified phone.
- **Google sign-in** uses Supabase Auth on the live build, but the Google provider is
  disabled until an OAuth client ID/secret is added in Supabase. The button checks
  Supabase's public Auth settings and stays disabled until then.
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
  `TRAMPO_ALLOWED_ORIGINS` (including `https://trampo.lat` and `https://www.trampo.lat`).
- The `trampo` schema is private; clients can only reach it through the Edge Function.
