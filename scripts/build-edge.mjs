// Bundle the single-file Supabase Edge Function with shared, unit-tested helpers.
// The npm: import stays external for Deno. Output is a deploy artifact, not source.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
mkdirSync('.edge-build', { recursive: true });
await build({
  entryPoints: ['supabase/functions/trampo-api/index.ts'],
  outfile: '.edge-build/trampo-api.js',
  bundle: true, write: true, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['npm:*'], legalComments: 'none', sourcemap: false,
});
console.log('Edge bundle ready: .edge-build/trampo-api.js');
