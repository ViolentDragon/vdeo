/**
 * 网盘品牌与接入状态。
 *
 * 状态语义（不要让 UI 把两者混在一起）：
 *   ready    —— 本应用已实现对接并且实际验证过（目前只有阿里云盘的扫码流程
 *               与本地/WebDAV）
 *   bridge   —— 本应用未直接对接，但可以经 Alist / OpenList 转成 WebDAV 使用；
 *               UI 给出可执行的桥接路径，而不是一个点了没反应的按钮
 *
 * 为什么不直接实现：这些网盘的登录态是 cookie / 私有 token，API 各家不同且
 * 需要真实账号才能验证。盲写会产出「看起来能用、一扫码就报错」的代码。
 */

export type DriveAuthKind = 'qr' | 'cookie' | 'token' | 'sson';
export type DriveStatus = 'ready' | 'bridge';

export interface CloudDriveBrand {
  id: string;
  name: string;
  /** 卡片上的图标文字（1-3 字） */
  mark: string;
  /** 图标底色 */
  color: string;
  auth: DriveAuthKind;
  authLabel: string;
  status: DriveStatus;
  /** 点击后的引导文案 */
  guide: string;
  /** 直接用本应用添加时的目标页签（仅 ready 有值） */
  targetKind?: 'aliyun' | 'webdav';
}

export const CLOUD_DRIVES: CloudDriveBrand[] = [
  {
    id: 'aliyun',
    name: '阿里云盘',
    mark: '阿',
    color: '#4a7cff',
    auth: 'qr',
    authLabel: '扫码登录',
    status: 'ready',
    guide: '用阿里云盘 App 扫码授权，确认后自动挂载。token 加密保存在本地。',
    targetKind: 'aliyun',
  },
  {
    id: '115',
    name: '115网盘',
    mark: '115',
    color: '#2f7bf6',
    auth: 'qr',
    authLabel: '扫码登录',
    status: 'bridge',
    guide:
      '115 的扫码与 cookie 登录属于私有接口，需要真实账号验证才能接入。' +
      '现在可用 Alist 挂载 115 并开启 WebDAV，再在本应用添加 WebDAV 源。',
    targetKind: 'webdav',
  },
  {
    id: 'quark',
    name: '夸克网盘',
    mark: '夸',
    color: '#8b5cf6',
    auth: 'cookie',
    authLabel: '扫码 / 粘 cookie',
    status: 'bridge',
    guide:
      '夸克使用 cookie 登录态（__pus / __puus），接口未公开且会变动。' +
      '建议用 Alist 挂载后走 WebDAV。',
    targetKind: 'webdav',
  },
  {
    id: 'uc',
    name: 'UC网盘',
    mark: 'UC',
    color: '#0ea5a4',
    auth: 'cookie',
    authLabel: '扫码 / 粘 cookie',
    status: 'bridge',
    guide: 'UC 网盘与夸克同源，同样依赖 cookie 会话。建议用 Alist 转 WebDAV。',
    targetKind: 'webdav',
  },
  {
    id: 'guangya',
    name: '光鸭云盘',
    mark: '光',
    color: '#f97316',
    auth: 'token',
    authLabel: '扫码 / 粘 token',
    status: 'bridge',
    guide: '光鸭云盘使用自有 token 接口，尚无稳定公开文档。建议用 Alist 转 WebDAV。',
    targetKind: 'webdav',
  },
  {
    id: 'tianyi',
    name: '天翼云盘',
    mark: '天',
    color: '#ef4444',
    auth: 'sson',
    authLabel: '扫码 / SSON',
    status: 'bridge',
    guide: '天翼云盘使用 SSON cookie 登录。建议用 Alist 挂载后走 WebDAV。',
    targetKind: 'webdav',
  },
  {
    id: 'pan123',
    name: '123网盘',
    mark: '123',
    color: '#22c55e',
    auth: 'token',
    authLabel: '扫码 / 粘 token',
    status: 'bridge',
    guide: '123 网盘有开放平台 token 接口，但需要注册开发者应用。可先用 Alist 转 WebDAV。',
    targetKind: 'webdav',
  },
];

/** Alist / OpenList 的接入步骤，点击桥接类网盘时展示 */
export const ALIST_BRIDGE_STEPS = [
  '部署 Alist 或 OpenList（单文件程序，双击即可运行）',
  '在 Alist 后台「存储」里添加对应网盘并完成登录授权',
  '在 Alist「设置 → 全局」里确认 WebDAV 已启用，记下端口',
  '回到本应用「添加存储源 → WebDAV」，地址填 http://127.0.0.1:5244/dav',
  '用户名密码填 Alist 的账号，保存后即可扫描该网盘',
];
