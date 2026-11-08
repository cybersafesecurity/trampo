// Rasterize the existing Trampo mark into PWA / iOS / notification icons.
// Run manually after changing public/favicon.svg: npm run icons:generate
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'public/favicon.svg');
const out = path.join(root, 'public/icons');
await fs.mkdir(out, { recursive: true });
const svg = await fs.readFile(source);

await sharp(svg).resize(192, 192).png().toFile(path.join(out, 'icon-192.png'));
await sharp(svg).resize(512, 512).png().toFile(path.join(out, 'icon-512.png'));
await sharp(svg).resize(180, 180).flatten({ background: '#120817' }).png().toFile(path.join(out, 'apple-touch-icon.png'));

// Maskable icons need a full-bleed background and the mark inside the safe zone.
const mark = await sharp(svg).resize(384, 384).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#120817' } })
  .composite([{ input: mark, gravity: 'centre' }])
  .png().toFile(path.join(out, 'maskable-512.png'));

// Android notification badges should be a white silhouette on transparency.
const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <path d="M14 16h36v11H37.5v23h-11V27H14z" fill="#fff"/>
  <circle cx="47" cy="45" r="6" fill="#fff"/>
</svg>`;
await sharp(Buffer.from(badgeSvg)).resize(96, 96).png().toFile(path.join(out, 'badge-96.png'));
console.log('Generated PWA icons in public/icons/');
