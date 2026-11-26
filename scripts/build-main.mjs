import esbuild from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

const watch = process.argv.includes('--watch');

const targets = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => esbuild.context({ ...shared, ...t })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[build-main] watching main + preload');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...shared, ...t })));
  console.log('[build-main] built main + preload');
}
