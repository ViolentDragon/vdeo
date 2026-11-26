import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { PageHeading } from './ui';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

const startupError = new URLSearchParams(window.location.search).get('startupError');

createRoot(container).render(
  <React.StrictMode>
    {startupError ? <main className="startup-failure">
      <div className="window-drag" aria-hidden="true" />
      <PageHeading title="星云影库启动失败" icon="anime" description="请根据下方信息排查问题，然后重新打开应用。" />
      <p className="error" role="alert">{startupError}</p>
      <div className="page-actions page-actions--start">
        <button className="btn btn--ghost" onClick={() => window.close()}>关闭应用</button>
      </div>
    </main> : <App />}
  </React.StrictMode>,
);
