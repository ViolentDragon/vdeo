/**
 * 把 mpv 内置进安装包。
 *
 * 用法：node scripts/vendor-mpv.mjs [--force]
 *
 * 做了什么：
 *   1. 查 shinchiro/mpv-winbuild-cmake 的最新 release（Windows x86_64 官方性质构建）
 *   2. 挑标准 x86_64 包（排除 -v3 需要 AVX2、dev/debug 变体）
 *   3. 下载 .7z 到 vendor/downloads/（缓存，已存在则跳过）
 *   4. 用 electron-builder 缓存里的 7za 解压到 vendor/mpv/
 *   5. 校验 mpv.exe 并打印版本
 *
 * 产出由 electron-builder 的 extraResources 复制到 resources/mpv/，
 * 运行时由 src/main/player/locate.ts 优先探测。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VENDOR = join(ROOT, 'vendor');
const DOWNLOADS = join(VENDOR, 'downloads');
const TARGET = join(VENDOR, 'mpv');
const FORCE = process.argv.includes('--force');

const RELEASES_API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';

function find7za() {
  const candidates = [
    process.env['NEBULA_7ZA'],
    join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ].filter(Boolean);

  // electron-builder 会把自己下载的 7zip 放在 LocalAppData 缓存里
  const cacheRoot = process.env['LOCALAPPDATA']
    ? join(process.env['LOCALAPPDATA'], 'electron-builder', 'Cache')
    : null;
  if (cacheRoot && existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      if (!entry.startsWith('7zip')) continue;
      const binDir = join(cacheRoot, entry);
      for (const sub of readdirSync(binDir)) {
        const p = join(binDir, sub, 'bin', '7za.exe');
        if (existsSync(p)) candidates.push(p);
      }
    }
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    '找不到 7za.exe。先跑一次 `npm run pack:dir`（electron-builder 会下载 7zip 到缓存），' +
      '或用环境变量 NEBULA_7ZA 指定 7za.exe 的路径。',
  );
}

async function pickAsset() {
  const res = await fetch(RELEASES_API, { headers: { 'User-Agent': 'nebula-media' } });
  if (!res.ok) throw new Error(`查询 release 失败：HTTP ${res.status}`);
  const data = await res.json();
  const assets = data.assets ?? [];
  const pattern = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/i;
  const hit = assets.find((a) => pattern.test(a.name));
  if (!hit) {
    throw new Error(
      `没找到标准 x86_64 包，现有资产：${assets.map((a) => a.name).join(', ')}`,
    );
  }
  return { name: hit.name, url: hit.browser_download_url, size: hit.size, tag: data.tag_name };
}

async function download(asset) {
  mkdirSync(DOWNLOADS, { recursive: true });
  const dest = join(DOWNLOADS, asset.name);
  if (existsSync(dest) && statSync(dest).size === asset.size && !FORCE) {
    console.log(`[mpv] 已有缓存：${asset.name}（${(asset.size / 1048576).toFixed(1)}MB）`);
    return dest;
  }

  console.log(`[mpv] 下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)}MB）…`);
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'nebula-media' } });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);

  const out = createWriteStream(dest);
  let received = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    received += value.length;
    const pct = Math.floor((received / asset.size) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      console.log(`[mpv]   ${pct}%`);
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  const got = statSync(dest).size;
  if (got !== asset.size) throw new Error(`下载不完整：期望 ${asset.size}，实际 ${got}`);
  console.log('[mpv] 下载完成');
  return dest;
}

function extract(archive, sevenZip) {
  if (existsSync(TARGET) && !FORCE) {
    const exe = join(TARGET, 'mpv.exe');
    if (existsSync(exe)) {
      console.log('[mpv] vendor/mpv 已存在，跳过解压（--force 可强制重来）');
      return;
    }
  }
  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  console.log('[mpv] 解压…');
  execFileSync(sevenZip, ['x', archive, `-o${TARGET}`, '-y'], { stdio: 'inherit' });
}

function verify() {
  const exe = join(TARGET, 'mpv.exe');
  if (!existsSync(exe)) throw new Error(`解压后没有 mpv.exe：${exe}`);
  let version = '未知';
  try {
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 });
    version = out.split('\n')[0]?.trim() ?? '未知';
  } catch (err) {
    throw new Error(`mpv.exe 无法运行：${err instanceof Error ? err.message : String(err)}`);
  }
  const files = readdirSync(TARGET).length;
  let total = 0;
  for (const f of readdirSync(TARGET)) {
    try {
      total += statSync(join(TARGET, f)).size;
    } catch {
      /* 目录项 */
    }
  }
  console.log(`[mpv] 就绪：${version}`);
  console.log(`[mpv] vendor/mpv 共 ${files} 项，${(total / 1048576).toFixed(1)}MB`);
  return { version, files, bytes: total };
}

async function main() {
  // 本地已有可用 mpv 时完全跳过网络：打包不该因为 GitHub 限流或离线而失败。
  // （曾因 releases API 返回 403 导致 `npm run pack` 整个中断，而 vendor/mpv 其实完好。）
  if (!FORCE && existsSync(join(TARGET, 'mpv.exe'))) {
    console.log('[mpv] vendor/mpv 已就绪，跳过下载（--force 可强制更新）');
    return verify();
  }
  const sevenZip = find7za();
  console.log(`[mpv] 7za: ${sevenZip}`);
  const asset = await pickAsset();
  console.log(`[mpv] release ${asset.tag} → ${asset.name}`);
  const archive = await download(asset);
  extract(archive, sevenZip);
  const info = verify();
  console.log('[mpv] 完成。下次 `npm run pack` 会自动带进 resources/mpv/');
  return info;
}

main().catch((err) => {
  console.error(`[mpv] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
