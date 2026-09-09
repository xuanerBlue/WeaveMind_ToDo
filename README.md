# WeaveMind 悬浮球待办

一个跨平台（Windows / macOS）的**桌面级悬浮球待办**。悬浮球常驻屏幕最顶层（类似迅雷下载球），点击弹出面板查看/编辑待办，点面板外收回。数据就是你 **Obsidian vault 里的一个 `Todo.md`**，用标准复选框 + [Obsidian Tasks](https://publish.obsidian.md/tasks/) 风格的 emoji 元数据存储 —— 所以 Obsidian 那边原生可读可写，两边实时同步。

界面上不出现 emoji：优先级、日期、类别一律渲染成**文字色块**，emoji 只是 md 的存储编码。

> 它**不是** Obsidian 插件，而是一个独立的 Tauri 桌面程序。“基于 Obsidian”体现在：它读写的就是 vault 里的 md 文件，Obsidian 无需装任何插件即可看到同样的待办。

## 功能

**视图**

- 🎯 **精选**：全局算出最该干的六条。前 5 条按 优先级 → 到期 排；**第 6 条是配额位**，留给"重要但不紧急"档里躺得最久的那条，防止这一档永久沉底
- 🔥 **超期**：只收你**亲手填过截止日期**且已过期的条目——随手记的东西不会污染这个列表，所以红色始终是个有效信号
- 📦 **归档**：已完成与已放弃的全部条目，默认按结束日期倒序
- 🗂️ **类别**：一条待办只属一个类别，在 md 里就是 `##` 分区标题

**操作**

- ✅ 勾选完成 · ✕ 一键"我不做了"（留痕不删除，无确认弹窗）
- 📝 新建/编辑共用一个表单：标题、四档优先级、截止日期、类别
- ↕️ 排序角标：优先级 / 创建时间 / 截止时间 / 超期时长（精选视图不给排序——排序就是它的定义）
- ⚙️ 设置里管理类别：新增 / 改名 / 删除（删除时底下的任务移到"默认"，不销毁）

**窗口**

- 🟢 透明圆形悬浮球，总在最顶层，可拖拽、记住位置
- 🖱️ 点球弹出面板；点面板外 / 再点球 / Esc 三种方式收回
- ↔️ 侧边文本标签条**始终摆在背离悬浮球的一侧**（球在屏幕右边就靠左，在左边就靠右）
- 🔢 悬浮球角标显示未完成总数（不含已完成与已放弃，不分类别）
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
4. 点面板右上角 ⚙ 进设置，可以建自己的类别（名字 ≤ 4 个字，受标签条宽度限制）。

选定的文件路径记在系统配置目录：

- macOS：`~/Library/Application Support/com.weavemind.todo/settings.json`
- Windows：`%APPDATA%\com.weavemind.todo\settings.json`

## `Todo.md` 格式

```markdown
---
categories: [默认, 工作, 生活]
---

- [ ] 想想那个方案 ➕ 2026-07-15
- [x] 装一下新固件 ➕ 2026-07-10 ✅ 2026-07-14
- [-] 研究一下那个新库 ➕ 2026-07-01 ❌ 2026-07-15

## 工作

- [ ] 写周报 🔺 ➕ 2026-07-15 📅 2026-07-18
- [ ] 回复客户邮件 ⏫ ➕ 2026-07-15
```

完整示例见 [Todo.example.md](./Todo.example.md)。

| 元素 | 写法 |
|---|---|
| 状态：未做 / 已完成 / 已放弃 | `- [ ]` / `- [x]` / `- [-]` |
| 优先级：重要且紧急 / 紧急 / 重要 / 一般 | `🔺` / `⏫` / `🔼` / 不写 |
| 创建日期（App 自动写） | `➕ 2026-07-15` |
| 截止日期（只有手填才有） | `📅 2026-07-18` |
| 完成 / 放弃日期（自动写） | `✅ 2026-07-14` / `❌ 2026-07-15` |
| 类别 | `## 分区标题` + frontmatter 的 `categories` |

几条要点：

- **类别 = 分区标题**，且必须列在 frontmatter 的 `categories` 里。没列进去的标题（比如"## 备注"）下的条目归"默认"类别参与展示，但**不会被自动挪动**，你自己的排版不受影响。
- 每个分区内，**未完成的在上，完成和放弃的沉在下面**。
- **`📅` 只有你手填才会出现**，因此它同时就是"有超期资格"的标记。没填截止的条目，App 内部按"创建 + 3 天"给它算排序位置，但这个推导值**不写进文件**，也永远不会让它变成超期。
- 没有 `➕` 的老条目（比如你原来手写的 Todo.md）：**纯读取不会改文件**，等它第一次被你操作时才补上创建日期。
- 只有复选框行会被当成待办；其它内容（标题、正文、空行）原样保留，且只有被改动的那一行才会重写。
- 会保留文件原有换行风格（Windows 的 CRLF / Unix 的 LF）。
- 兼容 Obsidian 的 **Tasks**、**Dataview** 插件。

## 项目结构

```
├── index.html / panel.html   # 悬浮球窗口 / 面板窗口
├── dev-preview.html          # 开发预览页：注入 Tauri mock，浏览器里直接跑面板逻辑
├── src/
│   ├── ball.ts               # 悬浮球：拖拽、点击、角标
│   ├── panel.ts              # 面板：视图、列表、表单、设置
│   ├── bridge.ts             # 封装所有 Tauri v2 调用
│   ├── todo-parser.ts        # Todo.md 解析 / 序列化 / 排序 / 精选算法
│   ├── types.ts
│   └── styles/
├── src-tauri/
│   ├── tauri.conf.json       # 双窗口 / 透明 / 置顶 配置
│   ├── capabilities/         # v2 权限
│   └── src/lib.rs            # 文件 & 配置读写、文件监听、托盘
├── scripts/
│   ├── test-parser.ts        # 解析器验收用例（npm test）
│   └── make-icon.mjs         # 生成图标源（无依赖）
├── 需求.md                    # 需求定稿：决策及其理由
└── 修改计划.md                # 改造计划与进度
```

跑测试：

```bash
npm test
```

## 已知限制 / 注意

- macOS 透明窗口用到了私有 API（`macOSPrivateApi`），因此**不能上架 Mac App Store**（个人使用无影响）。
- 极少数情况下，macOS 打包版的透明窗口可能失效（[tauri#13415](https://github.com/tauri-apps/tauri/issues/13415)）——请以打包后的实际运行为准测试。
- 只读写**单个** `Todo.md`；全库扫描、循环任务 `🔁`、开始/计划日期等尚未实现（见下方 Roadmap）。
- 一条待办只能属于一个类别，没有层级类别，也没有多标签——这是为了让"分区标题即类别"这种人可读的 md 结构成立。
- 不提供删除，只有"我不做了"。删除会在文件里留个洞，与"md 保留全部记录"冲突。
- 退出方式：**托盘菜单 →「退出」**（无边框悬浮球本身没有关闭按钮）。

## Roadmap（可选后续）

- [x] 系统托盘菜单 + 开机自启动
- [x] 监听文件变化，Obsidian 改动时面板实时刷新
- [x] 类别、四类视图、精选算法、文字色块、表单、设置
- [ ] 悬浮球默认吸附到屏幕角落
- [ ] 全库 / 指定文件夹扫描汇总
- [ ] 循环任务 `🔁`、开始/计划日期 `🛫⏳`
- [ ] 配套的 Obsidian 窗口内插件入口
