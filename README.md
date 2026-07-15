# WeaveMind 悬浮球待办

一个跨平台（Windows / macOS）的**桌面级悬浮球待办**。悬浮球常驻屏幕最顶层（类似迅雷下载球），点击弹出面板查看/编辑待办，点面板外收回。数据就是你 **Obsidian vault 里的一个 `Todo.md`**，用标准复选框 + [Obsidian Tasks](https://publish.obsidian.md/tasks/) 风格的 emoji 元数据存储 —— 所以 Obsidian 那边原生可读可写，两边实时同步。

> 它**不是** Obsidian 插件，而是一个独立的 Tauri 桌面程序。“基于 Obsidian”体现在：它读写的就是 vault 里的 md 文件，Obsidian 无需装任何插件即可看到同样的待办。

## 功能

- 🟢 透明圆形悬浮球，总在最顶层，可拖拽、记住位置
- 🖱️ 点球弹出面板；点面板外自动收回
- 📋 读取 `Todo.md`，列出待办（优先级 / 截止日期 / 标签）
- ✅ 勾选完成（自动写入完成日期 `✅`）
- ✏️ 双击文字内联编辑 · ➕ 顶部输入回车新增 · 🗑️ 悬停删除
- 🚩 点优先级角标循环切换 · 📅 点日期设置截止日
- 🔢 悬浮球角标显示未完成数量
- 🔄 监听文件变化：在 Obsidian 里改动 `Todo.md`，面板与角标**实时同步**
- 🖥️ 系统托盘菜单（显示/隐藏面板、开机自启、退出）+ 可选**开机自启动**

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18（已在 25 上验证）
- [Rust](https://www.rust-lang.org/tools/install) 工具链（`cargo` / `rustc`）
- macOS：Xcode Command Line Tools（`xcode-select --install`）
- Windows：[Microsoft C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/) + [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)（Win10/11 通常已内置）

## 开发运行

```bash
npm install
npm run tauri:dev
```

首次会编译 Rust 依赖，耗时几分钟；之后很快。启动后屏幕上出现悬浮球。

## 打包

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/`：

- macOS → `.app` / `.dmg`
- Windows → `.msi` / `.exe`（NSIS）

> ⚠️ Tauri 应用**只能在目标系统上打包**（Mac 上打 Mac 包，Windows 上打 Windows 包）。要同时出两个平台的包，用两台机器或 CI（如 GitHub Actions 的 `tauri-apps/tauri-action`）。

## 第一次使用

1. 启动后点击悬浮球 → 面板弹出。
2. 点面板里的“选择 Todo.md 文件”，选中你 Obsidian vault 里的一个 md 文件（没有就先在 Obsidian 里新建一个，如 `Todo.md`）。
3. 之后就能在面板里增删改待办，改动实时写回该文件，Obsidian 打开同一文件即可看到。

选定的文件路径记在系统配置目录：

- macOS：`~/Library/Application Support/com.weavemind.todo/settings.json`
- Windows：`%APPDATA%\com.weavemind.todo\settings.json`

## `Todo.md` 格式

用标准复选框；元数据用 Obsidian Tasks 的 emoji 语法，位置在文字之后，日期一律 `YYYY-MM-DD`：

```markdown
- [ ] 写周报 🔺 📅 2026-07-18 #工作
- [ ] 买菜 🔽 #生活
- [x] 交房租 ✅ 2026-07-14
```

| 元数据 | 写法 |
|---|---|
| 优先级 最高 / 高 / 中 / 低 / 最低 | `🔺` `⏫` `🔼` `🔽` `⏬` |
| 截止日期 | `📅 2026-07-18` |
| 完成日期（勾选时自动加） | `✅ 2026-07-14` |
| 标签 | `#工作` |

- 只有复选框行会被当成待办；其它内容（标题、正文、空行）原样保留。
- 只有被你改动的那一行才会被重写，尽量减少文件 diff。
- 会保留文件原有换行风格（Windows 的 CRLF / Unix 的 LF）。
- 兼容 Obsidian 的 **Tasks**、**Dataview** 插件。

## 项目结构

```
├── index.html / panel.html   # 悬浮球窗口 / 面板窗口
├── src/
│   ├── ball.ts               # 悬浮球：拖拽、点击、角标
│   ├── panel.ts              # 面板：列表、增删改、收回
│   ├── bridge.ts             # 封装所有 Tauri v2 调用
│   ├── todo-parser.ts        # Todo.md 解析 / 序列化
│   ├── types.ts
│   └── styles/
├── src-tauri/
│   ├── tauri.conf.json       # 双窗口 / 透明 / 置顶 配置
│   ├── capabilities/         # v2 权限
│   └── src/lib.rs            # 文件 & 配置读写命令
└── scripts/make-icon.mjs     # 生成图标源（无依赖）
```

## 已知限制 / 注意

- macOS 透明窗口用到了私有 API（`macOSPrivateApi`），因此**不能上架 Mac App Store**（个人使用无影响）。
- 极少数情况下，macOS 打包版的透明窗口可能失效（[tauri#13415](https://github.com/tauri-apps/tauri/issues/13415)）——请以打包后的实际运行为准测试。
- 当前为 MVP：只读写**单个** `Todo.md`；全库扫描、循环任务 `🔁`、开始/计划日期等尚未实现（见下方 Roadmap）。
- 退出方式：**托盘菜单 →「退出」**（无边框悬浮球本身没有关闭按钮）。

## Roadmap（可选后续）

- [x] 系统托盘菜单 + 开机自启动
- [x] 监听文件变化，Obsidian 改动时面板实时刷新
- [ ] 悬浮球默认吸附到屏幕角落
- [ ] 全库 / 指定文件夹扫描汇总
- [ ] 循环任务 `🔁`、开始/计划日期 `🛫⏳`
- [ ] 配套的 Obsidian 窗口内插件入口
