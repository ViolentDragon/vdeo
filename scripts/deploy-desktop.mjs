/**
 * 把最新构建同步到固定安装目录，并（可选）创建桌面快捷方式。
 *
 * 为什么需要它：之前每次只更新 release/win-unpacked，而用户运行的是
 * 另一个位置（安装目录或 portable 临时解压目录），导致「代码更新了但界面没变」。
 * 现在统一到一个固定路径，打包后自动同步。
 *
 * 用法：node scripts/deploy-desktop.mjs [--shortcut]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'release', 'win-unpacked');
const DEST = process.env['NEBULA_DESKTOP_DIR'] || 'D:\\Program\\Nebula';
const MAKE_SHORTCUT = process.argv.includes('--shortcut');

function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!exists(join(SRC, 'Nebula.exe'))) {
    console.error(`[deploy] 找不到构建产物：${SRC}\\Nebula.exe，请先运行 npm run pack`);
    process.exit(1);
  }

  console.log(`[deploy] 源：${SRC}`);
  console.log(`[deploy] 目标：${DEST}`);

  // 目标是安装目录时可能残留旧文件，先清空（保留目录本身）
  if (exists(DEST)) {
    try {
      for (const name of readdirSync(DEST)) {
        rmSync(join(DEST, name), { recursive: true, force: true });
      }
      console.log('[deploy] 已清空旧版本');
    } catch (err) {
      console.error(`[deploy] 无法清理目标目录（程序可能正在运行）：${err.message}`);
      console.error('[deploy] 请先完全退出 Nebula 后重试');
      process.exit(1);
    }
  } else {
    mkdirSync(DEST, { recursive: true });
  }

  try {
    cpSync(SRC, DEST, { recursive: true });
  } catch (err) {
    console.error(`[deploy] 复制失败：${err.message}`);
    process.exit(1);
  }

  const exe = join(DEST, 'Nebula.exe');
  console.log(`[deploy] 完成 → ${exe}`);

  if (MAKE_SHORTCUT) {
    const ps = `
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$sc = $ws.CreateShortcut((Join-Path $desktop '星云影库.lnk'))
$sc.TargetPath = '${exe}'
$sc.WorkingDirectory = '${DEST}'
$sc.Description = '星云影库 Nebula'
$sc.Save()
$start = [Environment]::GetFolderPath('Programs')
$sc2 = $ws.CreateShortcut((Join-Path $start '星云影库.lnk'))
$sc2.TargetPath = '${exe}'
$sc2.WorkingDirectory = '${DEST}'
$sc2.Save()
Write-Output 'shortcut-ok'
`;
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
      if (out.includes('shortcut-ok')) console.log('[deploy] 已创建桌面与开始菜单快捷方式：星云影库');
    } catch (err) {
      console.error(`[deploy] 创建快捷方式失败：${err.message}`);
    }
  }
}

main();
