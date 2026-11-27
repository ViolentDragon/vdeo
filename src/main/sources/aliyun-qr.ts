import type { StorageSource } from '../../shared/types';
import type { Repository } from '../db';
import { sourceId } from '../db/ids';
import { log } from '../logger';
import { getDriveInfo, pollQrLogin, refreshToken, startQrLogin, type QrSession, type QrStatus } from './aliyun-auth';
import { encryptSecret } from './secrets';

const SESSION_MS = 3 * 60_000;
type PollResult = { status: Exclude<QrStatus, 'CONFIRMED'> }
  | { status: 'CONFIRMED'; source: StorageSource; driveName: string };

interface Session {
  qr: QrSession;
  pending?: Promise<PollResult>;
  completed?: PollResult;
}

export function createAliyunQrLogin(repo: Pick<Repository, 'insertSource'>, encrypt = encryptSecret) {
  const sessions = new Map<string, Session>();

  async function confirm(qr: QrSession, name?: string, driveId?: string): Promise<PollResult> {
    const result = await pollQrLogin(qr);
    if (result.status !== 'CONFIRMED') return { status: result.status };
    if (!result.token) throw new Error('已在手机上确认，但阿里云盘未返回可用的授权。请重新扫码。');

    let token = result.token;
    try {
      token = await refreshToken(token.refreshToken);
    } catch {
      log('[aliyun] 换取令牌失败，尝试使用扫码返回的授权');
    }
    const drive = await getDriveInfo(token.accessToken);
    const source: StorageSource = {
      id: sourceId(),
      kind: 'aliyun',
      name: name?.trim() || drive.driveName || '阿里云盘',
      config: {
        kind: 'aliyun',
        driveId: driveId?.trim() || drive.driveId,
        refreshToken: encrypt(token.refreshToken),
        accessToken: encrypt(token.accessToken),
        expiresAt: token.expiresAt,
        userName: token.userName ?? drive.driveName,
        root: 'root',
        scanScope: { mode: 'pending' },
      },
      enabled: true,
      lastScanAt: null,
      lastScanCount: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    repo.insertSource(source);
    return { status: 'CONFIRMED', source, driveName: drive.driveName };
  }

  return {
    async start() {
      for (const [id, session] of sessions) {
        if (!session.pending && Date.now() - session.qr.createdAt >= SESSION_MS) sessions.delete(id);
      }
      const qr = await startQrLogin();
      sessions.set(qr.id, { qr });
      return { sessionId: qr.id, qrDataUrl: qr.qrDataUrl, expiresInSec: SESSION_MS / 1000 };
    },

    async poll({ sessionId, name, driveId }: { sessionId: string; name?: string; driveId?: string }): Promise<PollResult> {
      const session = sessions.get(sessionId);
      if (!session) return { status: 'EXPIRED' };
      if (session.pending) return session.pending;
      if (Date.now() - session.qr.createdAt >= SESSION_MS) {
        sessions.delete(sessionId);
        return { status: 'EXPIRED' };
      }
      if (session.completed) return session.completed;
      session.pending = confirm(session.qr, name, driveId);
      try {
        const result = await session.pending;
        if (result.status === 'CONFIRMED') session.completed = result;
        if (result.status === 'EXPIRED') sessions.delete(sessionId);
        return result;
      } finally {
        session.pending = undefined;
      }
    },
  };
}
