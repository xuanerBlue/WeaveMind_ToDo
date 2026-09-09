import "./styles/panel.css";
import {
  TodoDoc,
  DEFAULT_CATEGORY,
  PRIORITY_EMOJI,
  pickFeatured,
  sortTodos,
  isOverdue,
  overdueDays,
  todayStr,
  type SortKey,
} from "./todo-parser";
import type { AppConfig, Priority, Todo } from "./types";
import * as bridge from "./bridge";

// ------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------
// 视图 id："featured" | "overdue" | "archive" | "cat:<类别名>"
type ViewId = string;

const V_FEATURED = "featured";
const V_OVERDUE = "overdue";
const V_ARCHIVE = "archive";
const CAT_PREFIX = "cat:";

const VIEW_LABEL: Record<string, string> = {
  [V_FEATURED]: "精选",
  [V_OVERDUE]: "超期",
  [V_ARCHIVE]: "归档",
};

// 界面一律用文字，不出现 emoji；emoji 只是 md 的存储编码
const PRIORITY_LABEL: Record<Priority, string> = {
  highest: "重要且紧急",
  high: "紧急",
  medium: "重要",
  none: "一般",
  low: "低",
  lowest: "低",
};

const PRIORITY_CLASS: Record<Priority, string> = {
  highest: "p-highest",
  high: "p-high",
  medium: "p-medium",
  none: "p-low",
  low: "p-low",
  lowest: "p-low",
};

// 表单里可选的四档（low / lowest 只读，不给选）
const PRIORITY_CHOICES: Priority[] = ["highest", "high", "medium", "none"];

const SORT_LABEL: Record<SortKey, string> = {
  priority: "按优先级",
  created: "按创建时间",
  due: "按截止时间",
  overdue: "按超期时长",
  finished: "按结束时间",
};

const CAT_NAME_MAX = 4; // 类别名长度上限，受标签条宽度约束

// 新建文件时写入的骨架，保证在 Obsidian 里打开也是一份正常的 md
const FILE_SKELETON = `---\ncategories: [${DEFAULT_CATEGORY}]\n---\n`;

// ------------------------------------------------------------------
// 状态
// ------------------------------------------------------------------
let config: AppConfig = { todoFilePath: null };
let doc: TodoDoc | null = null;
let view: ViewId = V_FEATURED;
let sortKey: SortKey | null = null; // null = 用该视图的默认排序
let dialogOpen = false; // 原生文件对话框打开期间，禁止因失焦收回面板
let watchedPath: string | null = null;
let ignoreWatchUntil = 0; // 自己写入后短时间内忽略文件变化事件（避免回声）
let watchReloadTimer: number | null = null;

// 表单状态。editLine 为 null 表示新建；snapshot 用于检测条目是否被外部改掉
let modalOpen = false;
let editLine: number | null = null;
let editSnapshot = "";
let formPriority: Priority = "none";
let formCategory: string = DEFAULT_CATEGORY;
let extraCategories: string[] = []; // 表单里新建、尚未落盘的类别

// 设置面板状态。pendingDelete 记录哪个类别正处在"再点一次才真删"的状态
let settingsOpen = false;
let pendingDelete: string | null = null;

const shellEl = document.getElementById("shell")!;
const railEl = document.getElementById("rail")!;
const listEl = document.getElementById("list")!;
const countEl = document.getElementById("count")!;
const titleEl = document.getElementById("view-title")!;
const footerEl = document.getElementById("footer")!;
const sortBtn = document.getElementById("sort") as HTMLButtonElement;
const addBtn = document.getElementById("add") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings")!;
const sortMenu = document.getElementById("sort-menu")!;
const modalEl = document.getElementById("modal")!;
const fTitle = document.getElementById("f-title") as HTMLInputElement;
const fPrio = document.getElementById("f-prio")!;
const fDue = document.getElementById("f-due") as HTMLInputElement;
const fDueClear = document.getElementById("f-due-clear")!;
const fCat = document.getElementById("f-cat")!;
const fHint = document.getElementById("f-hint")!;
const fCancel = document.getElementById("f-cancel")!;
const fSave = document.getElementById("f-save")!;
const settingsModal = document.getElementById("settings-modal")!;
const sPath = document.getElementById("s-path")!;
const sPick = document.getElementById("s-pick")!;
const sReveal = document.getElementById("s-reveal")!;
const sCats = document.getElementById("s-cats")!;
const sHint = document.getElementById("s-hint")!;
const sClose = document.getElementById("s-close")!;

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 路径太长时只留最后两段，保住文件名那一端。 */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 类别色块的色相由名字派生，用户不用挑颜色。 */
function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function mdDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function categoryList(): string[] {
  const base = doc ? doc.categories : [DEFAULT_CATEGORY];
  return [...base, ...extraCategories.filter((c) => !base.includes(c))];
}

// ------------------------------------------------------------------
// 读写文件
// ------------------------------------------------------------------
async function reload(): Promise<void> {
  if (!config.todoFilePath) {
    renderSetup();
    return;
  }
  try {
    await ensureWatching();
    const content = await bridge.readTodoFile(config.todoFilePath);
    doc = new TodoDoc(content);
    render();
    await emitCount();
  } catch (e) {
    renderMessage(`读取文件失败：${String(e)}`, true);
  }
}

async function ensureWatching(): Promise<void> {
  if (config.todoFilePath && config.todoFilePath !== watchedPath) {
    try {
      await bridge.watchFile(config.todoFilePath);
      watchedPath = config.todoFilePath;
    } catch {
      /* 监听失败不影响主流程 */
    }
  }
}

// 球上的数字：未完成总数，不含已完成与已放弃，不分类别
async function emitCount(): Promise<void> {
  if (!doc) return;
  await bridge.emitTodosChanged(doc.todos.filter((t) => t.status === "open").length);
}

async function persist(): Promise<void> {
  if (!doc || !config.todoFilePath) return;
  try {
    ignoreWatchUntil = Date.now() + 800;
    await bridge.writeTodoFile(config.todoFilePath, doc.toString());
    await emitCount();
  } catch (e) {
    renderMessage(`写入文件失败：${String(e)}`, true);
  }
}

// ------------------------------------------------------------------
// 视图取数
// ------------------------------------------------------------------
function isCategoryView(v: ViewId): boolean {
  return v.startsWith(CAT_PREFIX);
}

function viewCategory(v: ViewId): string {
  return v.slice(CAT_PREFIX.length);
}

function defaultSortFor(v: ViewId): SortKey {
  if (v === V_OVERDUE) return "overdue";
  if (v === V_ARCHIVE) return "finished";
  return "priority";
}

function currentTodos(): Todo[] {
  if (!doc) return [];
  const today = todayStr();
  const all = doc.todos;
  const key = sortKey ?? defaultSortFor(view);

  if (view === V_FEATURED) return pickFeatured(all, today);
  if (view === V_OVERDUE) return sortTodos(all.filter((t) => isOverdue(t, today)), key, today);
  if (view === V_ARCHIVE) return sortTodos(all.filter((t) => t.status !== "open"), key, today);
  if (isCategoryView(view)) {
    const cat = viewCategory(view);
    return sortTodos(all.filter((t) => t.status === "open" && t.category === cat), key, today);
  }
  return [];
}

/** 精选视图的顺序就是它的定义，不给排序开关。 */
function sortableView(): boolean {
  return view !== V_FEATURED;
}

// ------------------------------------------------------------------
// 渲染
// ------------------------------------------------------------------
function render(): void {
  if (!doc) return;
  renderRail();
  renderHeader();
  renderList();
  renderFooter();
}

function renderRail(): void {
  railEl.innerHTML = "";
  if (!doc) return;
  const today = todayStr();
  const overdueCount = doc.todos.filter((t) => isOverdue(t, today)).length;

  const mk = (id: ViewId, label: string, badge = 0): HTMLElement => {
    const b = el("button", "rail-item" + (view === id ? " active" : ""), label);
    b.title = label;
    if (badge > 0) {
      const dot = el("span", "dot", badge > 99 ? "99+" : String(badge));
      b.appendChild(dot);
    }
    b.addEventListener("click", () => {
      view = id;
      sortKey = null; // 换视图时回到该视图的默认排序
      render();
    });
    return b;
  };

  // 上区：视图
  railEl.appendChild(mk(V_FEATURED, VIEW_LABEL[V_FEATURED]));
  railEl.appendChild(mk(V_OVERDUE, VIEW_LABEL[V_OVERDUE], overdueCount));
  railEl.appendChild(mk(V_ARCHIVE, VIEW_LABEL[V_ARCHIVE]));
  railEl.appendChild(el("div", "rail-sep"));

  // 下区：类别
  for (const c of doc.categories) railEl.appendChild(mk(CAT_PREFIX + c, c));
}

function renderHeader(): void {
  const label = isCategoryView(view) ? viewCategory(view) : VIEW_LABEL[view];
  titleEl.textContent = label;
  const n = currentTodos().length;
  countEl.textContent = n ? `${n} 条` : "";
  sortBtn.hidden = !sortableView();
}

function renderList(): void {
  listEl.innerHTML = "";
  const todos = currentTodos();
  if (todos.length === 0) {
    renderMessage(emptyHint());
    return;
  }
  for (const t of todos) listEl.appendChild(renderItem(t));
}

function emptyHint(): string {
  if (view === V_OVERDUE) return "没有超期的事。\n只有你亲手填过截止日期的条目才会出现在这里。";
  if (view === V_ARCHIVE) return "还没有已完成或已放弃的条目。";
  if (view === V_FEATURED) return "没有待办了 🎉";
  return "这个类别下还没有待办。";
}

function renderItem(t: Todo): HTMLElement {
  const today = todayStr();
  const item = el("div", "item" + (t.status !== "open" ? ` finished ${t.status}` : ""));

  // 勾选框 = 完成
  const check = el("div", "check");
  check.title = t.status === "done" ? "标记为未完成" : "标记为完成";
  check.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  check.addEventListener("click", async (e) => {
    e.stopPropagation();
    doc!.toggle(t.lineIndex, today);
    await persist();
    render();
  });
  item.appendChild(check);

  // 正文 + 色块。点条目打开表单编辑
  const body = el("div", "body");
  body.appendChild(el("div", "desc", t.description || "(空)"));

  const meta = el("div", "meta");

  // 优先级：一般不显示色块，行才干净
  if (t.priority !== "none") {
    meta.appendChild(el("span", `tag ${PRIORITY_CLASS[t.priority]}`, PRIORITY_LABEL[t.priority]));
  }

  // 日期
  if (t.status === "open" && t.due) {
    if (isOverdue(t, today)) {
      meta.appendChild(el("span", "tag date overdue", `超期 ${overdueDays(t, today)} 天`));
    } else {
      const d = overdueDays(t, today); // 负数表示还剩几天
      const text = d === 0 ? "今天截止" : `${mdDay(t.due)}截止`;
      meta.appendChild(el("span", "tag date", text));
    }
  } else if (t.status === "done" && t.done) {
    meta.appendChild(el("span", "tag date", `${mdDay(t.done)}完成`));
  } else if (t.status === "cancelled" && t.cancelled) {
    meta.appendChild(el("span", "tag date", `${mdDay(t.cancelled)}放弃`));
  }

  // 类别：只在跨类别视图里显示，类别视图里是多余的
  if (!isCategoryView(view)) {
    const cat = el("span", "tag cat", t.category);
    cat.style.setProperty("--h", String(hueOf(t.category)));
    meta.appendChild(cat);
  }

  body.appendChild(meta);
  body.addEventListener("click", () => openForm(t));
  item.appendChild(body);

  // × = 我不做了。点一下即刻生效，不弹确认——排水口不能有摩擦
  if (t.status === "open") {
    const del = el("button", "del", "✕");
    del.title = "我不做了";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      doc!.cancel(t.lineIndex, today);
      await persist();
      render();
    });
    item.appendChild(del);
  }

  return item;
}

function renderMessage(msg: string, isError = false): void {
  const box = el("div", "empty");
  const p = el("div");
  p.style.whiteSpace = "pre-line";
  p.textContent = msg;
  if (isError) p.style.color = "var(--danger)";
  box.appendChild(p);
  listEl.appendChild(box);
}

function renderFooter(): void {
  footerEl.innerHTML = "";
  const path = el("span", "path");
  path.textContent = config.todoFilePath ? `📄 ${fileName(config.todoFilePath)}` : "未选择文件";
  path.title = config.todoFilePath || "点击选择 Todo.md 文件";
  path.addEventListener("click", () => void chooseFile("open"));
  footerEl.appendChild(path);
}

function renderSetup(): void {
  railEl.innerHTML = "";
  listEl.innerHTML = "";
  countEl.textContent = "";
  titleEl.textContent = "待办";
  sortBtn.hidden = true;

  const box = el("div", "setup");
  box.appendChild(el("div", "setup-title", "待办记在哪个 md 文件里？"));

  const primary = el("button", "btn", "用默认位置");
  primary.addEventListener("click", () => void useDefaultFile());
  box.appendChild(primary);
  box.appendChild(
    el(
      "div",
      "setup-hint",
      "放在软件的数据目录里。更新软件不会碰它，也不容易误删；路径随时能在设置里看到，以后想搬走就拷一个文件。",
    ),
  );

  box.appendChild(el("div", "setup-sep"));

  const row = el("div", "setup-row");
  const pick = el("button", "btn ghost", "选择已有的");
  pick.addEventListener("click", () => void chooseFile("open"));
  const create = el("button", "btn ghost", "新建到别处");
  create.addEventListener("click", () => void chooseFile("create"));
  row.appendChild(pick);
  row.appendChild(create);
  box.appendChild(row);
  box.appendChild(
    el("div", "setup-hint", "想接进自己的 Obsidian vault 就走这两个，文件叫什么名字随你。"),
  );

  listEl.appendChild(box);
  renderFooter();
}

/** 记下选定的文件并重新加载。 */
async function setTodoPath(path: string): Promise<void> {
  const latest = await bridge.loadConfig();
  latest.todoFilePath = path;
  await bridge.saveConfig(latest);
  config = latest;
  await reload();
  if (settingsOpen) renderSettings();
}

/** 文件不存在或为空时，写入骨架，避免用户打开是一片空白。 */
async function ensureSkeleton(path: string): Promise<void> {
  const existing = await bridge.readTodoFile(path);
  if (!existing.trim()) await bridge.writeTodoFile(path, FILE_SKELETON);
}

async function useDefaultFile(): Promise<void> {
  try {
    const path = await bridge.getDefaultTodoPath();
    await ensureSkeleton(path);
    await setTodoPath(path);
  } catch (e) {
    renderMessage(`创建默认文件失败：${String(e)}`, true);
  }
}

// ------------------------------------------------------------------
// 排序菜单
// ------------------------------------------------------------------
function sortChoices(): SortKey[] {
  if (view === V_ARCHIVE) return ["finished", "priority", "created", "due"];
  if (view === V_OVERDUE) return ["overdue", "priority", "created", "due"];
  return ["priority", "created", "due", "overdue"];
}

function toggleSortMenu(): void {
  if (!sortMenu.hidden) {
    sortMenu.hidden = true;
    return;
  }
  sortMenu.innerHTML = "";
  const active = sortKey ?? defaultSortFor(view);
  for (const k of sortChoices()) {
    const b = el("button", k === active ? "on" : undefined, SORT_LABEL[k]);
    b.addEventListener("click", () => {
      sortKey = k;
      sortMenu.hidden = true;
      render();
    });
    sortMenu.appendChild(b);
  }
  const r = sortBtn.getBoundingClientRect();
  sortMenu.hidden = false;
  sortMenu.style.top = `${r.bottom + 4}px`;
  sortMenu.style.left = `${Math.max(8, r.right - sortMenu.offsetWidth)}px`;
}

// ------------------------------------------------------------------
// 表单：新建与编辑共用
// ------------------------------------------------------------------
function openForm(t: Todo | null): void {
  if (!doc) return;
  modalOpen = true;
  editLine = t ? t.lineIndex : null;
  editSnapshot = t ? t.description : "";
  formPriority = t ? t.priority : "none";
  formCategory = t ? t.category : isCategoryView(view) ? viewCategory(view) : DEFAULT_CATEGORY;
  extraCategories = [];

  fTitle.value = t ? t.description : "";
  fDue.value = t?.due ?? "";
  fHint.textContent = "";
  renderFormOptions();
  modalEl.hidden = false;
  setTimeout(() => fTitle.focus(), 0);
}

function closeForm(): void {
  modalOpen = false;
  modalEl.hidden = true;
  editLine = null;
  extraCategories = [];
}

function renderFormOptions(): void {
  // 优先级：四档色块
  fPrio.innerHTML = "";
  for (const p of PRIORITY_CHOICES) {
    const b = el("span", `tag ${PRIORITY_CLASS[p]}${formPriority === p ? " on" : ""}`, PRIORITY_LABEL[p]);
    b.addEventListener("click", () => {
      formPriority = p;
      renderFormOptions();
    });
    fPrio.appendChild(b);
  }
  // 已有文件里读到的 low / lowest 是只读档，选中时也要显示出来
  if (formPriority === "low" || formPriority === "lowest") {
    const b = el("span", "tag p-low on", "低");
    b.title = "来自 md 里的 🔽 / ⏬，改成上面四档之一后不再出现";
    fPrio.appendChild(b);
  }

  // 类别：色块单选 + 新建
  fCat.innerHTML = "";
  for (const c of categoryList()) {
    const b = el("span", `tag cat${formCategory === c ? " on" : ""}`, c);
    b.style.setProperty("--h", String(hueOf(c)));
    b.addEventListener("click", () => {
      formCategory = c;
      renderFormOptions();
    });
    fCat.appendChild(b);
  }
  const add = el("button", "mini", "＋ 新类别");
  add.addEventListener("click", () => promptNewCategory(add));
  fCat.appendChild(add);
}

function promptNewCategory(anchor: HTMLElement): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mini";
  input.style.width = "90px";
  input.maxLength = CAT_NAME_MAX;
  input.placeholder = `≤ ${CAT_NAME_MAX} 字`;
  anchor.replaceWith(input);
  input.focus();

  const commit = () => {
    const name = input.value.trim();
    if (!name) {
      renderFormOptions();
      return;
    }
    if (name.length > CAT_NAME_MAX) {
      fHint.textContent = `类别名最多 ${CAT_NAME_MAX} 个字`;
      return;
    }
    if (!categoryList().includes(name)) extraCategories.push(name);
    formCategory = name;
    fHint.textContent = "";
    renderFormOptions();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      renderFormOptions();
    }
  });
  input.addEventListener("blur", commit);
}

/** 新建时把标题与元数据拼成一行，交给解析器统一处理。 */
function buildRaw(title: string, p: Priority, due: string | null): string {
  const parts = [title];
  if (p !== "none") parts.push(PRIORITY_EMOJI[p]);
  if (due) parts.push(`📅 ${due}`);
  return parts.join(" ");
}

async function saveForm(): Promise<void> {
  if (!doc) return;
  const title = fTitle.value.trim();
  if (!title) {
    fHint.textContent = "标题不能为空";
    fTitle.focus();
    return;
  }
  const due = fDue.value || null;
  const today = todayStr();

  if (editLine === null) {
    doc.add(buildRaw(title, formPriority, due), formCategory, today);
  } else {
    // 表单开着的时候文件可能被外部改过，先确认这条还是原来那条
    const t = doc.get(editLine);
    if (!t || t.description !== editSnapshot) {
      fHint.textContent = "这条已被外部改动，请关掉表单重新打开";
      return;
    }
    doc.setText(editLine, title, today);
    doc.setPriority(editLine, formPriority, today);
    doc.setDue(editLine, due, today);
    // 改归属会移动行，必须放最后——之后 editLine 就失效了
    doc.setCategory(editLine, formCategory, today);
  }

  closeForm();
  await persist();
  render();
}

// ------------------------------------------------------------------
// 设置：文件与类别管理
// ------------------------------------------------------------------
/** 类别名校验。exclude 是改名时允许保持不变的原名。 */
function validateCategoryName(raw: string, exclude?: string): string | null {
  const name = raw.trim();
  if (!name) return "类别名不能为空";
  if (name.length > CAT_NAME_MAX) return `类别名最多 ${CAT_NAME_MAX} 个字，标签条放不下`;
  if (name === DEFAULT_CATEGORY && exclude !== DEFAULT_CATEGORY) return "「默认」是内置类别";
  if (name !== exclude && categoryList().includes(name)) return `已经有「${name}」了`;
  return null;
}

function openSettings(): void {
  settingsOpen = true;
  pendingDelete = null;
  sHint.textContent = "";
  renderSettings();
  settingsModal.hidden = false;
}

function closeSettings(): void {
  settingsOpen = false;
  pendingDelete = null;
  settingsModal.hidden = true;
}

function renderSettings(): void {
  sPath.textContent = config.todoFilePath ? shortPath(config.todoFilePath) : "未选择";
  sPath.title = config.todoFilePath || "";

  sCats.innerHTML = "";
  if (!doc) return;

  for (const name of doc.categories) {
    const row = el("div", "cat-row");

    const chip = el("span", "tag cat", name);
    chip.style.setProperty("--h", String(hueOf(name)));
    row.appendChild(chip);

    const open = doc.todos.filter((t) => t.status === "open" && t.category === name).length;
    row.appendChild(el("span", "cat-count", open ? `${open} 条待办` : "空"));

    if (name === DEFAULT_CATEGORY) {
      // 内置类别不能改名也不能删——它是所有无归属条目的落点
      row.appendChild(el("span", "built-in", "内置"));
    } else {
      const rename = el("button", "mini", "改名");
      rename.addEventListener("click", () => startRename(row, chip, name));
      row.appendChild(rename);

      const del = el("button", "mini danger" + (pendingDelete === name ? " confirm" : ""),
        pendingDelete === name ? "确认" : "删除");
      del.addEventListener("click", () => void handleDelete(name, open));
      row.appendChild(del);
    }

    sCats.appendChild(row);
  }

  const add = el("button", "mini", "＋ 新建类别");
  add.addEventListener("click", () => startNewCategory(add));
  const addRow = el("div", "cat-row");
  addRow.appendChild(add);
  sCats.appendChild(addRow);
}

/** 就地把色块换成输入框，回车提交。 */
function inlineInput(
  anchor: HTMLElement,
  initial: string,
  onCommit: (value: string) => void,
): void {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "mini";
  input.style.width = "96px";
  input.maxLength = CAT_NAME_MAX;
  input.value = initial;
  input.placeholder = `≤ ${CAT_NAME_MAX} 字`;
  anchor.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) onCommit(input.value);
    else renderSettings();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // 别让 Esc 冒到全局把面板收了
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function startRename(row: HTMLElement, chip: HTMLElement, oldName: string): void {
  pendingDelete = null;
  inlineInput(chip, oldName, (value) => {
    const err = validateCategoryName(value, oldName);
    if (err) {
      sHint.textContent = err;
      renderSettings();
      return;
    }
    const newName = value.trim();
    if (newName === oldName) {
      renderSettings();
      return;
    }
    // frontmatter 清单与分区标题必须一起改，漏一处整个分区就落到不存在的类别上
    doc!.renameCategory(oldName, newName);
    if (view === CAT_PREFIX + oldName) view = CAT_PREFIX + newName;
    sHint.textContent = "";
    void afterSettingsChange();
  });
}

function startNewCategory(anchor: HTMLElement): void {
  pendingDelete = null;
  inlineInput(anchor, "", (value) => {
    if (!value.trim()) {
      renderSettings();
      return;
    }
    const err = validateCategoryName(value);
    if (err) {
      sHint.textContent = err;
      renderSettings();
      return;
    }
    doc!.addCategory(value.trim());
    sHint.textContent = "";
    void afterSettingsChange();
  });
}

/** 删类别是两步：第一下变成"确认"，第二下才执行。误触代价不小，但也别弹窗。 */
async function handleDelete(name: string, openCount: number): Promise<void> {
  if (pendingDelete !== name) {
    pendingDelete = name;
    sHint.textContent = openCount
      ? `再点一次删除，${openCount} 条待办会移到「${DEFAULT_CATEGORY}」`
      : "再点一次删除";
    renderSettings();
    return;
  }
  pendingDelete = null;
  sHint.textContent = "";
  doc!.removeCategory(name);
  if (view === CAT_PREFIX + name) view = V_FEATURED;
  await afterSettingsChange();
}

async function afterSettingsChange(): Promise<void> {
  await persist();
  render();
  renderSettings();
}

// ------------------------------------------------------------------
// 交互
// ------------------------------------------------------------------
/**
 * 选文件。mode="open" 选已有的，mode="create" 走保存对话框新建。
 * macOS 上 alwaysOnTop 会把原生对话框挡在后面，所以打开前先取消置顶、结束后恢复。
 */
async function chooseFile(mode: "open" | "create"): Promise<void> {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    await bridge.setPanelAlwaysOnTop(false);
    const picked = mode === "create" ? await bridge.createTodoFile() : await bridge.pickTodoFile();
    if (picked) {
      if (mode === "create") await ensureSkeleton(picked);
      const latest = await bridge.loadConfig();
      latest.todoFilePath = picked;
      await bridge.saveConfig(latest);
      config = latest;
    }
  } catch (e) {
    renderMessage(`选择文件出错：${String(e)}`, true);
  } finally {
    await bridge.setPanelAlwaysOnTop(true);
    await bridge.ensureVisible();
    dialogOpen = false;
    await reload();
    if (settingsOpen) renderSettings();
  }
}

sortBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSortMenu();
});
addBtn.addEventListener("click", () => openForm(null));
settingsBtn.addEventListener("click", openSettings);
sPick.addEventListener("click", () => void chooseFile("open"));
sReveal.addEventListener("click", () => {
  if (config.todoFilePath) void bridge.revealPath(config.todoFilePath);
});
sClose.addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) closeSettings();
});
fCancel.addEventListener("click", closeForm);
fSave.addEventListener("click", () => void saveForm());
fDueClear.addEventListener("click", () => {
  fDue.value = "";
});
fTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void saveForm();
  }
});
modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) closeForm();
});
document.addEventListener("click", () => {
  if (!sortMenu.hidden) sortMenu.hidden = true;
});

// Esc：表单开着就关表单，否则收回面板
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!sortMenu.hidden) {
    sortMenu.hidden = true;
    return;
  }
  if (modalOpen) {
    closeForm();
    return;
  }
  if (settingsOpen) {
    closeSettings();
    return;
  }
  void bridge.hidePanel();
});

// ------------------------------------------------------------------
// 窗口行为
// ------------------------------------------------------------------
let pendingHide: number | null = null;

function cancelPendingHide(): void {
  if (pendingHide !== null) {
    clearTimeout(pendingHide);
    pendingHide = null;
  }
}

/**
 * 面板优先出现在球的左侧，放不下才去右侧；
 * 标签条始终摆在背离球的那一侧，免得被夹在球和列表之间。
 */
async function computePanelPosition(geom: {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}): Promise<{ x: number; y: number; side: "left" | "right" }> {
  const size = await bridge.getPanelOuterSize();
  const mon = await bridge.getCurrentMonitorBounds();
  const gap = Math.round(10 * geom.scale);
  const pw = size.w;
  const ph = size.h;

  let side: "left" | "right" = "left";
  let x = geom.x - pw - gap;
  if (x < mon.x + 4) {
    x = geom.x + geom.w + gap;
    side = "right";
  }
  let y = geom.y + geom.h - ph;

  x = Math.max(mon.x + 4, Math.min(x, mon.x + mon.w - pw - 4));
  y = Math.max(mon.y + 4, Math.min(y, mon.y + mon.h - ph - 4));
  return { x: Math.round(x), y: Math.round(y), side };
}

async function init(): Promise<void> {
  config = await bridge.loadConfig();

  await bridge.onPanelBlur(() => {
    if (dialogOpen || modalOpen || settingsOpen) return; // 对话框、表单、设置打开期间不收回
    cancelPendingHide();
    pendingHide = window.setTimeout(() => {
      pendingHide = null;
      sortMenu.hidden = true;
      void bridge.hidePanel();
    }, 140);
  });

  await bridge.onTogglePanel(async (geom) => {
    cancelPendingHide();
    const visible = await bridge.isPanelVisible();
    if (visible) {
      await bridge.hidePanel();
    } else {
      const pos = await computePanelPosition(geom);
      shellEl.dataset.side = pos.side;
      await bridge.showPanelAt(pos.x, pos.y);
      await reload();
    }
  });

  // 文件被外部（如 Obsidian）修改 → 防抖后重新加载并覆盖内存。
  // 表单开着时只刷新列表数据，表单内容不受影响；保存时再校验条目是否还在。
  await bridge.onTodoFileChanged(() => {
    if (Date.now() < ignoreWatchUntil) return;
    if (dialogOpen) return;
    if (watchReloadTimer !== null) clearTimeout(watchReloadTimer);
    watchReloadTimer = window.setTimeout(() => {
      watchReloadTimer = null;
      void reload();
    }, 200);
  });

  await reload();
}

void init();
