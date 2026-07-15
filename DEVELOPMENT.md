# 开发文档

面向后续维护者，讲清楚这个项目**为什么这么设计**、有哪些**非显而易见的坑**，以及**怎么加功能**。日常使用/打包请看 [README.md](./README.md)。

## 1. 架构总览

```
   ┌──────────────────────┐  toggle-panel 事件   ┌──────────────────────┐
   │  ball 窗口 (index)    │ ───────────────────► │  panel 窗口 (panel)   │
   │  透明/无边框/置顶      │ ◄─────────────────── │  透明/无边框/置顶      │
   │  常驻可见、可拖拽       │  todos-changed 事件  │  默认隐藏、点球弹出     │
   └──────────────────────┘                      └──────────┬───────────┘
                │ 读文件算角标                                │ 增删改
                └────────────┬───────────────────────────────┘
                             ▼  Rust 命令 (std::fs)
                   ┌──────────────────────┐
                   │  vault 里的 Todo.md    │  ← Obsidian 也读写同一文件
                   └──────────────────────┘
```

- **不是 Obsidian 插件**，而是独立的 Tauri v2 桌面程序。与 Obsidian 的联动 = 读写同一个 vault 内的 md 文件。
- 两个**独立窗口**（各自是一个 WebView，加载各自的 bundle）：悬浮球 `ball`、面板 `panel`。
- 前端用 **Vite + 原生 TypeScript**（无框架），保持轻量、契合 Tauri。

## 2. 目录与模块

| 路径 | 职责 |
|---|---|
| `index.html` / `panel.html` | 两个窗口的 HTML 入口（Vite 多入口） |
| `src/ball.ts` | 悬浮球：拖拽/点击判定、发 toggle 事件、未完成数量角标 |
| `src/panel.ts` | 面板：列表渲染、增删改查、收回逻辑、选文件 |
| `src/bridge.ts` | **所有 Tauri v2 API 的唯一出口**，UI 只依赖这里的函数 |
| `src/todo-parser.ts` | `Todo.md` 的解析 / 序列化（`TodoDoc` 类） |
| `src/types.ts` | `Todo` / `AppConfig` 类型 |
| `src/styles/*.css` | 样式（含浅色/深色主题） |
| `src-tauri/tauri.conf.json` | 双窗口、透明、置顶、`macOSPrivateApi` 等配置 |
| `src-tauri/capabilities/default.json` | v2 权限（窗口控制 + 事件 + 对话框） |
| `src-tauri/src/lib.rs` | Rust 命令：读写文件、读写配置、选文件对话框 |
| `scripts/make-icon.mjs` | 无依赖生成图标源 `app-icon.png` |

## 3. 运行时数据流

- **球 → 面板**：全局事件 `toggle-panel`，附带球的物理坐标/尺寸/缩放，面板据此计算自身位置。
- **面板 → 球**：全局事件 `todos-changed`（未完成数量），球更新角标。
- **面板 ↔ 文件**：Rust 命令 `read_file` / `write_file`（`std::fs`）。**关键**：自定义命令不受 fs 插件的路径 scope 限制，因此能读写用户在任意位置选的 vault 文件。
- **配置**：Rust 命令 `load_config` / `save_config` → 系统 app config 目录下的 `settings.json`。

## 4. 窗口模型与交互

- `ball`：`visible:true`、`transparent`、`decorations:false`、`alwaysOnTop`、`skipTaskbar`、`shadow:false`。
- `panel`：同上但 `visible:false`，启动即创建、按需显示。
- **点击 vs 拖拽**（`ball.ts`）：`mousedown` 记起点；移动超过阈值 → `startDragging()` 交给系统拖拽；否则 `mouseup` 视为点击 → 发 toggle 事件。拖动位置用 `onMoved` 防抖保存。
- **点面板外收回**（`panel.ts`）：监听面板窗口失焦（`tauri://blur` / `onFocusChanged`），延迟 140ms 收回；若期间收到 toggle（点了球）则取消，避免"点球关闭"时闪烁。

## 5. 关键设计决策 / 踩坑记录

### 5.1 macOS 原生文件对话框（本项目最大的坑）

在「透明 + 无边框 + `alwaysOnTop`」窗口下选文件，踩了两轮：

1. **JS `@tauri-apps/plugin-dialog` 的 `open()`**：对话框被置顶窗口挡在后面，且 promise 迟迟不 resolve → 表现为"点了设置没反应"。
2. **Rust `blocking_pick_file()`**：直接让 app 崩溃退出——它会在非主线程跑 `NSOpenPanel`，macOS AppKit 直接 abort。

**最终方案**（见 `lib.rs::pick_todo_file` + `panel.ts::pickFile`）：
- Rust **异步命令 + 非阻塞 `pick_file(callback)` + `oneshot` 通道**：对话框在主线程弹出，命令在异步任务里等回调结果，全程不阻塞主线程。
- 打开对话框**前临时 `setAlwaysOnTop(false)`**、结束后恢复，确保对话框能出现在最前。
- 用 `dialogOpen` 标志防止对话框开着时重复触发。

> 教训：在这类特殊窗口里，任何"native 模态/阻塞"调用都要非常小心线程与层级；优先用异步回调。

### 5.2 md 文件无损往返

- 只识别 `- [ ]` / `- [x]` 复选框行；标题、正文、空行等**原样保留**。
- 只有**被修改的行**才按 Obsidian Tasks 规范重写，尽量减小 diff。
- **保留原文件换行风格**（Windows 的 CRLF / Unix 的 LF）——`detectEol()`。
- 归一化 emoji 变体选择符 `U+FE0F` 与不间断空格 `U+00A0`，否则 emoji 匹配会残留半个字符（Tasks 文档明确的坑）。
- 优先级/截止/完成日期抽成结构化字段，序列化时按 `描述 + 🔺 + 📅 + ✅` 顺序拼回行尾。

### 5.3 配置持久化防覆盖

`ball` 和 `panel` 两个窗口都写同一个 `settings.json`。各自写入前先 `loadConfig()` 读最新、只覆盖自己那个字段（`ballPosition` / `todoFilePath`），避免一个窗口用内存里的旧值覆盖另一个刚存的值。

### 5.4 权限 (capabilities)

`capabilities/default.json` 授予 `ball`/`panel` 两个窗口：窗口控制（show/hide/set-position/set-focus/set-always-on-top/start-dragging/outer-position/outer-size/is-visible/scale-factor/current-monitor）、事件（listen/emit）、`dialog:allow-open`。**自定义命令**（read_file 等）不需要 ACL 授权。

## 6. 开发工作流

```bash
npm install
npm run tauri:dev      # 改前端 → Vite HMR 自动刷新；改 src-tauri → 自动重编译并重启
```

- 只校验前端构建：`npm run build`
- 只校验 Rust：`cargo build --manifest-path src-tauri/Cargo.toml`（`tauri-build` 会顺带校验 `tauri.conf.json` 和 capabilities 权限标识符是否合法）

## 7. 扩展指引

- **新增待办字段**（如开始日期 `🛫`）：改 `types.ts` → `todo-parser.ts` 的 `extractMeta`/`serialize` → `panel.ts` 渲染。
- **系统托盘 + 开机自启**：用 Tauri tray API + `tauri-plugin-autostart`。
- **文件变化实时刷新**：Rust 侧用 `notify` 监听文件，变化时 `emit` 事件给面板重新读取（当前是每次打开面板才读）。
- **全库/文件夹扫描**：把单文件读取换成目录遍历（新 Rust 命令），解析多文件并在每条 `Todo` 上记录来源文件路径，以便回写到正确文件。
- **默认吸附角落**：`ball.ts` 首次启动（无保存位置时）用 `currentMonitor()` 计算右下角坐标并 `setBallPosition`。
