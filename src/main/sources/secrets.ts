/**
 * 凭据加密。
 * 优先 Electron safeStorage（Windows 走 DPAPI，绑定当前用户账户）。
 * safeStorage 不可用（例如少数 Linux 无 keyring）时退化为可识别前缀的混淆编码，
 * 并在返回值里明确标记强度，避免把弱保护伪装成强保护。
 */

const WEAK_PREFIX = 'obf:v1:';
const STRONG_PREFIX = 'enc:v1:';

type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
};

function getSafeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage?: SafeStorageLike };
    const ss = electron.safeStorage;
    if (!ss) return null;
    if (typeof ss.isEncryptionAvailable === 'function' && !ss.isEncryptionAvailable()) return null;
    return ss;
  } catch {
    return null;
  }
}

export function encryptSecret(plain: string): string {
  if (plain === '') return '';
  const ss = getSafeStorage();
  if (ss) {
    try {
      return STRONG_PREFIX + ss.encryptString(plain).toString('base64');
    } catch {
      /* fall through to weak */
    }
  }
  return WEAK_PREFIX + Buffer.from(plain, 'utf8').toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (stored.startsWith(STRONG_PREFIX)) {
    const ss = getSafeStorage();
    if (!ss) return '';
    try {
      return ss.decryptString(Buffer.from(stored.slice(STRONG_PREFIX.length), 'base64'));
    } catch {
      return '';
    }
  }
  if (stored.startsWith(WEAK_PREFIX)) {
    return Buffer.from(stored.slice(WEAK_PREFIX.length), 'base64').toString('utf8');
  }
  // 兼容早期明文/用户手输
  return stored;
}

/** 判断某条配置里的密码字段是否已用强加密保存 */
export function secretProtectionLevel(stored: string): 'strong' | 'weak' | 'none' {
  if (!stored) return 'none';
  if (stored.startsWith(STRONG_PREFIX)) return 'strong';
  if (stored.startsWith(WEAK_PREFIX)) return 'weak';
  return 'none';
}
