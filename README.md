# Nebula · 星云影库

桌面媒体库与播放器：扫描网盘/本地媒体，自动归类为电影、电视剧、动漫、音乐、照片，用 mpv 播放。

参考 Emby / Jellyfin / BoxPlayer 的信息架构（侧边栏分区 → 海报墙 → 剧集详情 → 底部播放条），但完全本地运行、无服务端。

## 当前状态

已跑通并可运行的部分：

| 能力 | 状态 | 证据 |
|---|---|---|
| Electron 应用启动、窗口与 UI 渲染 | 可用 | 实际启动并截图确认渲染无白屏 |
| SQLite 库（`node:sqlite`，零原生编译） | 可用 | 表结构创建、`user_version=1` |
| 本地目录源：递归扫描 + 增量更新 | 可用 | 端到端测试：真实文件系统 → 入库 → 分区 |
| WebDAV 源（PROPFIND 解析、Basic 认证） | 可用 | XML 解析单测（含中文百分号编码、命名空间大小写） |
| 文件名解析归类（电影/剧集/动漫/季集/技术标签） | 可用 | 13 条单测 |
| 剧集按剧名聚合、季/集排序 | 可用 | 端到端测试 |
| 播放进度记录 / 继续观看 | 可用 | 单测 |
| mpv 进程管理与 IPC 控制（播放/暂停/进度/音量/音轨/字幕/倍速） | 已实现，**未在真实 mpv 上验证** | 本机未安装 mpv |
| 外部播放器 / 系统默认播放器 | 已实现，未实测 | — |
| 海报/元数据刮削（TMDB 等） | **未实现** | 当前海报位为占位渐变 |

## 技术选型与理由

本机环境实测：Node 26 / npm 11、**无 MSVC 与 VS Build Tools**、无 mpv、无 ffmpeg。

- **Electron 45**（内置 Node 24.22.3）而非 Tauri：Tauri 需要 Rust + MSVC，本机不可用。
- **`node:sqlite`** 而非 better-sqlite3：后者要 node-gyp 编译，本机没有编译器。已实测 Electron 45 内 `DatabaseSync` 可正常建表读写。
- **不依赖 ffmpeg**：缩略图/截帧可交给 `mpv --screenshot`（mpv 自带解码器），少分发一个二进制。
- **主进程 esbuild 打包、渲染层 Vite**：构建路径短，出错定位清楚。
- **零运行时依赖**：除 Electron 本身外没有第三方运行时库（WebDAV 的 XML 解析、文件名解析、SQLite 封装都是自己写的），避免原生模块与体积问题。

## 网盘接入方式（重要，请先读）

内置的是一等公民 **WebDAV 客户端** + 本地目录。这是刻意的：

**Alist / OpenList 可以把百度网盘、阿里云盘、夸克、115、OneDrive、Google Drive、PikPak 等统一挂载成 WebDAV。**
因此在本应用「添加存储源 → WebDAV」里填入 Alist 的地址与账号，就能一次性接入这些网盘。

阿里云盘 / 百度网盘的官方 API 直连需要开发者应用审核与 OAuth 回调，当前版本**没有**内置。选择这些类型时会得到明确提示，而不是一个假装能用的按钮。

## 运行

```bash
cd nebula
npm install                     # 若 electron 二进制未自动下载：
                                # cd node_modules/electron && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
npm run dev                     # 开发（Vite HMR + 主进程热重启）
npm run build && npm start      # 生产构建并启动
npm test                        # 单元 + 端到端测试（node:test + tsx）
npm run typecheck               # 主进程与渲染层分别做类型检查
```

数据位置：`%APPDATA%/Nebula/nebula.db`（SQLite，与会话/缓存同目录）。

### mpv

播放依赖 [mpv](https://mpv.io)。安装方式任选：`choco install mpv`，或下载便携版后在「设置」里指定 `mpv.exe` 路径，或放进 PATH。

未找到 mpv 时应用仍可运行：会降级到「外部播放器」，或用系统默认程序打开文件。

## 目录结构

```
src/
├─ main/                        主进程（Node）
│  ├─ index.ts                  窗口、IPC 路由、播放编排
│  ├─ db/                       node:sqlite 封装 + schema + repo
│  ├─ sources/                  provider 抽象、local、webdav、凭据加密
│  ├─ scan/                     namer（文件名解析）、scanner（BFS 扫描）
│  └─ player/                   mpv 控制器（IPC 命名管道）、mpv 探测
├─ preload/index.ts             contextBridge 暴露 invoke/on
├─ shared/                      类型与 IPC 契约（两端共享）
└─ renderer/                    React UI
test/                           node:test 单测与端到端测试
```

### 关于密码

WebDAV 密码用 Electron `safeStorage` 加密后落库（Windows 走 DPAPI，绑定当前用户账户），前缀 `enc:v1:`。若系统不支持加密，会退化为 `obf:v1:` 前缀的混淆编码并在类型上可区分——不把弱保护伪装成强保护。

## 已知限制

- **mpv 播放未在真实 mpv 上验证**：本机无 mpv 二进制，IPC 协议按 mpv 规范实现，需装 mpv 后实测。
- **内嵌视频未做窗口内合成**：mpv 以自身窗口播放（`--wid` 嵌入已预留参数），UI 控制条在主窗口底部。真正的"画面嵌进应用窗口"需要原生子窗口或 libmpv（需编译工具链）。
- 无海报刮削、无演员/简介元数据。
- 扫描为全量重扫 + `missing` 标记，未用 mtime/size 做差量跳过。
- 单源条目上限 40 万、目录深度上限 12，防误挂根目录。
