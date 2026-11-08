# Trampo architecture and calling design

## Request lifecycle

`requested/searching → assigned → in_progress → completed`

Alternative states are `scheduled` and `cancelled`. The server, not the frontend, owns transitions. Driver acceptance and start transitions are transactional. Partial unique SQLite indexes prevent a passenger or driver from holding multiple active trips.

A start request is accepted only when all of these hold:

1. The caller is the assigned driver and the trip is `assigned`.
2. The four-digit trip PIN matches a salted scrypt hash; attempts are limited.
3. Testing mode: GPS freshness, accuracy, Uganda bounds for the boarding match, and proximity no longer block start. Haversine separation is recorded when both fixes exist, but is not capped or required.
5. The passenger confirmed the vehicle within the previous 120 seconds; night trips also require a well-lit pickup acknowledgement.
6. The driver's shift checklist is less than 12 hours old.

The demo shortcut for passenger confirmation is unavailable outside explicitly simulated demo trips; it no longer requires a GPS match in testing mode. Production mode rejects all simulated location reports. Nevertheless, a malicious client can lie about GPS/source/accuracy; device attestation and anti-spoofing are required before launch.

## Location and map honesty

The included map is an interactive, illustrated Kampala/Uganda overview, not a road map or navigation engine. Saved place coordinates are approximate demo locations. Fares use a straight-line distance multiplier and time estimate, not live road routing, traffic, tolls, or metered distance. The UI labels these estimates.

A production map/routing provider must supply road geometry, geocoding, ETA, route deviation, and metered fare inputs. Uganda-wide service also requires real supply outside Kampala; a nationwide destination list is not evidence of nationwide driver coverage.

## Calling: implemented direct WebRTC

1. A matched participant requests `/api/trips/:id/call`. The API verifies participation and active trip state.
2. The browser asks for microphone access and creates an `RTCPeerConnection`.
3. Offer, answer, and ICE candidates travel over the authenticated `/ws` WebSocket. The server forwards signaling only to the other trip participant and validates message types and call membership.
4. Audio travels directly between browsers using WebRTC DTLS-SRTP. The application does not record it.
5. Hang-up, trip completion/cancellation, or a ringing timeout ends the call and stops local microphone tracks.

The default STUN server is configurable. Direct/local connections can work without STUN; restrictive NATs often require TURN. Supply `TURN_URLS`, `TURN_USERNAME`, and `TURN_CREDENTIAL` for a pilot. Replace static relay credentials with short-lived HMAC credentials before production. Direct peers can discover each other's network addresses; route media through a relay/SFU when that metadata must be hidden.

The browser test connects two independent contexts with synthetic microphone input and waits for actual `RTCPeerConnection` connectivity, not merely a ringing UI.

## Recommended migration: self-hosted LiveKit + coturn

LiveKit's open-source server is the recommended media layer for a scalable deployment. It is not installed or contacted by the current app. Self-hosting avoids a proprietary license fee, but infrastructure and bandwidth still cost money.

Migration steps:

1. Deploy LiveKit server using the official VM guide, with TLS, a dedicated media hostname, generated API secrets, and correctly advertised firewall ports.
2. Add `livekit-server-sdk` on the backend and `livekit-client` in the frontend.
3. Replace the direct call config endpoint with a server-issued room token. Derive room name from trip ID; include only the matched participant identities; set a short TTL; reject tokens after completion/cancellation.
4. Publish microphone tracks to the room and subscribe to the other participant. Keep the existing answer/decline/mute/hang-up UI, but use LiveKit room events for call state.
5. On trip end, revoke room access/delete the room through the server API and disconnect clients.
6. Deploy coturn for relay fallback and test Ugandan mobile carriers, symmetric NAT, packet loss, backgrounding, and low-bandwidth audio.
7. Add monitoring, abuse controls, regional capacity planning, and operational on-call ownership.

References: [2](https://docs.livekit.io/intro/about/), [1](https://docs.livekit.io/home/self-hosting/vm/), [3](https://github.com/livekit/livekit), [1](https://github.com/coturn/coturn).

The files in `deploy/` are **examples**, not a turnkey secure deployment. Generate secrets, set real hostnames, restrict firewall access, and follow current upstream documentation.

## Data and security boundaries

SQLite tables hold users, role-specific profile fields, driver/vehicle profiles, Google identity links, hashed OAuth flows, latest location fixes, trips, hashed sessions, audit events, contacts, alerts, hashed share tokens, and call metadata. Passwords use scrypt with random salts. Session and share tokens are random and stored hashed. Cookies are HttpOnly/SameSite Lax and Secure in production; Lax permits the top-level Google OAuth callback while mutations still require a custom client header and same-origin/public-origin checks. WebSocket upgrades validate the session, active account status and origin.

Google sign-in uses server-side OpenID Connect authorization code + PKCE, one-time state, nonce, JWKS signature verification, issuer/audience/expiry checks and a verified-email claim. New Google identities are passengers; roles/approval are never derived from Google claims. Existing accounts must explicitly link Google after signing in. See `docs/PROFILES_AND_GOOGLE.md`.

Only participants and operations receive identifiable trip fixes. The public share endpoint returns a limited read-only view without phone numbers or PINs. Links expire and are revoked at completion. The pre-match fleet map currently exposes online driver coordinates; production should round/jitter them and enforce a need-to-know location policy.

This is a single-process pilot architecture. Before scale, move shared state to PostgreSQL/PostGIS, dispatch/events to a durable queue, and sessions/rate limits to shared storage. Add transactional outbox events, idempotency keys, retries, observability, backups, and tested disaster recovery.
