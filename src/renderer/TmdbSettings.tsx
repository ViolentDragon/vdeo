import { useEffect, useState } from 'react';
import { IPC } from '../shared/ipc-contract';
import { TMDB_API_SETTINGS, TMDB_SITE, type TmdbStatus, type TmdbSyncStatus } from '../shared/tmdb';
import { api } from './api';
import { call, Icon } from './ui';
import tmdbLogo from './assets/tmdb-logo.svg';

export function TmdbSettings() {
  const [status, setStatus] = useState<TmdbStatus | null>(null);
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = status?.sync;
  const running = sync?.phase === 'running';

  useEffect(() => {
    let active = true;
    const off = api.on<TmdbSyncStatus>(IPC.evTmdbSync, (progress) => {
      setStatus((current) => current ? { ...current, sync: progress } : current);
    });
    void call<TmdbStatus>(IPC.tmdbStatus).then((value) => {
      if (active) setStatus(value);
    }).catch((err: Error) => {
      if (active) setError(err.message);
    });
    return () => { active = false; off(); };
  }, []);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const configure = (value: string | null) => act(async () => {
    setStatus(await call<TmdbStatus>(IPC.tmdbConfigure, { credential: value }));
    setCredential('');
  });

  return (
    <section className="surface settings-section" id="tmdb-settings">
      <div className="section-heading">
        <h2>TMDB 影视元数据</h2>
        <span className={status?.configured ? 'status status--ok' : 'status'}>
          {status ? (status.configured ? '已配置' : '未配置') : '正在读取设置…'}
        </span>
      </div>
      {status?.configured ? (
        <div className="page-actions page-actions--start">
          <button className="btn btn--ghost" type="button" disabled={busy || running} onClick={() => void act(async () => {
            setStatus(await call<TmdbStatus>(IPC.tmdbSyncStart));
          })}>补全现有影库</button>
          <button className="btn btn--ghost" type="button" disabled={busy || running}
            onClick={() => void configure(null)}>移除凭据</button>
        </div>
      ) : status ? (
        <form onSubmit={(event) => {
          event.preventDefault();
          if (credential.trim()) void configure(credential);
        }}>
          <fieldset className="settings-fields" disabled={busy || running}>
            <div className="field">
              <label htmlFor="tmdb-credential">API 读取访问令牌或 v3 API Key</label>
              <input id="tmdb-credential" className="input" type="password" autoComplete="off" spellCheck={false}
                aria-describedby="tmdb-help" value={credential} onChange={(event) => setCredential(event.target.value)} />
              <small id="tmdb-help">在 <a className="settings-link" href={TMDB_API_SETTINGS} target="_blank" rel="noreferrer">TMDB API 设置</a>申请凭据。
                扫描后，应用会用片名和年份查询海报、简介和评分。</small>
            </div>
            <div className="page-actions page-actions--start">
              <button className="btn btn--primary" type="submit" disabled={!credential.trim()}>
                <Icon name="check" /> {busy ? '正在验证…' : '验证并保存'}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
      {error || sync?.error ? <p className="error" role="alert">{error ?? sync?.error}</p> : null}
      {sync && sync.phase !== 'idle' ? (
        <div className="row tmdb-progress">
          {running ? <progress aria-label="TMDB 补全进度" value={sync.matched + sync.unmatched} max={Math.max(1, sync.total)} /> : null}
          <span className="status" role="status">
            {{ running: '正在补全', done: '补全完成', cancelled: '已取消', error: '补全中断' }[sync.phase]}
            {' · 已匹配 ' + sync.matched + ' 部 · 未匹配 ' + sync.unmatched + ' 部 · 共 ' + sync.total + ' 部'}
          </span>
          {running ? <button className="btn btn--ghost btn--sm" type="button" disabled={busy}
            onClick={() => void act(() => call<void>(IPC.tmdbSyncCancel))}>取消</button> : null}
        </div>
      ) : null}
    </section>
  );
}

export function TmdbAttribution() {
  return (
    <div className="tmdb-attribution">
      <a href={TMDB_SITE} target="_blank" rel="noreferrer">
        <img src={tmdbLogo} alt="The Movie Database (TMDB)" width="38" height="38" />
      </a>
      <div>
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
        <small><a className="settings-link" href="https://commons.wikimedia.org/wiki/File:Tmdb.new.logo.svg" target="_blank" rel="noreferrer">
          TMDB 标志 © Travis Bell</a> · <a className="settings-link" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
          CC BY-SA 4.0</a></small>
      </div>
    </div>
  );
}
