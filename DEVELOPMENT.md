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
| `src/panel.ts` | 面板：视图切换、列表渲染、色块、表单、设置、收回逻辑 |
| `src/bridge.ts` | **所有 Tauri v2 API 的唯一出口**，UI 只依赖这里的函数 |
| `src/todo-parser.ts` | `Todo.md` 的解析 / 序列化（`TodoDoc` 类）、排序策略、精选算法 |
| `src/types.ts` | `Todo` / `Section` / `AppConfig` 类型 |
| `src/styles/*.css` | 样式（含浅色/深色主题） |
| `src-tauri/tauri.conf.json` | 双窗口、透明、置顶、`macOSPrivateApi` 等配置 |
| `src-tauri/capabilities/default.json` | v2 权限（窗口控制 + 事件 + 对话框） |
| `src-tauri/src/lib.rs` | Rust 命令：读写文件、读写配置、选文件对话框、文件监听；系统托盘 |
| `scripts/make-icon.mjs` | 无依赖生成图标源 `app-icon.png` |
| `scripts/test-parser.ts` | 解析器验收用例，`npm test`（Node 原生剥离 TS，无测试框架依赖） |
| `dev-preview.html` | 开发预览页：注入 Tauri mock，在浏览器里跑真实的 `panel.ts` |

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

### 5.2 md 文件无损往返（行模型）

- 只识别 `- [ ]` / `- [x]` / `- [-]` 三态复选框行；标题、正文、空行等**原样保留**。
- 只有**被修改的行**才按 Obsidian Tasks 规范重写，尽量减小 diff。
- **保留原文件换行风格**（Windows 的 CRLF / Unix 的 LF）——`detectEol()`。
- 归一化 emoji 变体选择符 `U+FE0F` 与不间断空格 `U+00A0`，否则 emoji 匹配会残留半个字符（Tasks 文档明确的坑）。
- 元数据抽成结构化字段，序列化时按 `描述 + 优先级 + ➕ + 📅 + ✅/❌` 顺序拼回行尾。

**为什么不改成"全量序列化"**：那样代码会干净很多（解析成结构、写回时整份重新生成），
但用户在这个文件里手写的段落会被抹掉。它躺在 Obsidian vault 里，随时会被人补一段说明，
所以坚持行模型，代价是分区边界与行移动的处理更绕。

行模型下几个要小心的点：

- **类别 = `##` 分区标题**，但只有列在 frontmatter `categories` 里的标题才算数。
  解析时先建"标题 → 行号区间"索引（`Section[]`），任务归属于其上方最近的类别标题。
- 不在清单里的标题（如 `## 备注`）下的任务，`movable` 为 `false`——完成沉底之类的
  **自动行移动一律跳过它们**，免得打乱用户排版。用户显式改类别时才移动。
- **凡是移动了行，必须立刻 `parse()`**，因为所有定位都靠 `lineIndex`；UI 侧持有的旧
  `lineIndex` 同时失效，要重新取。
- `writeCategories()` 可能在文件头部插入行，导致后面所有行号整体下移。所以
  `ensureSection()` 返回"头部插入了几行"，调用方必须用它修正手里的 `lineIndex`
  （见 `moveToCategory`）。这是最容易写错的地方。
- 删类别时标题行被删掉，会留下连续空行；`collapseBlankAt()` 把它压成一个，
  否则反复增删类别空行会越积越多。

**块模型（描述与检查项加进来之后）**：一条待办在文件里占的不止一行——
任务行之下缩进更深的那一段（描述行 + `- [ ]` 检查项行）同属这条待办，
范围记在 `Todo.lineIndex ~ Todo.blockEnd`。

- `parseTodos()` 扫到一个任务行后，先算出块的范围，**块内的任务行不再各自成条**，
  而是收成父任务的 `checklist`；游标直接跳到 `blockEnd`。缩进宽度按 tab = 4 格算。
- `commit()` 是整块 splice 替换，行数会变，所以它内部直接 `parse()`；
  调用方在 commit 之后**必须重新 `get()`**，手里那个 `Todo` 对象已经过期。
- 所有落点计算用的是 `blockEnd + 1` 而不是 `lineIndex + 1`
  （`insertPositionFor` / `sinkPositionFor`），否则新条目会插进别人的子块里。
- `moveBlock()` 取代了原来的 `moveLine()`：完成沉底、改归属都得把描述和检查项一起搬走。
- 写回时块内是归一化的：描述在前、检查项在后、统一缩进四格（解析侧同时认两格与 tab）。用户手写的 `[-]` 子项
  在没被动过时原样保留。**没被编辑过的条目一个字节都不会动**，归一化只发生在写回那一刻。

### 5.2.1 有效到期：只用于排序，绝不用于判定超期

没填截止的条目，排序时按"创建 + 3 天"推导出一个 `effectiveDue`，**但这个值不写进 md**，
也不会让它变成超期。超期资格只由用户**亲手填的 `📅`** 赋予。

这条分得很死是有原因的：悬浮球鼓励随手塞，若不填截止就在三天后无条件变超期，
几个月后超期列表里九成是"有空看看某个库"这类东西——当九成条目都是红的，
红色就不再是信号。和固件里断言满天飞、最后没人看 log 是同一个失效模式。

### 5.2.2 创建日期按需补写

已有的手写 Todo.md 里一条 `➕` 都没有。**纯读取绝不改文件**；某条第一次被操作
（勾选 / 编辑 / 改优先级 / 放弃）时才补上 `➕`。副作用是补写之前，这些条目参与不了
精选第 6 条配额位的"躺得最久"比较，会被跳过。

### 5.3 精选算法与第 6 条配额位

`pickFeatured()`：前 5 条按 `优先级四档降序 → effectiveDue 升序` 取；
**第 6 条是配额位**，留给"重要（不紧急）"档里创建最早的那条，若该条已在前 5 内就取次早的，
该档为空或全在前 5 内则退回按序补位。

这个位置存在的理由：优先级是手填且**不会自动上浮**（明确否掉了时间衰减），
而"重要但不紧急"的事（学习、重构、写文档、体检）的共同特征就是不会自己变紧急，
直到出事那天。没有配额位，这一档会永久沉底，一条都进不了视野。

精选视图**不给排序开关**——排序就是它的定义，一旦可改，配额位规则就不成立了。

### 5.4 配置持久化防覆盖

`ball` 和 `panel` 两个窗口都写同一个 `settings.json`。各自写入前先 `loadConfig()` 读最新、只覆盖自己那个字段（`ballPosition` / `todoFilePath`），避免一个窗口用内存里的旧值覆盖另一个刚存的值。

### 5.5 权限 (capabilities)

`capabilities/default.json` 授予 `ball`/`panel` 两个窗口：窗口控制（show/hide/set-position/set-focus/set-always-on-top/start-dragging/outer-position/outer-size/is-visible/scale-factor/current-monitor）、事件（listen/emit）、`dialog:allow-open`。**自定义命令**（read_file 等）不需要 ACL 授权。

## 6. 开发工作流

```bash
npm install
npm run tauri:dev      # 改前端 → Vite HMR 自动刷新；改 src-tauri → 自动重编译并重启
```

- 跑解析器用例：`npm test`（`scripts/test-parser.ts`，Node 22.6+ 原生剥离 TS，没引测试框架）
- 只调面板 UI 而不想编译 Rust：`npm run dev` 后开
  <http://localhost:1420/dev-preview.html>。它注入一份最小的 Tauri mock
  （`invoke` / 事件 / 窗口 API）和样例 md，**原样加载 `src/panel.ts`**，
  右侧面板打印每次写回的完整 md。视图切换、精选、表单、设置、色块都能在这里验；
  验不了的只有真正依赖 Tauri 的那层——球的拖动置顶、面板贴球定位与 `data-side` 镜像、
  失焦收回、托盘、文件监听。
- 只校验前端构建：`npm run build`
- 只校验 Rust：`cargo build --manifest-path src-tauri/Cargo.toml`（`tauri-build` 会顺带校验 `tauri.conf.json` 和 capabilities 权限标识符是否合法）

## 7. 跨平台（Windows）

### 7.1 不能交叉编译

Tauri 只能在目标系统上打包。Windows 包必须在 Windows 机器上 `npm run tauri:build`。
环境准备见 [README](./README.md#在-windows-上构建)。

### 7.2 已经跨平台安全的部分

- `main.rs` 有 `windows_subsystem = "windows"`，发布版不弹黑控制台。
- `MacosLauncher::LaunchAgent` 名字带 Macos，但它是 autostart 插件的跨平台入参，
  Windows 侧走注册表，同一份代码可用。
- 路径分隔符一律 `[\\/]`、`detectEol()` 处理 CRLF、CSS 字体栈含 Microsoft YaHei、
  `-webkit-` 前缀在 WebView2（Chromium）上有效。
- `reveal_path` 用 `cfg(target_os)` 分派：macOS `open -R`、Windows `explorer /select,`、
  其它 `xdg-open`。

### 7.3 坐标与 DPI：唯一可信的基准是 Tauri 自己报的数

**这是本项目第二个大坑**，实测数据（MacBook 内置屏，默认缩放）：

| 来源 | 数值 |
| --- | --- |
| `system_profiler` 报告的面板分辨率 | 2560 × 1664 |
| **Tauri `availableMonitors()`** | **2940 × 1912** |
| `tauri.conf.json` 里球窗口的 width/height | 84 × 84 |
| **Tauri `outerSize()`** | **168 × 168** |

两处都不一致，原因各不相同：

- macOS HiDPI 缩放下，Tauri 的"物理像素"基准是**逻辑分辨率 × scaleFactor**
  （1470×956 × 2 = 2940×1912），**不是面板的真实像素**。
- 窗口尺寸配置写的是逻辑像素，`outerSize()` 返回物理像素。

结论：**判断"某个坐标现在还看不看得见"，必须同时用 `outerSize()` 和 `availableMonitors()`**，
两者才是同一基准。用系统报告的分辨率去推算会得出错误结论（我第一版就是这么错的），
把窗口尺寸当成配置里的值也一样错。

`ballPosition` 存的是**物理像素**。外接屏拔掉、或改了显示缩放比之后，旧坐标可能落到所有屏幕
之外——球就再也点不到，只能手动删配置文件。`ball.ts::restorePosition()` 因此在恢复前
先判断球心是否落在某块显示器内，不在就退回主屏右下角并存回新位置。
兜底位置的边距按 `scale` 折算，否则 2 倍屏上边距会缩成一半。

**Windows 上这条更要紧**：那边缩放比常见 100/125/150/175%，改缩放比 macOS 上频繁得多。

### 7.4 还没在 Windows 上验证的

- **透明 + 无边框窗口的视觉**：Windows 没有 macOS 那种原生窗口阴影，圆球边缘抗锯齿也不同。
- **托盘左键行为**：Windows 惯例是左键＝主操作、右键＝菜单；当前两个平台都是左键出菜单
  （Tauri 默认 `show_menu_on_left_click = true`）。要改就用
  `show_menu_on_left_click(false)` + `on_tray_icon_event` 接左键，
  但**必须用 `cfg(target_os = "windows")` 包起来**，别动 macOS 上已有的行为。
- **WebView2 运行时**：Win11 内置，Win10 多数已有。
- 表单里原生 `date` 控件的外观在 WebView2 上和 WKWebView 不同。

## 8. 扩展指引

- **新增待办字段**（如开始日期 `🛫`）：改 `types.ts` → `todo-parser.ts` 的 `extractMeta`/`serialize` → `panel.ts` 渲染。
- **新增一类视图**：在 `panel.ts` 的 `ViewId` 加一个 id → `currentTodos()` 里加取数分支
  → `defaultSortFor()` 给默认排序 → `renderRail()` 里加标签。
- **全库/文件夹扫描**：把单文件读取换成目录遍历（新 Rust 命令），解析多文件并在每条 `Todo` 上记录来源文件路径，以便回写到正确文件。
- **默认吸附角落**：`ball.ts` 首次启动（无保存位置时）用 `currentMonitor()` 计算右下角坐标并 `setBallPosition`。
