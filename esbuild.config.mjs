import * as esbuild from 'esbuild'

/**
 * Bundles each hook and skill entry point into a self-contained JS file
 * with all dependencies (including zod) inlined. This eliminates
 * the need for end users to install node_modules.
 *
 * Output mirrors the tsc layout: dist/tom/hooks/*.js, dist/tom/skills/*.js
 */

const entryPoints = [
  // Hooks
  'tom/hooks/capture-interaction.ts',
  'tom/hooks/pre-tool-use.ts',
  'tom/hooks/stop-analyze.ts',
  // Skills
  'tom/skills/tom-status.ts',
  'tom/skills/tom-inspect.ts',
  'tom/skills/tom-reset.ts',
  'tom/skills/tom-forget-export.ts',
  'tom/skills/tom-setup.ts',
]

await esbuild.build({
  entryPoints,
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outdir: 'dist',
  outbase: '.',
  sourcemap: false,
  minify: false,
  external: ['node:fs', 'node:path', 'node:os', 'node:crypto'],
})
