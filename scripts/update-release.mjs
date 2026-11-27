import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const releaseDir = join(root, 'release');
const gitHubUrl = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const label = command === process.execPath ? ['npm', ...args.slice(1, 3)].join(' ') : `${command} ${args[0]}`;
    throw new Error(`${label} 失败`);
  }
  return result.stdout?.trim() ?? '';
}

const git = (...args) => run('git', args, true);
const npm = (...args) => run(process.execPath, [process.env.npm_execpath, ...args]);

function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.slice(1).map(BigInt);
}

function nextPatch(current, tags) {
  let latest = versionParts(current);
  for (const tag of tags) {
    const candidate = versionParts(tag);
    if (!candidate) continue;
    const difference = candidate.findIndex((part, index) => part !== latest[index]);
    if (difference >= 0 && candidate[difference] > latest[difference]) latest = candidate;
  }
  const [major, minor, patch] = latest;
  return `${major}.${minor}.${patch + 1n}`;
}

function packageWindows(version, productName) {
  const output = join(releaseDir, `v${version}`);
  npm('run', 'typecheck');
  npm('run', 'pack', '--', '--publish=never', `--config.extraMetadata.version=${version}`,
    `--config.directories.output=${output}`);
  npm('test');
  for (const name of [`${productName}-${version}-x64.exe`, `${productName}-${version}-portable.exe`]) {
    if (!existsSync(join(output, name))) throw new Error(`缺少打包产物 ${name}`);
  }
  console.log(`[update] Windows 安装包和便携版已生成：${output}`);
}

function pushGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

function workflowPermissionDenied(stderr) {
  return /create or update workflow/i.test(stderr)
    && /without\s+(?:the\s+)?[`'"]?workflows?[`'"]?\s+(?:scope|permission)/i.test(stderr);
}

async function pushRelease(branch, tag, repo, reauthorize) {
  const args = ['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`];
  try {
    let result = await pushGit(args);
    if (reauthorize && result.code !== null && result.code !== 0 && workflowPermissionDenied(result.stderr)) {
      console.log('[update] GitHub 凭据缺少工作流写权限。请在浏览器中确认 GitHub 授权，完成后会重试当前版本。');
      run('git', ['credential-manager', 'github', 'login', '--browser', '--force']);
      result = await pushGit(args);
    }
    if (result.code !== 0) {
      if (workflowPermissionDenied(result.stderr)) {
        console.error('[update] 请使用有仓库写入和工作流写入权限的 GitHub 凭据，再运行 update-release.cmd。');
      }
      throw new Error('git push 失败');
    }
  } catch (error) {
    console.error(`[update] ${tag} 已保存在本地。排除推送问题后可重新运行，本次版本会继续推送。`);
    throw error;
  }
  console.log(`[update] ${tag} 已推送，GitHub Actions 将打包并发布 Release。`);
  console.log(`https://github.com/${repo}/actions/workflows/windows-release.yml`);
  console.log(`https://github.com/${repo}/releases/tag/${tag}`);
}

async function update(pkg, packageOnly, reauthOnWorkflowError) {
  if (packageOnly) return packageWindows(pkg.version, pkg.productName);

  const pushUrl = git('remote', 'get-url', '--push', 'origin');
  const repo = gitHubUrl.exec(pushUrl)?.[1];
  const reauthorize = reauthOnWorkflowError && /^https:\/\//i.test(pushUrl);
  if (!repo) throw new Error('origin 必须指向 github.com 仓库');
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const branchRef = `refs/heads/${branch}`;
  const remoteRefs = new Map(git('ls-remote', '--refs', 'origin', branchRef, 'refs/tags/*')
    .split('\n').filter(Boolean).map((line) => {
      const [hash, ref] = line.split('\t');
      return [ref, hash];
    }));
  const remoteTip = remoteRefs.get(branchRef);
  if (remoteTip) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', remoteTip, 'HEAD'], { cwd: root, windowsHide: true });
    if (ancestor.status !== 0) throw new Error(`远端 ${branch} 包含本地尚未合入的提交。请先同步分支。`);
  }
  const localTags = git('tag', '--list').split('\n').filter(Boolean);
  const currentTag = `v${pkg.version}`;
  const currentRef = `refs/tags/${currentTag}`;
  if (localTags.includes(currentTag) && !remoteRefs.has(currentRef)
    && git('rev-parse', `${currentRef}^{commit}`) === git('rev-parse', 'HEAD')) {
    console.log(`[update] 继续发布已提交的 ${currentTag}。`);
    return pushRelease(branch, currentTag, repo, reauthorize);
  }

  git('var', 'GIT_AUTHOR_IDENT');
  git('var', 'GIT_COMMITTER_IDENT');
  const remoteTags = [...remoteRefs.keys()].filter((ref) => ref.startsWith('refs/tags/'))
    .map((ref) => ref.slice('refs/tags/'.length));
  const version = nextPatch(pkg.version, [...localTags, ...remoteTags]);
  const tag = `v${version}`;
  console.log(`[update] 准备发布 ${tag} 到 ${repo} 的 ${branch} 分支`);
  run('git', ['status', '--short']);
  packageWindows(version, pkg.productName);
  npm('version', version, '--no-git-tag-version', '--ignore-scripts');
  run('git', ['add', '--all']);
  run('git', ['commit', '-m', `release: ${tag}`]);
  run('git', ['tag', tag]);
  await pushRelease(branch, tag, repo, reauthorize);
}

try {
  const { values } = parseArgs({ options: {
    'package-only': { type: 'boolean' },
    'reauth-on-workflow-error': { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run update                    打包后提交代码和版本标签，并触发 GitHub Release');
    console.log('npm run update -- --package-only   为当前版本生成 Windows 安装包和便携版');
    console.log('npm run update -- --reauth-on-workflow-error   工作流写入被拒绝时重新授权并重试');
  } else {
    if (process.platform !== 'win32') throw new Error('请在 Windows 上运行此脚本');
    if (!process.env.npm_execpath) throw new Error('请通过 npm run update 运行');
    mkdirSync(releaseDir, { recursive: true });
    const lock = join(releaseDir, '.update.lock');
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`更新已在运行。若上次异常中断，确认进程结束后可移除 ${lock}`);
    }
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (!versionParts(pkg.version)) throw new Error('package.json 版本应为 major.minor.patch');
      await update(pkg, values['package-only'], values['reauth-on-workflow-error']);
    } finally {
      unlinkSync(lock);
    }
  }
} catch (error) {
  console.error(`[update] ${error.message}`);
  process.exitCode = 1;
}
