import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

function windowsExecutables(version, productName) {
  return [`${productName}-${version}-x64.exe`, `${productName}-${version}-portable.exe`];
}

function removeVersionOutput(output) {
  if (lstatSync(output).isSymbolicLink() || realpathSync(output) !== output) {
    throw new Error(`无法安全清理 ${output}`);
  }
  rmSync(output, { recursive: true, force: true });
}

function pruneOldPackages(tag) {
  if (!existsSync(join(releaseDir, tag))) return;
  for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === tag || !entry.name.startsWith('v') || !versionParts(entry.name)) continue;
    try {
      removeVersionOutput(join(realpathSync(releaseDir), entry.name));
      console.log(`[update] 已清理旧的本地版本 ${entry.name}。`);
    } catch (error) {
      console.warn(`[update] 清理 ${entry.name} 失败：${error.message}`);
    }
  }
}

function packageWindows(version, productName) {
  const output = join(realpathSync(releaseDir), `v${version}`);
  const hadOutput = existsSync(output);
  if (hadOutput && realpathSync(output) !== output) throw new Error(`无法安全写入 ${output}`);
  npm('run', 'typecheck');
  try {
    npm('run', 'pack', '--', '--publish=never', `--config.extraMetadata.version=${version}`,
      `--config.directories.output=${output}`);
    npm('test');
    for (const name of windowsExecutables(version, productName)) {
      if (!existsSync(join(output, name))) throw new Error(`缺少打包产物 ${name}`);
    }
  } catch (error) {
    if (!hadOutput && existsSync(output)) removeVersionOutput(output);
    throw error;
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
  console.log(`[update] ${tag} 已推送，等待 GitHub Actions 发布。`);
  console.log(`https://github.com/${repo}/actions/workflows/windows-release.yml`);
}

function githubReadToken(pushUrl) {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!pushUrl.startsWith('https://')) return;
  const result = spawnSync('git', ['credential', 'fill'], {
    cwd: root,
    input: `url=${pushUrl}\n\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    windowsHide: true,
  });
  return /^password=(.+)$/m.exec(result.stdout ?? '')?.[1].trim();
}

async function waitForGitHubRelease(repo, pushUrl, tag, productName) {
  const token = githubReadToken(pushUrl);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Nebula-release' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = `https://api.github.com/repos/${repo}`;
  const query = new URLSearchParams({ event: 'push', head_sha: git('rev-parse', `${tag}^{commit}`), per_page: '1' });
  const deadline = Date.now() + 35 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/actions/workflows/windows-release.yml/runs?${query}`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`无法查询 GitHub Actions（HTTP ${response.status}）。`);
    const { workflow_runs: [workflow] } = await response.json();
    if (workflow?.status === 'completed') {
      if (workflow.conclusion !== 'success') throw new Error(`${tag} 的 GitHub Actions 发布失败：${workflow.html_url}`);
      const result = await fetch(`${api}/releases/tags/${tag}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!result.ok) throw new Error(`无法查询 ${tag} 的 GitHub Release（HTTP ${result.status}）。`);
      const release = await result.json();
      const expected = windowsExecutables(tag.slice(1), productName);
      if (release.draft || !expected.every((name) => release.assets.some((asset) => asset.name === name && asset.state === 'uploaded' && asset.size > 0))) {
        throw new Error(`${tag} 的 GitHub Release 尚未发布完整的 Windows 程序包。`);
      }
      console.log(`[update] ${tag} 的 GitHub Release 已发布，安装包和便携版均已上传。`);
      console.log(release.html_url);
      return;
    }
    await delay(30_000);
  }
  throw new Error(`等待 ${tag} 的 GitHub Release 超时，请查看上方的工作流链接。`);
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
  const publish = async (tag) => {
    await pushRelease(branch, tag, repo, reauthorize);
    pruneOldPackages(tag);
    await waitForGitHubRelease(repo, pushUrl, tag, pkg.productName);
  };

  const currentTag = `v${pkg.version}`;
  const currentRef = `refs/tags/${currentTag}`;
  if (localTags.includes(currentTag) && !remoteRefs.has(currentRef)
    && git('rev-parse', `${currentRef}^{commit}`) === git('rev-parse', 'HEAD')) {
    console.log(`[update] 继续发布已提交的 ${currentTag}。`);
    return publish(currentTag);
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
  await publish(tag);
}

try {
  const { values } = parseArgs({ options: {
    'package-only': { type: 'boolean' },
    'reauth-on-workflow-error': { type: 'boolean' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run update                    增加补丁版本号，打包、推送并确认 GitHub Release');
    console.log('npm run update -- --package-only   为当前版本生成 Windows 安装包和便携版');
    console.log('npm run update -- --reauth-on-workflow-error   工作流写入被拒绝时重新授权并重试');
  } else {
    if (process.platform !== 'win32') throw new Error('请在 Windows 上运行此脚本');
    if (!process.env.npm_execpath) throw new Error('请通过 npm run update 运行');
    mkdirSync(releaseDir, { recursive: true });
    if (realpathSync(releaseDir) !== join(realpathSync(root), 'release')) throw new Error('release 必须位于项目目录内');
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
