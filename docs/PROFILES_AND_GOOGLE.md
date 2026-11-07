# User profiles and Google sign-in

## Profile types

Trampo now has a **My profile** page for every account:

| Profile type | Internal authorization role | Profile features |
|---|---|---|
| Admin | `admin` | Staff title/department, head-office details, user directory, account suspension/reactivation, partner review and safety operations |
| Car driver | `driver` + `accountType=car_driver` | Comfort/VIP vehicle class, plate, model, colour, permit/insurance references, operating district, approval status |
| Motorbike rider | `driver` + `accountType=motorbike_rider` | Boda vehicle class, bike details, helmet/shift safety flow, operating district, approval status |
| Passenger | `passenger` | Contact details, city, preferred ride, pickup-assistance note, trip and safety tools |

The internal `driver` authorization role is intentionally shared by car drivers and motorbike riders so existing dispatch, GPS/PIN start gates, calling and shift checks remain enforced. `accountType` distinguishes the product/profile experience.

Profile data is stored in SQLite. The legacy database is migrated in place on startup: existing user IDs, password hashes, trips and sessions are preserved; the phone column becomes nullable for new Google-only accounts. Back up the database before deploying any migration.

### Editing and review rules

- Users can edit their own name, Uganda mobile number, city, bio and role-appropriate fields.
- Phone numbers remain unique. Changing a phone clears production phone verification.
- Email is read-only and is marked verified only through Google.
- Drivers/riders can edit registered vehicle details, but any change to class, plate, model, colour, permit or insurance reference sets the partner back to `pending`, takes them offline, and clears the shift checklist. Operations must review again.
- Vehicle details cannot be changed during an active trip.
- Admins can search/view profiles and suspend/reactivate non-admin accounts with an audit reason. Suspension revokes sessions and takes a partner offline; it is blocked during an active trip. Admin privileges are provisioned on the server, not granted through the profile UI.

## Google sign-in implementation

The app uses Google OpenID Connect with a **server-side authorization-code flow**, PKCE, a one-time random `state` cookie/database record, and a nonce checked against the verified ID token. The backend verifies the token signature via Google's JWKS, issuer, audience, expiry and verified-email claim. The client secret never reaches browser code.

- New Google identities create **passenger** accounts only.
- Google claims never grant admin, driver or rider privileges.
- Accounts are not silently merged by email. To connect Google to an existing password account, sign in first and use **My profile → Connect Google account**.
- A Google account cannot be linked to two Trampo accounts.
- Google verifies email, not the Uganda phone number. New Google users must add a phone in My profile; production booking still requires the separate phone-verification step.
- OAuth flows expire after 10 minutes and are consumed atomically to prevent replay.
- Session cookies are HttpOnly, Secure in production, and SameSite=Lax so the top-level OAuth callback works. Mutations still require the custom client header and same-origin/public-origin checks.

## Configure Google OAuth

1. In Google Cloud Console, create/select a project and configure the OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**.
3. Add an authorized redirect URI exactly matching your deployment:
   - Local: `http://localhost:3000/api/auth/google/callback`
   - Production: `https://your-domain.example/api/auth/google/callback`
   - Arena preview: `https://<preview-host>/api/auth/google/callback` and set `PUBLIC_ORIGIN` to that exact HTTPS origin.
4. Copy `.env.example` to `.env` and set:

```dotenv
PUBLIC_ORIGIN=https://your-domain.example
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-server-side-secret
# Optional; otherwise derived from PUBLIC_ORIGIN:
GOOGLE_REDIRECT_URI=https://your-domain.example/api/auth/google/callback
```

5. Restart with `npm run dev` or `npm start`. The dev/start scripts load `.env` when present. Keep `.env` out of Git; use a secret manager in production.
6. The **Continue with Google** button becomes available only when `/api/config` reports `googleSignIn: true`.

Without credentials the button is disabled and explains that server configuration is required. The app does not fake a Google login.

## GitHub Pages / hosting note

The older **static demo** build cannot run the Node OAuth callback, so Google sign-in is
disabled there. The current **live GitHub Pages build** is different: it talks directly to
Supabase Auth, and Google sign-in uses Supabase's hosted OAuth callback. See
`docs/SUPABASE_LIVE.md` for the live Google provider setup. The Node/SQLite instructions
above apply to the separate demo backend.

## Tests

`npm test` covers profile migration, all four profile types, validation/authorization, vehicle re-review, suspension, Google account creation/linking, nonce/state replay protection, no automatic email merge, no privilege elevation, and HTTPS/disabled configuration.

`npm run test:e2e` covers profile persistence, role-specific workspaces, the admin directory, mobile layout, and the existing GPS/PIN/calling flows.
