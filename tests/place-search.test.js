import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateLabel, googleResult, inUganda, mergePlaces, parsePhoton, photonResult } from '../src/placeSearch.ts';
import { createPhotonProxy, photonRequest, validatePhotonBase } from '../server/photonProxy.js';

const feature = { geometry: { coordinates: [32.5825, .3136] }, properties: { name: 'Cafe Javas', street: 'Acacia Avenue', city: 'Kampala', countrycode: 'UG', osm_value: 'cafe' } };

test('typed destination search resolves a named place, not just a saved substring', () => {
  const places = parsePhoton({ features: [feature] }, true);
  assert.equal(places.length, 1);
  assert.equal(places[0].name, 'Cafe Javas, Kampala');
  assert.match(places[0].area, /Acacia Avenue/);
  assert.equal(places[0].provider, 'openstreetmap');
  assert.equal(places[0].lat, .3136); assert.equal(places[0].lng, 32.5825);
  assert.equal(parsePhoton({ features: [{ ...feature, properties: { ...feature.properties, countrycode: 'KE' } }] }).length, 0);
});

test('reverse geocoding labels a point without moving the exact GPS/custom coordinates', () => {
  const fixed = { lat: .335412, lng: 32.576912 };
  const place = photonResult(feature, fixed);
  assert.equal(place.lat, fixed.lat); assert.equal(place.lng, fixed.lng);
  assert.equal(place.name, 'Cafe Javas, Kampala');
  assert.equal(place.approximate, false);
  assert.equal(coordinateLabel(fixed), '0.335412, 32.576912');
  assert.equal(inUganda({ lat: 51.5, lng: -.1 }), false);
});

test('Google results keep exact fixes, reject partial matches and merge saved places without duplicates', () => {
  const result = {
    formatted_address: 'Acacia Avenue, Kampala, Uganda', partial_match: false,
    geometry: { location: { lat: () => .3136, lng: () => 32.5825 }, location_type: 'ROOFTOP' },
    address_components: [
      { long_name: 'Cafe Javas', short_name: 'Cafe Javas', types: ['establishment', 'point_of_interest'] },
      { long_name: 'Kampala', short_name: 'Kampala', types: ['locality'] },
      { long_name: 'Uganda', short_name: 'UG', types: ['country'] },
    ],
  };
  assert.equal(googleResult(result).name, 'Cafe Javas, Kampala');
  assert.equal(googleResult({ ...result, partial_match: true }), null);
  const fixed = googleResult(result, { lat: .3354, lng: 32.5769 }, 'My GPS pickup');
  assert.equal(fixed.lat, .3354); assert.equal(fixed.name, 'My GPS pickup, Cafe Javas, Kampala');
  const merged = mergePlaces([{ name: 'Cafe Javas, Kampala', area: 'Saved', lat: .3136, lng: 32.5825 }], parsePhoton({ features: [feature] }, true));
  assert.equal(merged.length, 1); assert.equal(merged[0].provider, 'saved');
});

test('Photon proxy restricts to Uganda, strips unknown/account parameters, caches and bounds concurrency', async () => {
  const request = photonRequest('https://photon.komoot.io', 'search', new URLSearchParams({ q: 'Cafe Javas', lat: '.3136', lon: '32.5825', userId: 'secret-account', apiKey: 'no' }));
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('countrycode'), 'UG');
  assert.equal(url.searchParams.get('userId'), null); assert.equal(url.searchParams.get('apiKey'), null);
  assert.throws(() => photonRequest('', 'reverse', new URLSearchParams({ lat: '51.5', lon: '-.1' })), /Uganda/);
  assert.throws(() => validatePhotonBase('http://example.com'), /configured correctly/);
  let hits = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const lookup = createPhotonProxy({ fetcher: async () => { hits++; await gate; return { ok: true, json: async () => ({ features: [feature] }) }; } });
  const query = new URLSearchParams({ q: 'Cafe Javas', lat: '.3136', lon: '32.5825' });
  const first = lookup('search', query), second = lookup('search', query);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(hits, 1);
  assert.deepEqual(await lookup('search', query), a); assert.equal(hits, 1);
});
