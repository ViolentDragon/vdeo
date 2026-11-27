import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepository } from '../src/main/db';
import { scanSource } from '../src/main/scan/scanner';
import { sourceScanRoots, validateScanScope } from '../src/main/scan/scope';
import { LocalProvider } from '../src/main/sources/local';
import type { StorageSource } from '../src/shared/types';

test('自定义扫描跳过同级目录，按真实路径去重并保留取消范围内的记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nebula-scope-'));
  const allowed = join(root, '视频资源');
  const episodes = join(allowed, '剧集');
  const excluded = join(root, '其他');
  mkdirSync(episodes, { recursive: true });
  mkdirSync(excluded);
  writeFileSync(join(episodes, '测试剧.S01.E01.mp4'), '');
  writeFileSync(join(excluded, '其他资源.mp4'), '');

  const repo = createRepository(':memory:');
  const provider = new LocalProvider([root]);
  const visited: string[] = [];
  const list = provider.list.bind(provider);
  provider.list = async (folder) => { visited.push(folder); return list(folder); };
  const source: StorageSource = {
    id: 'scan-scope', name: '测试', kind: 'local', config: { kind: 'local', roots: [root] },
    enabled: true, createdAt: 0, lastScanAt: null, lastScanCount: 0, lastError: null,
  };
  const scan = () => scanSource({ source, provider, repo, ignorePatterns: [] });
  try {
    repo.insertSource(source);
    assert.equal((await scan()).found, 2);
    const excludedItem = repo.browse({ search: '其他资源' }).items[0];
    assert.ok(excludedItem);

    await assert.rejects(validateScanScope(source, provider, {
      mode: 'custom', folders: [[{ path: join(root, '伪造目录'), name: '伪造目录' }]],
    }), /移动|移除/);

    const scope = await validateScanScope(source, provider, {
      mode: 'custom', folders: [
        [{ path: allowed, name: '旧名称' }, { path: episodes, name: '剧集' }],
        [{ path: allowed, name: '旧名称' }],
      ],
    });
    assert.deepEqual(scope, { mode: 'custom', folders: [[{ path: allowed, name: '视频资源' }]] });
    source.config.scanScope = scope;
    repo.updateSource(source);
    assert.deepEqual(repo.getSource(source.id)?.config.scanScope, scope);

    visited.length = 0;
    const result = await scan();
    assert.equal(result.error, null);
    assert.equal(result.found, 1);
    assert.deepEqual(visited, [allowed, episodes]);
    assert.equal(repo.countItems(), 1);
    assert.equal(repo.getItem(excludedItem.id)?.missing, true);

    source.config.scanScope = { mode: 'pending' };
    assert.throws(() => sourceScanRoots(source), /请先设置/);
    await assert.rejects(scan, /请先设置/);

    source.config.scanScope = { mode: 'all' };
    assert.equal((await scan()).found, 2);
    assert.equal(repo.countItems(), 2);
  } finally {
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
