import { useCallback, useEffect, useRef, useState } from 'react';
import { IPC, type LocalPathListing, type LocalPathMode } from '../shared/ipc-contract';
import { call, Icon } from './ui';

export function LocalPathPicker({ mode, selected = [], onSelect, onClose }: {
  mode: LocalPathMode;
  selected?: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<LocalPathListing | null>(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const pathField = useRef<HTMLInputElement>(null);
  const directory = mode === 'directory';

  const load = useCallback(async (next?: string) => {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await call<LocalPathListing>(IPC.localPaths, { mode, path: next });
      if (current !== request.current) return;
      setListing(result);
      setPath(result.path);
    } catch (err) {
      if (current === request.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    pathField.current?.focus({ preventScroll: true });
    void load();
    return () => { ++request.current; };
  }, [load]);

  return <section className="path-picker" aria-label={directory ? '选择本地目录' : '选择播放器文件'}>
    <div className="path-picker__toolbar">
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load('')}><Icon name="disk" /> 磁盘</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()}><Icon name="home" /> 主目录</button>
      <button type="button" className="btn btn--ghost btn--sm" disabled={!listing?.path} onClick={() => void load(listing?.parent)}>
        <Icon name="back" /> 上一级
      </button>
    </div>
    <div className="path-picker__address">
      <input ref={pathField} className="input" aria-label="本地目录路径" placeholder="输入完整目录路径" value={path}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (path.trim()) void load(path.trim());
          }
        }} />
      <button type="button" className="btn btn--ghost" disabled={!path.trim()} onClick={() => void load(path.trim())}>前往</button>
    </div>
    {loading ? <p className="status" role="status">正在读取目录…</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
    {!loading && listing ? <ul className="path-picker__list">
      {listing.entries.map((entry) => <li key={entry.path}>
        <button type="button" className="browse-row browse-row--dir" onClick={() => entry.directory ? void load(entry.path) : onSelect(entry.path)}>
          <Icon name={entry.directory ? (listing.path ? 'folder' : 'disk') : 'file'} />
          <span className="browse-row__name" title={entry.name}>{entry.name}</span>
          <Icon name={entry.directory ? 'chevron' : 'check'} />
        </button>
      </li>)}
      {!listing.entries.length ? <li className="path-picker__empty">当前目录没有{directory ? '子目录' : '可选择的文件'}</li> : null}
    </ul> : null}
    <div className="page-actions">
      <button type="button" className="btn btn--ghost" onClick={onClose}>完成</button>
      {directory ? <button type="button" className="btn btn--primary"
        disabled={loading || Boolean(error) || !listing?.path || selected.includes(listing.path)}
        onClick={() => { if (listing?.path) onSelect(listing.path); }}>
        <Icon name={listing && selected.includes(listing.path) ? 'check' : 'plus'} />
        {listing && selected.includes(listing.path) ? '已添加当前目录' : '添加当前目录'}
      </button> : null}
    </div>
  </section>;
}
