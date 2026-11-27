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
| mpv 进程管理与 IPC 控制（播放/暂停/进度/音量/音轨/字幕/倍速） | 可用 | 真实 mpv v0.42.0 集成测试：启动→加载→时长→seek→暂停 |
| 外部播放器（PotPlayer/VLC/MPC-HC/MPC-BE/自定义） | 可用 | 命令解析与启动解析 18 条单测 |
| 外部播放器 / 系统默认播放器 | 已实现，未实测 | — |
| TMDB 海报与元数据刮削 | 可用 | 电影、电视剧和动漫按作品匹配 |

## 技术选型与理由

本机环境实测：Node 26 / npm 11、**无 MSVC 与 VS Build Tools**、无 mpv、无 ffmpeg。

- **Electron 45**（内置 Node 24.22.3）而非 Tauri：Tauri 需要 Rust + MSVC，本机不可用。
- **`node:sqlite`** 而非 better-sqlite3：后者要 node-gyp 编译，本机没有编译器。已实测 Electron 45 内 `DatabaseSync` 可正常建表读写。
- **不依赖 ffmpeg**：缩略图/截帧可交给 `mpv --screenshot`（mpv 自带解码器），少分发一个二进制。
- **主进程 esbuild 打包、渲染层 Vite**：构建路径短，出错定位清楚。
- **零运行时依赖**：除 Electron 本身外没有第三方运行时库（WebDAV 的 XML 解析、文件名解析、SQLite 封装都是自己写的），避免原生模块与体积问题。

## 网盘接入方式（重要，请先读）

打开「添加存储源 → 网盘」，选择品牌卡片。阿里云盘支持在应用内扫码授权。

115网盘、夸克网盘、UC网盘、光鸭云盘、天翼云盘和123网盘通过 [OpenList WebDAV](https://doc.oplist.org/guide/advanced/webdav) 接入。先在 OpenList 添加对应驱动并完成授权，为连接账号开启「WebDAV 读取」权限。然后在对应卡片中填写 WebDAV 地址（例如 `http://127.0.0.1:5244/dav`）、网盘在服务中的挂载路径和连接账号。应用会先验证目录能否读取，再保存存储源。

其他 WebDAV 服务可通过「添加存储源 → WebDAV」接入。本地磁盘可从同一弹窗选择。

## TMDB 影视元数据

打开桌面版「设置 → 影视元数据」，输入 [TMDB API 设置](https://www.themoviedb.org/settings/api) 中的 API 读取访问令牌或 v3 API Key，点击「验证并保存」。应用在扫描成功后自动为电影、电视剧和动漫查找海报、简介与评分，也可以点击「补全现有影库」处理已入库作品。

查询使用片名、作品类型和可确定的年份。遇到同名且无法确认的候选时会跳过，优先使用库中已有的海报文件。已匹配的元数据按作品保存在本地 SQLite 中。

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

### 浏览器版

在 Windows 双击 `start-browser.cmd`，或在项目目录运行 `npm run start:browser`。脚本会构建当前页面，并在默认浏览器打开预览。预览自动使用本机可用端口，地址会显示在启动窗口中。预览期间请保持启动窗口开启。关闭窗口或按 `Ctrl+C` 可停止预览。

在浏览器版打开「添加存储源 → 网盘 → 阿里云盘」，用阿里云盘 App 扫码并确认。确认后可选择并保存扫描范围、浏览网盘文件夹。浏览器版与桌面版使用同一份存储源数据库，请使用启动窗口自动打开的页面。在本机服务运行期间，刷新同一个启动地址可以继续扫码。扫描媒体、播放以及添加其他存储源在桌面版完成。

### 一键打包和发布

在 Windows 双击 `update-release.cmd` 或运行 `npm run update`。脚本从本地和 GitHub 标签计算下一个补丁版本，验证并打包安装版与便携版，再将 Git 未忽略的工作区更改和版本文件提交到当前分支。分支与版本标签会一起推送到 `origin`。推送成功后，GitHub Actions 从该标签构建并发布 Release。

- 本地程序包在 `release/v版本号/`。只生成当前版本的本地程序包可运行 `npm run update -- --package-only`。
- 发布使用已有的 GitHub Git 凭据。首次推送包含工作流文件，需要允许修改 GitHub Actions 工作流的凭据。仓库须启用 Actions，并允许该工作流创建 Release。脚本会输出 Actions 和 Release 的地址。
- 双击 `update-release.cmd` 时，如果 GitHub 拒绝写入工作流，脚本会打开 Git Credential Manager 的 GitHub 授权页面。确认授权后会自动重试已提交的版本。遇到其他推送错误，排除问题后可重新运行同一脚本。如果 GitHub 构建或上传失败，可在 Actions 中重跑该工作流。

### 内置 mpv

`resources/mpv/mpv.exe` 随安装包分发（v0.42.0，来自 shinchiro/mpv-winbuild-cmake），**用户不需要自己装**。

探测顺序（`src/main/player/locate.ts`）：用户配置 > 内置 > PATH > 常见安装位置。内置优先于 PATH 是刻意的——避免用户机器上的旧版本盖掉随包分发的版本。

更新内置 mpv：

```bash
npm run vendor:mpv              # 下载并解压到 vendor/mpv（有缓存，可重复跑）
npm run vendor:mpv -- --force   # 强制重新下载解压
```

### 外部播放器

设置页「播放方式」三选一：

| 方式 | 行为 |
|---|---|
| 自动（默认） | 内置 mpv 优先，不可用时回落外部播放器 |
| 仅内置 mpv | 只用 mpv；不可用时**明确报错**，不静默替换 |
| 仅外部播放器 | 始终交给外部程序 |

外部播放器自动探测 PotPlayer、VLC、MPC-HC、MPC-BE、系统 mpv 的常见安装位置（`src/main/player/external.ts` 的 `EXTERNAL_PLAYER_PRESETS`），也可选「自定义…」手动指定 exe。

参数模板占位符：

| 占位符 | 含义 |
|---|---|
| `{url}` | 视频地址（本地路径或网盘直链） |
| `{title}` | 标题 |
| `{start}` | 续播起点秒数 |

带空格的路径用引号包住，例如 `--start={start} "{url}"`。命令解析是引号感知的，`"C:\Program Files\VLC\vlc.exe"` 这类路径不会被拆碎。

音频与图片始终交给外部程序，不走 mpv。

### 调试：无 DevTools 环境截图

打包后的 GUI 没有控制台与 DevTools，确认 UI 是否真的渲染靠这个开关：

```bash
NEBULA_CAPTURE=D:/shot.png NEBULA_CAPTURE_VIEW=设置 Nebula.exe
```

`NEBULA_CAPTURE_VIEW` 填侧边栏文字（如 `设置`、`电影`），截图前会先切到该页面。

主进程日志在 `%APPDATA%/Nebula/logs/main.log`。

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

- mpv 播放已在真实 mpv v0.42.0 上验证（集成测试）；但**内嵌画面未合成进应用窗口**，mpv 以自己的窗口播放。
- **内嵌视频未做窗口内合成**：mpv 以自身窗口播放（`--wid` 嵌入已预留参数），UI 控制条在主窗口底部。真正的"画面嵌进应用窗口"需要原生子窗口或 libmpv（需编译工具链）。
- 扫描为全量重扫 + `missing` 标记，未用 mtime/size 做差量跳过。
- 单源条目上限 40 万、目录深度上限 12，防误挂根目录。
