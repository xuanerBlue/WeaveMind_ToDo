import "./styles/panel.css";
import { TodoDoc, sortTodos, PRIORITY_EMOJI } from "./todo-parser";
import type { AppConfig, Priority, Todo } from "./types";
import * as bridge from "./bridge";

// ------------------------------------------------------------------
// 状态
// ------------------------------------------------------------------
let config: AppConfig = { todoFilePath: null };
let doc: TodoDoc | null = null;
let editingText: number | null = null; // 正在内联编辑正文的行号
let editingDue: number | null = null; // 正在编辑截止日期的行号
let dialogOpen = false; // 原生文件对话框打开期间，禁止因失焦收回面板

const listEl = document.getElementById("list")!;
const countEl = document.getElementById("count")!;
const footerEl = document.getElementById("footer")!;
const addInput = document.getElementById("add-input") as HTMLInputElement;
const refreshBtn = document.getElementById("refresh")!;
const settingsBtn = document.getElementById("settings")!;

// 优先级循环顺序（点击优先级角标时轮换）
const PRIORITY_CYCLE: Priority[] = [
  "none",
  "highest",
  "high",
  "medium",
  "low",
  "lowest",
];

// ------------------------------------------------------------------
// 工具
// ------------------------------------------------------------------
function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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
    const content = await bridge.readTodoFile(config.todoFilePath);
    doc = new TodoDoc(content);
    render();
  } catch (e) {
    renderMessage(`读取文件失败：${String(e)}`, true);
  }
}

async function persist(): Promise<void> {
  if (!doc || !config.todoFilePath) return;
  try {
    await bridge.writeTodoFile(config.todoFilePath, doc.toString());
    // 通知悬浮球刷新未完成数量角标
    const pending = doc.todos.filter((t) => !t.checked).length;
    await bridge.emitTodosChanged(pending);
  } catch (e) {
    renderMessage(`写入文件失败：${String(e)}`, true);
  }
}

// ------------------------------------------------------------------
// 渲染
// ------------------------------------------------------------------
function render(): void {
  if (!doc) return;
  listEl.innerHTML = "";
  const todos = sortTodos(doc.todos);
  const pending = todos.filter((t) => !t.checked).length;
  countEl.textContent = pending ? `${pending} 项待办` : "全部完成 🎉";

  if (todos.length === 0) {
    renderMessage("还没有待办，在上方输入框添加一条吧");
  } else {
    for (const t of todos) listEl.appendChild(renderItem(t));
  }
  renderFooter();
}

function renderItem(t: Todo): HTMLElement {
  const item = document.createElement("div");
  item.className = "item" + (t.checked ? " done" : "");

  // 复选框
  const check = document.createElement("div");
  check.className = "check";
  check.title = t.checked ? "标记为未完成" : "标记为完成";
  check.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  check.addEventListener("click", async () => {
    doc!.toggle(t.lineIndex, todayStr());
    await persist();
    render();
  });
  item.appendChild(check);

  // 正文 + 元数据
  const body = document.createElement("div");
  body.className = "body";

  const desc = document.createElement("div");
  desc.className = "desc";
  desc.textContent = t.description || "(空)";
  if (editingText === t.lineIndex) {
    startInlineEdit(desc, t);
  } else {
    desc.addEventListener("click", () => {
      editingText = t.lineIndex;
      render();
    });
  }
  body.appendChild(desc);

  // 元数据行
  const meta = document.createElement("div");
  meta.className = "meta";

  // 优先级角标（点击轮换）
  const prio = document.createElement("span");
  prio.className = "chip prio";
  prio.textContent = t.priority === "none" ? "⚐" : PRIORITY_EMOJI[t.priority];
  prio.title = "点击切换优先级";
  prio.addEventListener("click", async () => {
    const idx = PRIORITY_CYCLE.indexOf(t.priority);
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
    doc!.setPriority(t.lineIndex, next);
    await persist();
    render();
  });
  meta.appendChild(prio);

  // 截止日期
  if (editingDue === t.lineIndex) {
    const input = document.createElement("input");
    input.type = "date";
    input.value = t.due ?? "";
    input.className = "chip due";
    setTimeout(() => input.focus(), 0);
    const commit = async () => {
      doc!.setDue(t.lineIndex, input.value || null);
      editingDue = null;
      await persist();
      render();
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", () => {
      editingDue = null;
      render();
    });
    meta.appendChild(input);
  } else {
    const due = document.createElement("span");
    due.className = "chip due";
    if (t.due) {
      const overdue = !t.checked && t.due < todayStr();
      if (overdue) due.classList.add("overdue");
      due.textContent = `📅 ${t.due}`;
    } else {
      due.textContent = "📅 日期";
      due.style.opacity = "0.55";
    }
    due.title = "点击设置截止日期";
    due.addEventListener("click", () => {
      editingDue = t.lineIndex;
      render();
    });
    meta.appendChild(due);
  }

  // 标签（只读展示）
  for (const tag of t.tags) {
    const chip = document.createElement("span");
    chip.className = "chip tag";
    chip.textContent = tag;
    meta.appendChild(chip);
  }

  body.appendChild(meta);
  item.appendChild(body);

  // 删除
  const del = document.createElement("button");
  del.className = "del";
  del.textContent = "✕";
  del.title = "删除";
  del.addEventListener("click", async () => {
    doc!.remove(t.lineIndex);
    await persist();
    render();
  });
  item.appendChild(del);

  return item;
}

function startInlineEdit(desc: HTMLElement, t: Todo): void {
  desc.contentEditable = "true";
  desc.textContent = rebuildEditableText(t);
  setTimeout(() => {
    desc.focus();
    const range = document.createRange();
    range.selectNodeContents(desc);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, 0);

  const finish = async (save: boolean) => {
    if (editingText !== t.lineIndex) return;
    editingText = null;
    if (save) {
      const text = (desc.textContent || "").trim();
      if (text) {
        doc!.setText(t.lineIndex, text);
      } else {
        doc!.remove(t.lineIndex);
      }
      await persist();
    }
    render();
  };

  desc.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  });
  desc.addEventListener("blur", () => void finish(true));
}

// 内联编辑时把优先级/截止也拼回文字，方便用户直接改
function rebuildEditableText(t: Todo): string {
  const parts = [t.description];
  if (t.priority !== "none") parts.push(PRIORITY_EMOJI[t.priority]);
  if (t.due) parts.push(`📅 ${t.due}`);
  return parts.filter(Boolean).join(" ");
}

function renderFooter(): void {
  footerEl.innerHTML = "";
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = config.todoFilePath
    ? `📄 ${fileName(config.todoFilePath)}`
    : "未选择文件";
  path.title = config.todoFilePath || "点击选择 Todo.md 文件";
  path.addEventListener("click", pickFile);
  footerEl.appendChild(path);
}

function renderMessage(msg: string, isError = false): void {
  const box = document.createElement("div");
  box.className = "empty";
  const p = document.createElement("div");
  p.textContent = msg;
  if (isError) p.style.color = "var(--danger)";
  box.appendChild(p);
  listEl.appendChild(box);
}

function renderSetup(): void {
  listEl.innerHTML = "";
  countEl.textContent = "";
  const box = document.createElement("div");
  box.className = "setup";

  const p = document.createElement("div");
  p.textContent = "选择你 Obsidian vault 里的 Todo.md 文件，即可开始";

  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = "选择 Todo.md 文件";
  btn.addEventListener("click", pickFile);

  box.appendChild(p);
  box.appendChild(btn);
  listEl.appendChild(box);
  renderFooter();
}

// ------------------------------------------------------------------
// 交互
// ------------------------------------------------------------------
async function pickFile(): Promise<void> {
  if (dialogOpen) return; // 对话框已在进行中，忽略重复点击
  dialogOpen = true;
  try {
    // macOS 上 alwaysOnTop 会把原生文件对话框挡在后面，打开前先取消置顶
    await bridge.setPanelAlwaysOnTop(false);
    const picked = await bridge.pickTodoFile();
    if (picked) {
      const latest = await bridge.loadConfig();
      latest.todoFilePath = picked;
      await bridge.saveConfig(latest);
      config = latest;
    }
  } catch (e) {
    renderMessage(`选择文件出错：${String(e)}`, true);
  } finally {
    await bridge.setPanelAlwaysOnTop(true); // 恢复置顶
    await bridge.ensureVisible();
    dialogOpen = false;
    await reload();
  }
}

addInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  const text = addInput.value.trim();
  if (!text || !doc) return;
  doc.add(text);
  addInput.value = "";
  await persist();
  render();
});

refreshBtn.addEventListener("click", () => void reload());
settingsBtn.addEventListener("click", () => void pickFile());

// ------------------------------------------------------------------
// 窗口行为：点击悬浮球切换显示 / 点面板外收回
// ------------------------------------------------------------------
let pendingHide: number | null = null;

function cancelPendingHide(): void {
  if (pendingHide !== null) {
    clearTimeout(pendingHide);
    pendingHide = null;
  }
}

async function computePanelPosition(geom: {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}): Promise<{ x: number; y: number }> {
  const size = await bridge.getPanelOuterSize(); // 物理像素
  const mon = await bridge.getCurrentMonitorBounds(); // 物理像素
  const gap = Math.round(10 * geom.scale);
  const pw = size.w;
  const ph = size.h;

  // 优先出现在球的左侧，底边对齐球底
  let x = geom.x - pw - gap;
  if (x < mon.x + 4) x = geom.x + geom.w + gap; // 左侧放不下 → 右侧
  let y = geom.y + geom.h - ph;

  // 夹到屏幕内
  x = Math.max(mon.x + 4, Math.min(x, mon.x + mon.w - pw - 4));
  y = Math.max(mon.y + 4, Math.min(y, mon.y + mon.h - ph - 4));
  return { x: Math.round(x), y: Math.round(y) };
}

async function init(): Promise<void> {
  config = await bridge.loadConfig();

  // 点面板外 → 延迟收回；若紧接着来了 toggle（点球），则取消
  await bridge.onPanelBlur(() => {
    if (dialogOpen) return; // 文件对话框打开期间不收回
    cancelPendingHide();
    pendingHide = window.setTimeout(() => {
      pendingHide = null;
      editingText = null;
      editingDue = null;
      void bridge.hidePanel();
    }, 140);
  });

  // 点悬浮球 → 切换
  await bridge.onTogglePanel(async (geom) => {
    cancelPendingHide();
    const visible = await bridge.isPanelVisible();
    if (visible) {
      await bridge.hidePanel();
    } else {
      const pos = await computePanelPosition(geom);
      await bridge.showPanelAt(pos.x, pos.y);
      await reload();
    }
  });

  await reload();
}

void init();
