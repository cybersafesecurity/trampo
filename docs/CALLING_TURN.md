# Private calling and TURN relay configuration

Trampo calls are matched-passenger/driver WebRTC audio. STUN alone is not enough on
many mobile/carrier networks; a TURN relay is required for reliable audio when direct
peer-to-peer paths fail. The UI only shows **Connected** after the peer connection is
connected and remote audio RTP is flowing. A database `answered` row is not audio proof.

## Secrets stay on the server

Never put relay credentials in `VITE_*` variables, source code, chat, or client logs.
Configure them in Supabase Edge Function secrets (or the Node server environment).
If a credential is pasted into chat or committed accidentally, rotate it at the provider
and update the server secret.

## Preferred: Metered expiring credentials

Set these server-side secrets:

```dotenv
METERED_APP=your-app.metered.live
METERED_SECRET_KEY=your-metered-secret-key
```

The backend creates a credential with `expiryInSeconds=14400`, fetches the ICE servers,
and caches them in the private `trampo.relay_cache` table. Metered documents up to two
minutes of propagation, so a newly issued credential is not handed out as a working
relay until it has aged past that window. The cache rotates before expiry and keeps a
margin so an in-progress call is not cut off by credential expiry.

The Metered account secret key never leaves the backend. The browser receives only
short-lived, credential-scoped TURN username/password values. Metered may charge for relay usage;
monitor quota and billing in the Metered dashboard.

## Static TURN fallback

You can also configure a static relay (Metered static auth or another TURN provider):

```dotenv
TURN_URLS=turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp
TURN_USERNAME=server-side-username
TURN_CREDENTIAL=server-side-password
```

Only authenticated `turn:`/`turns:` entries are accepted. A static TURN password is
stored server-side but must be delivered to authenticated matched participants as a
WebRTC ICE credential; use a dedicated relay account, not a shared administrator
password. If both Metered and static
TURN are configured, Trampo includes the static fallback while Metered credentials are
warming or unavailable. If no relay is available, the call screen warns that only direct
connectivity is being attempted.

## Supabase deployment

1. Apply the additive migration `20261109153206_trampo_call_relay_place_rate.sql`.
2. Set the secrets in Supabase, not in the frontend.
3. Build the single-file Edge bundle: `npm run build:edge`.
4. Deploy `.edge-build/trampo-api.js` as the `trampo-api` Edge Function.
5. Verify `/trips/:id/call/config` returns `iceServers` containing a TURN entry for an
   authenticated matched trip. Then test two real devices on different networks.

## What is and is not verified

Automated tests verify signaling acknowledgement, reordering/loss recovery, media-state
truthfulness, playback recovery, timeout cleanup, and relay-cache rules. They do not
prove that a particular carrier NAT can allocate the configured relay. Before launch,
test passenger/driver calls on Wi-Fi and mobile data, with one side behind a restrictive
NAT, and confirm relay usage in the provider dashboard.
