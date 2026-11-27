import { app, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startBrowserServer } from './browser-server';
import { createRepository } from './db';
import { encryptSecret, secretProtectionLevel } from './sources/secrets';

// Chromium's runtime files are separate. Storage sources share the desktop database.
const dataHome = app.getPath('appData');
const desktopData = join(dataHome, 'Nebula');
const browserData = join(dataHome, 'Nebula Browser');
mkdirSync(browserData, { recursive: true });
app.setPath('userData', browserData);

app.whenReady().then(async () => {
  mkdirSync(desktopData, { recursive: true });
  const repo = createRepository(join(desktopData, 'nebula.db'));
  app.once('will-quit', () => repo.close());
  const encrypt = (secret: string) => {
    const encrypted = encryptSecret(secret);
    if (secretProtectionLevel(encrypted) !== 'strong') throw new Error('无法使用系统凭据加密保存授权');
    return encrypted;
  };
  const { server, url } = await startBrowserServer(repo, join(__dirname, 'nebula-browser'), encrypt);
  app.once('before-quit', () => server.close());
  process.stdout.write(`浏览器版已启动：${url}\n`);
  if (process.env['BROWSER'] !== 'none') await shell.openExternal(url).catch(() => undefined);
}).catch((error: unknown) => {
  process.stderr.write(`浏览器版启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
