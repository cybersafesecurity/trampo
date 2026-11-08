# Google Maps and current-location pickup

Trampo reads the device's GPS through the browser Geolocation API. With a Google Maps
browser key configured, it reverse-geocodes that exact fix into an address and shows the
pickup, destination, nearby drivers and matched driver on Google Maps. The geocoder only
labels the point — it never replaces the device coordinates used for dispatch or boarding.

## Enable it

1. In Google Cloud, enable **Maps JavaScript API** and **Geocoding API** on a billing-enabled
   project.
2. Create a **browser API key**. Restrict it by HTTP referrer to
   `https://cybersafesecurity.github.io/trampo/*` (and your own preview origin if needed),
   and restrict it to those two APIs. Do not use a service-account key or OAuth client secret.
3. For local live builds, put the key in `.env.live` (ignored by git):

   ```dotenv
   VITE_GOOGLE_MAPS_API_KEY=your-public-browser-key
   ```

4. For GitHub Pages, add a repository **Actions variable** named
   `VITE_GOOGLE_MAPS_API_KEY` (Settings → Secrets and variables → Actions → Variables), then
   re-run the Pages workflow. `VITE_*` values are embedded in the public bundle; the referrer
   and API restrictions are what protect a browser key. Never put secret/server keys here.
5. Rebuild/redeploy. The map footer says **© Google · Map data ©<year> Google** when Google
   Maps loads, and **Google Maps unavailable · illustrated fallback** if loading/authentication
   fails. Without a key the original SVG map remains available and current-location pickup
   keeps the exact GPS coordinates, with a clear notice that address lookup needs Maps.

## Failure behaviour

- Permission denied/unavailable: no pickup is invented; the rider can choose manually.
- Geocoder outage/zero results: the exact GPS coordinates remain the pickup; the UI says
  the address could not be resolved.
- Maps script/authentication failure: the illustrated map is labelled as a fallback.
- Location outside the Uganda service area is still rejected by the existing server gate.

Browser tests mock Google's script and geocoder to verify address resolution, marker
placement, outage fallback and rejected-key fallback without requiring a billable key.

Run the non-billable browser regression suite with `npm run test:e2e:maps` (use
`TRAMPO_SANDBOX_BROWSER=true` in this sandbox). It builds with a test-only key and
intercepts Google network traffic; no real Maps request is made.
