# Optional Google address lookup + Leaflet live map

Trampo reads the device's GPS through the browser Geolocation API and renders the live
trip map with **Leaflet + OpenStreetMap tiles** (no API key required). The map shows the
pickup, ordered stops, final destination and latest driver location. If tiles cannot
load, it falls back to a clearly labelled illustrated overview.

With an optional Google Maps browser key configured, Trampo also reverse-geocodes the
exact device fix into an address. The geocoder only labels the point — it never replaces
the device coordinates used for dispatch or boarding.

## Enable optional address lookup

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
   `VITE_GOOGLE_MAPS_API_KEY`, then re-run the Pages workflow. `VITE_*` values are embedded
   in the public bundle; referrer and API restrictions protect a browser key. Never put
   secret/server keys here.
5. Rebuild/redeploy. Without a key the Leaflet map still works and current-location pickup
   keeps the exact GPS coordinates, with a clear notice that address lookup is unavailable.

## Failure behaviour

- Permission denied/unavailable: no pickup is invented; the rider can choose manually.
- Geocoder outage/zero results: the exact GPS coordinates remain the pickup; the UI says
  the address could not be resolved.
- OpenStreetMap tile outage: the illustrated map is labelled as a fallback.
- Location outside the Uganda service area is still rejected by the server gate.

Browser tests mock Google's geocoder and OpenStreetMap tiles to verify address resolution,
Leaflet rendering, geocoder outage fallback and tile-outage fallback without requiring a
billable key or live tile traffic. Run `npm run test:e2e:maps` (use
`TRAMPO_SANDBOX_BROWSER=true` in this sandbox).
