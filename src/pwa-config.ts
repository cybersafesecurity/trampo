/** Browser-safe PWA identity. Relative URLs also work on the legacy project-page path. */
export function pwaManifest(base = '/') {
  const relative = base.startsWith('.');
  const root = new URL(base, 'https://trampo.invalid');
  const url = (path: string) => {
    if (relative) {
      if (path.startsWith('#')) return `./${path}`;
      return path.replace(/^\//, '') || './';
    }
    const resolved = new URL(path.replace(/^\//, ''), root);
    return `${resolved.pathname}${resolved.hash}`;
  };
  return {
    id: url(''),
    name: 'Trampo — Your city. Your ride.',
    short_name: 'Trampo',
    description: 'GPS-verified boda, car and VIP journeys, made for Uganda.',
    lang: 'en-UG',
    dir: 'ltr',
    categories: ['travel', 'transportation'],
    start_url: url(''),
    scope: url(''),
    display: 'standalone',
    background_color: '#120817',
    theme_color: '#2c001e',
    icons: [
      { src: url('icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: url('icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: url('icons/maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Book a ride', short_name: 'Book', url: url('#ride'), icons: [{ src: url('icons/icon-192.png'), sizes: '192x192' }] },
      { name: 'My trips', short_name: 'Trips', url: url('#activity'), icons: [{ src: url('icons/icon-192.png'), sizes: '192x192' }] },
      { name: 'Safety centre', short_name: 'Safety', url: url('#safety'), icons: [{ src: url('icons/icon-192.png'), sizes: '192x192' }] },
    ],
  };
}
