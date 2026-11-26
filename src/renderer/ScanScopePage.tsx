import { useEffect, useState } from 'react';
import { IPC } from '../shared/ipc-contract';
import type { ScanFolderRef, ScanScope, StorageSource } from '../shared/types';
import { call, Icon, PageHeading } from './ui';

type ListedFolder = ScanFolderRef & { isDir: boolean };

export function ScanScopePage({ source, onBack, onSave }: {
  source: StorageSource;
  onBack: () => void;
  onSave: (scope: ScanScope, scanNow: boolean) => Promise<void>;
}) {
  const existing = source.config.scanScope;
  const [mode, setMode] = useState<'all' | 'custom'>(existing?.mode === 'all' || !existing ? 'all' : 'custom');
  const [selected, setSelected] = useState<ScanFolderRef[][]>(existing?.mode === 'custom' ? existing.folders : []);
  const [trail, setTrail] = useState<ScanFolderRef[]>([]);
  const [folders, setFolders] = useState<ListedFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const parentId = trail.at(-1)?.path ?? '';

  useEffect(() => {
    if (mode !== 'custom') return;
    let current = true;
    setLoading(true);
    setLoadError(null);
    void call<{ entries: ListedFolder[] }>(IPC.browseList, { sourceId: source.id, parentId })
      .then((result) => {
        if (!current) return;
        setFolders(result.entries.filter((entry) => entry.isDir).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')));
      })
      .catch((err: Error) => { if (current) setLoadError(err.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [mode, source.id, parentId, retry]);

  const includedByParent = trail.some((part) => selected.some((path) => path.at(-1)?.path === part.path));
  const toggle = (folder: ScanFolderRef, checked: boolean) => {
    setSaveError(null);
    setSelected((current) => {
      const remaining = current.filter((path) => !path.some((part) => part.path === folder.path));
      return checked ? [...remaining, [...trail, { path: folder.path, name: folder.name }]] : remaining;
    });
  };
  const save = async (scanNow: boolean) => {
    setSaveError(null);
    setSaving(true);
    try {
      await onSave(mode === 'all' ? { mode: 'all' } : { mode: 'custom', folders: selected }, scanNow);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const canSave = mode === 'all' || selected.length > 0;
  return <section className="subpage">
    <PageHeading title="扫描范围" description={source.name} icon="scan" onBack={onBack} backDisabled={saving} />
    <div className="surface browse-surface scan-scope">
      <fieldset className="scan-scope__modes" disabled={saving}>
        <legend>选择要扫描的文件夹</legend>
        <label><input type="radio" name="scan-scope" checked={mode === 'all'} onChange={() => { setMode('all'); setSaveError(null); }} /> 全选</label>
        <label><input type="radio" name="scan-scope" checked={mode === 'custom'} onChange={() => { setMode('custom'); setSaveError(null); }} /> 自定义选择</label>
      </fieldset>
      {mode === 'all' ? <p className="status">扫描整个存储源，包括所有子文件夹。</p> : <>
        <p className="status">勾选要扫描的文件夹。点击文件夹名称，可以进入下一层。</p>
        <nav className="browse-crumb" aria-label="目录路径">
          <button onClick={() => setTrail([])} aria-current={trail.length ? undefined : 'location'}>根目录</button>
          {trail.map((part, index) => <span key={part.path}><Icon name="chevron" />
            <button aria-current={index === trail.length - 1 ? 'location' : undefined} onClick={() => setTrail(trail.slice(0, index + 1))}>
              {part.name}
            </button></span>)}
        </nav>
        {loading ? <p className="status" role="status">正在读取文件夹…</p> : null}
        {loadError ? <div className="play-error" role="alert"><span>{loadError}</span>
          <button className="btn btn--ghost btn--sm" onClick={() => setRetry((value) => value + 1)}>重试</button>
        </div> : null}
        {!loading && !loadError ? (
          folders.length ? <ul className="browse-list">
            {folders.map((folder) => {
              const checked = includedByParent || selected.some((path) => path.at(-1)?.path === folder.path);
              return <li className="scan-scope__row" key={folder.path}>
                <label className="scan-scope__check" title={includedByParent ? '已包含在所选的上级文件夹中' : undefined}>
                  <input type="checkbox" checked={checked} disabled={saving || includedByParent}
                    onChange={(event) => toggle(folder, event.target.checked)} />
                  <span className="scan-scope__visually-hidden">选择 {folder.name}</span>
                </label>
                <button className="browse-row browse-row--dir" onClick={() => setTrail([...trail, { path: folder.path, name: folder.name }])}>
                  <Icon name="folder" /><span className="browse-row__name" title={folder.name}>{folder.name}</span><Icon name="chevron" />
                </button>
              </li>;
            })}
          </ul> : <p className="status">当前目录没有子文件夹。可以返回上一层勾选此文件夹。</p>
        ) : null}
        <p className="browse-total" aria-live="polite">已选 {selected.length} 个文件夹，包含其子文件夹</p>
        {selected.length ? <ul className="scan-scope__selected" aria-label="已选文件夹">
          {selected.map((path) => <li key={path.at(-1)?.path}>
            <button className="btn btn--ghost btn--sm" disabled={saving}
              title={path.map((part) => part.name).join(' / ')}
              aria-label={'取消选择 ' + path.map((part) => part.name).join(' / ')}
              onClick={() => toggle(path[path.length - 1]!, false)}>
              {path.map((part) => part.name).join(' / ')} <Icon name="close" />
            </button>
          </li>)}
        </ul> : null}
      </>}
      {saveError ? <p className="error" role="alert">{saveError}</p> : null}
      <div className="page-actions">
        <button className="btn btn--ghost" disabled={!canSave || saving} onClick={() => void save(false)}>保存</button>
        <button className="btn btn--primary" disabled={!canSave || saving || !source.enabled} onClick={() => void save(true)}>
          <Icon name="scan" /> {saving ? '正在保存…' : '保存并扫描'}
        </button>
      </div>
    </div>
  </section>;
}
