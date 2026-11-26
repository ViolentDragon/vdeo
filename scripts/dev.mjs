import { createServer } from 'vite';
import esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
};

let child = null;
let stopping = false;

function launchElectron(devUrl) {
  if (child) {
    const dying = child;
    child = null;
    try {
      dying.kill();
    } catch {
      /* already gone */
    }
  }
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ELECTRON_ENABLE_LOGGING: '1',
      VITE_DEV_SERVER_URL: devUrl,
    },
  });
  child.on('exit', (code) => {
    child = null;
    if (!stopping) {
      stopping = true;
      void server.close().then(() => process.exit(code ?? 0));
    }
  });
}

const server = await createServer({ mode: 'development' });
await server.listen();
const devUrl = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5273/';
server.printUrls();

let firstBuild = true;
const restartPlugin = {
  name: 'restart-electron',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error('[dev] build failed, keep previous process');
        return;
      }
      if (firstBuild) {
        firstBuild = false;
        launchElectron(devUrl);
      } else if (!stopping) {
        console.log('[dev] main changed → restarting electron');
        launchElectron(devUrl);
      }
    });
  },
};

const ctxs = await Promise.all(
  [
    { entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js' },
    { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js' },
  ].map((t) => esbuild.context({ ...shared, ...t, plugins: [restartPlugin] })),
);
await Promise.all(ctxs.map((c) => c.watch()));
console.log('[dev] watching main + preload');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill();
    void server.close().finally(() => process.exit(0));
  });
}
