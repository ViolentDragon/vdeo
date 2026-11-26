import QRCode from 'qrcode';

/**
 * 阿里云盘扫码授权。
 *
 * 流程（passport 二维码）：
 *   1. generate.do  → { codeContent, t, ck }
 *   2. 把 codeContent 编码成二维码给用户扫
 *   3. query.do 轮询 → NEW / SCANED / CONFIRMED / EXPIRED
 *   4. CONFIRMED 时 data.bizExt 是 base64 的 JSON，内含 accessToken / refreshToken
 *   5. accessToken 失效后用 auth.aliyundrive.com/v2/account/token 刷新
 *
 * 已实测的接口事实（本机探针）：
 *   - generate.do 返回 200 且带真实 codeContent
 *   - query.do 返回 200 且带 qrCodeStatus
 *   - auth/token 对假 refresh_token 返回 400 InvalidParameter.RefreshToken（端点存在）
 *   - openapi getDriveInfo 对假 token 返回 401 AccessTokenInvalid（端点存在）
 * 未验证的一步：真实手机扫码确认后 bizExt 的实际字段（需要用户扫码，无法自动化）。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PASSPORT = 'https://passport.aliyundrive.com/newlogin/qrcode';
const TOKEN_URL = 'https://auth.aliyundrive.com/v2/account/token';
const OPENAPI = 'https://openapi.alipan.com';

export const ALIYUN_QR_APP_PARAMS =
  'appName=aliyun_drive&fromSite=52&appEntrance=web&isMobile=false&lang=zh_CN&_bx-v=2.5.3';

export type QrStatus = 'NEW' | 'SCANNED' | 'CONFIRMED' | 'EXPIRED' | 'UNKNOWN';

export interface QrSession {
  /** 本地会话标识 */
  id: string;
  t: string;
  ck: string;
  /** 需要编码成二维码的原始内容 */
  codeContent: string;
  /** 可直接放进 <img src> 的 PNG dataURL */
  qrDataUrl: string;
  createdAt: number;
}

export interface AliyunToken {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳；0 表示未知 */
  expiresAt: number;
  userName: string | null;
  userId: string | null;
  /** 默认网盘 id，拿不到时用 'default' 交给服务端解析 */
  driveId: string | null;
}

export interface QrPollResult {
  status: QrStatus;
  /** status === 'CONFIRMED' 时存在 */
  token?: AliyunToken;
  raw?: unknown;
}

function baseHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Referer: 'https://www.aliyundrive.com/',
    Origin: 'https://www.aliyundrive.com',
  };
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { ...baseHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`阿里云盘返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
}

/** 深度找第一个匹配的字符串字段，用于容错解析不同版本的 bizExt 结构 */
export function deepFindString(node: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const hit = deepFindString(v, keys, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 同上，但字符串与数字都收。
expiresIn 在真实响应里是数字，只用 deepFindString 会漏掉，
导致 expiresAt 恒为 0（token 永远不主动刷新）。
 */
export function deepFindValue(node: unknown, keys: string[], depth = 0): string | number | null {
  if (depth > 6 || node === null || typeof node !== 'object') return null;
  const rec = node as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const hit = deepFindValue(v, keys, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * 解析 CONFIRMED 响应里的 bizExt。
 * bizExt 是 base64(JSON)，字段名在不同版本间有 accessToken/access_token 两种写法，都要认。
 */
export function parseBizExt(bizExt: unknown): AliyunToken | null {
  let node: unknown = bizExt;
  if (typeof bizExt === 'string') {
    const decoded = Buffer.from(bizExt, 'base64').toString('utf8');
    try {
      node = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!node || typeof node !== 'object') return null;

  const accessToken = deepFindString(node, ['accessToken', 'access_token']);
  const refreshToken = deepFindString(node, ['refreshToken', 'refresh_token']);
  if (!accessToken || !refreshToken) return null;

  const expiresInRaw = deepFindValue(node, ['expiresIn', 'expires_in']);
  const expiresIn = expiresInRaw !== null ? Number(expiresInRaw) : NaN;

  return {
    accessToken,
    refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    userName: deepFindString(node, ['nickName', 'userName', 'nick_name', 'user_name', 'displayName']),
    userId: deepFindString(node, ['userId', 'user_id', 'sub']),
    driveId: deepFindString(node, ['defaultDriveId', 'default_drive_id', 'driveId', 'drive_id']),
  };
}

/** 申请一个新的扫码会话，返回可直接展示的二维码 */
export async function startQrLogin(): Promise<QrSession> {
  const json = (await getJson(`${PASSPORT}/generate.do?${ALIYUN_QR_APP_PARAMS}`)) as {
    content?: { data?: { codeContent?: string; t?: number | string; ck?: string } };
  };
  const data = json?.content?.data;
  if (!data?.codeContent || !data.ck || data.t === undefined) {
    throw new Error('阿里云盘没有返回二维码内容，稍后重试或改用 WebDAV（Alist）方式挂载');
  }
  const qrDataUrl = await QRCode.toDataURL(data.codeContent, {
    width: 260,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#0a0d14', light: '#ffffff' },
  });
  return {
    id: `qr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    t: String(data.t),
    ck: data.ck,
    codeContent: data.codeContent,
    qrDataUrl,
    createdAt: Date.now(),
  };
}

function normalizeStatus(raw: unknown): QrStatus {
  const s = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (s === 'NEW' || s === 'SCANED' || s === 'SCANNED' || s === 'CONFIRMED' || s === 'EXPIRED') {
    return s === 'SCANNED' ? 'SCANNED' : (s as QrStatus);
  }
  return 'UNKNOWN';
}

/**
 * 列出 bizExt 解码后的键名（只取键，绝不取值），用于诊断官方字段名变化。
 * 真实扫码后若 token 校验失败，靠这个看出 bizExt 到底给了哪些字段。
 */
export function listBizExtKeys(bizExt: unknown): string[] {
  let node: unknown = bizExt;
  if (typeof bizExt === 'string') {
    try {
      node = JSON.parse(Buffer.from(bizExt, 'base64').toString('utf8')) as unknown;
    } catch {
      return [];
    }
  }
  if (!node || typeof node !== 'object') return [];
  const out: string[] = [];
  const walk = (o: unknown, prefix: string, depth: number): void => {
    if (depth > 2 || !o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out.push(prefix + k);
      if (v && typeof v === 'object') walk(v, `${prefix}${k}.`, depth + 1);
    }
  };
  walk(node, '', 0);
  return out;
}

/** 轮询扫码状态；CONFIRMED 时顺带解析出 token */
export async function pollQrLogin(session: Pick<QrSession, 't' | 'ck'>): Promise<QrPollResult> {
  // 必须用 POST。实测对照：同一个会话 GET 返回 EXPIRED、POST 返回 NEW——
  // 服务端只认 form body 里的 t/ck，query string 里的会被忽略。
  const json = (await getJson(`${PASSPORT}/query.do?${ALIYUN_QR_APP_PARAMS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `t=${encodeURIComponent(session.t)}&ck=${encodeURIComponent(session.ck)}`,
  })) as {
    content?: {
      data?: { qrCodeStatus?: string; bizExt?: unknown };
      success?: boolean;
    };
  };
  const data = json?.content?.data;
  const status = normalizeStatus(data?.qrCodeStatus);
  if (status !== 'CONFIRMED') return { status, raw: data };

  const token = parseBizExt(data?.bizExt);
  if (!token) {
    return {
      status: 'CONFIRMED',
      raw: data,
      token: undefined,
    };
  }
  return { status, token, raw: data };
}

/** refresh_token 换新的 access_token（同时可能轮换 refresh_token，必须存回） */
export async function refreshToken(refreshTokenValue: string): Promise<AliyunToken> {
  const json = (await getJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshTokenValue }),
  })) as Record<string, unknown>;

  const accessToken = typeof json['access_token'] === 'string' ? json['access_token'] : null;
  const newRefresh = typeof json['refresh_token'] === 'string' ? json['refresh_token'] : null;
  if (!accessToken) {
    throw new Error(
      `刷新阿里云盘 token 失败：${typeof json['message'] === 'string' ? json['message'] : JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const expiresIn = Number(json['expires_in']);
  return {
    accessToken,
    refreshToken: newRefresh ?? refreshTokenValue,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    userName: typeof json['user_name'] === 'string' ? json['user_name'] : null,
    userId: typeof json['user_id'] === 'string' ? json['user_id'] : null,
    driveId: typeof json['default_drive_id'] === 'string' ? json['default_drive_id'] : null,
  };
}

export interface DriveInfo {
  driveId: string;
  driveName: string;
  usedSize: number;
  totalSize: number;
}

/** 调 openapi 校验 token 并拿到默认网盘信息 */
export async function getDriveInfo(accessToken: string): Promise<DriveInfo> {
  const json = (await getJson(`${OPENAPI}/adrive/v1.0/user/getDriveInfo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  })) as Record<string, unknown>;

  const driveId =
    (typeof json['resource_drive_id'] === 'string' && json['resource_drive_id']) ||
    (typeof json['default_drive_id'] === 'string' && json['default_drive_id']) ||
    (typeof json['backup_drive_id'] === 'string' && json['backup_drive_id']) ||
    '';
  if (!driveId) {
    throw new Error(`无法获取阿里云盘 drive_id：${JSON.stringify(json).slice(0, 200)}`);
  }
  const toNum = (v: unknown): number => (typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    driveId,
    driveName: typeof json['drive_name'] === 'string' ? json['drive_name'] : '阿里云盘',
    usedSize: toNum(json['used_size']),
    totalSize: toNum(json['total_size']),
  };
}
