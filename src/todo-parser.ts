import type { ChecklistItem, Priority, Section, Todo, TodoStatus } from "./types";

// 内置类别。文件里没有 "## 默认" 标题时，首个标题之前的区域即它的地盘（隐式默认区）。
export const DEFAULT_CATEGORY = "默认";

// 优先级 → emoji（沿用 Obsidian Tasks 规范，保证文件在 Obsidian 里仍可识别）。
// 注意：emoji 只是**存储层编码**，界面一律用文字色块渲染，不显示 emoji。
export const PRIORITY_EMOJI: Record<Exclude<Priority, "none">, string> = {
  highest: "🔺",
  high: "⏫",
  medium: "🔼",
  low: "🔽",
  lowest: "⏬",
};

const EMOJI_PRIORITY: Record<string, Priority> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};

// 四档排序权重。low / lowest 并入"一般"，因为需求里没有这两档，
// 它们只可能来自已有文件，不该排在"一般"之后另立一层。
export function priorityRank(p: Priority): number {
  switch (p) {
    case "highest":
      return 3;
    case "high":
      return 2;
    case "medium":
      return 1;
    default:
      return 0;
  }
}

// 任务行：支持 - * + 三种列表符号，以及 [ ] [x] [-] 三态
const TASK_RE = /^(\s*)([-*+]) \[([ xX\-])\] (.*)$/;
const LEADING_WS_RE = /^\s*/;

// 子块相对父任务的缩进。四格在纯文本里层级一眼可见，也和 Obsidian 默认的 tab 宽度一致；
// 解析侧同时认两格与 tab，用别的工具缩出来的子项照样读得出来。
const CHILD_INDENT = "    ";
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CANCELLED_RE = /❌\s*(\d{4}-\d{2}-\d{2})/;
const CATEGORIES_RE = /^categories\s*:\s*(.*)$/;
const YAML_ITEM_RE = /^\s*-\s*(.+?)\s*$/;

// 文件末尾的格式说明。挂在一个**非类别**标题下，软件永远不会往里插任务、也不会动它，
// 用户想删随时删。标题文字同时是"这段说明在不在"的判据。
// 注意：示例里的复选框必须包在引用块里（行首 ">"），否则解析器会把它们当成真的待办。
export const FORMAT_NOTE_HEADING = "## 格式说明";
export const FORMAT_NOTE = [
  FORMAT_NOTE_HEADING,
  "",
  "这一段是给人看的，软件不会动它，删掉也不影响使用。",
  "",
  "- 状态：`- [ ]` 未做 / `- [x]` 已完成 / `- [-]` 已放弃（留痕，不删）",
  "- 优先级：`🔺` 重要且紧急 / `⏫` 紧急 / `🔼` 重要 / 不写 = 一般",
  "- 日期：`➕` 创建（软件自动写）/ `📅` 截止（只有你手填才有，有它才会算超期）",
  "  / `✅` 完成 / `❌` 放弃",
  "- 类别 = `##` 分区标题，且要列在文件顶部 frontmatter 的 `categories` 里。",
  "  没列进去的标题（比如这一段）下面的条目归「默认」类别，也不会被自动挪动。",
  "- 每个分区里，未完成的在上，完成和放弃的沉在下面。",
  "- 详情：任务行下面缩进四格，普通文字是这条待办的描述，`- [ ]` 行是它的检查项——",
  "",
  "  > - [ ] 写周报 🔺 ➕ 2026-09-14 📅 2026-09-18",
  "  >     这一段是描述，可以写好几行。",
  "  >     - [x] 收集这周的进展",
  "  >     - [ ] 写完初稿",
  "",
  "  检查项不算独立待办：不进任何视图、不记日期、不会归档，",
  "  勾满了也不会让上面那条自动完成——完成与否你自己点。",
].join("\n");

// 新建文件时写入的骨架，保证在 Obsidian 里打开也是一份正常的 md
export const FILE_SKELETON = `---\ncategories: [${DEFAULT_CATEGORY}]\n---\n\n\n${FORMAT_NOTE}\n`;

// ------------------------------------------------------------------ 日期工具
export function todayStr(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 全部按 UTC 解析，避免本地时区把日期算偏一天
function toUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  const t = new Date(toUtc(iso) + n * 86400000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** b - a，单位天。 */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

// ------------------------------------------------------------------ 解析工具
function detectEol(content: string): string {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

// 归一化：去掉 emoji 变体选择符 U+FE0F、把不间断空格变成普通空格，
// 否则 "⏫️" 之类会在匹配后残留半个字符（Obsidian Tasks 文档明确的坑）。
function normalize(s: string): string {
  return s.replace(/️/g, "").replace(/ /g, " ");
}

interface Meta {
  description: string;
  priority: Priority;
  created: string | null;
  due: string | null;
  done: string | null;
  cancelled: string | null;
}

function extractMeta(rest: string): Meta {
  let text = normalize(rest);

  let priority: Priority = "none";
  for (const [emoji, p] of Object.entries(EMOJI_PRIORITY)) {
    if (text.includes(emoji)) {
      priority = p;
      text = text.replace(emoji, " ");
      break;
    }
  }

  const take = (re: RegExp): string | null => {
    const m = re.exec(text);
    if (!m) return null;
    text = text.replace(re, " ");
    return m[1];
  };

  const created = take(CREATED_RE);
  const due = take(DUE_RE);
  const done = take(DONE_RE);
  const cancelled = take(CANCELLED_RE);

  return {
    description: text.replace(/\s+/g, " ").trim(),
    priority,
    created,
    due,
    done,
    cancelled,
  };
}

// 缩进宽度。tab 按 4 格算，免得 tab 缩进的文件判不出层级
function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

function leadingWidth(line: string): number {
  return indentWidth(LEADING_WS_RE.exec(line)![0]);
}

function statusOf(mark: string): TodoStatus {
  if (mark === "-") return "cancelled";
  return mark.toLowerCase() === "x" ? "done" : "open";
}

function markOf(s: TodoStatus): string {
  return s === "done" ? "x" : s === "cancelled" ? "-" : " ";
}

// YAML 行内数组 "[a, b]" → ["a","b"]
function parseInlineList(raw: string): string[] {
  let s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.trim()) return [];
  return s
    .split(",")
    .map((x) => unquote(x.trim()))
    .filter(Boolean);
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

// 含 YAML 特殊字符时加引号，避免写出非法 frontmatter
function quoteIfNeeded(s: string): string {
  return /[,\[\]{}:#&*!|>'"%@`]/.test(s) || s !== s.trim() ? JSON.stringify(s) : s;
}

interface FrontmatterInfo {
  start: number; // 起始 --- 行号；-1 表示无 frontmatter
  end: number; // 结束 --- 行号
  catStart: number; // categories 键所在行；-1 表示没有该键
  catEnd: number; // categories 取值占用的最后一行
}

/**
 * TodoDoc：一份 Todo.md 的可变文档模型（行模型）。
 *
 * - 只改动任务行、类别标题行和 frontmatter 的 categories 行，
 *   用户手写的段落、标题、空行逐字节保留。
 * - 类别靠 "## 标题" 表达，且只有列在 frontmatter categories 里的标题才算类别分区；
 *   其余标题（如 "## 备注"）下的任务归"默认"类别参与展示，但不参与自动行移动。
 * - 所有变更按 lineIndex 定位，改完立即 reparse 保证下标一致。
 */
export class TodoDoc {
  lines: string[];
  eol: string;
  todos: Todo[] = [];
  sections: Section[] = [];
  categories: string[] = [];
  private fm: FrontmatterInfo = { start: -1, end: -1, catStart: -1, catEnd: -1 };

  constructor(content: string) {
    this.eol = detectEol(content);
    this.lines = content.split(/\r\n|\n/);
    this.parse();
  }

  toString(): string {
    return this.lines.join(this.eol);
  }

  // ---------------------------------------------------------------- 解析
  private parse(): void {
    this.parseFrontmatter();
    this.parseSections();
    this.parseTodos();
  }

  private parseFrontmatter(): void {
    const fm: FrontmatterInfo = { start: -1, end: -1, catStart: -1, catEnd: -1 };
    this.categories = [];

    if (this.lines[0]?.trim() === "---") {
      for (let i = 1; i < this.lines.length; i++) {
        if (this.lines[i].trim() === "---") {
          fm.start = 0;
          fm.end = i;
          break;
        }
      }
    }

    if (fm.start >= 0) {
      for (let i = fm.start + 1; i < fm.end; i++) {
        const m = CATEGORIES_RE.exec(this.lines[i]);
        if (!m) continue;
        fm.catStart = i;
        fm.catEnd = i;
        const inline = m[1].trim();
        if (inline) {
          this.categories = parseInlineList(inline);
        } else {
          // 多行写法：categories: 下面跟一串 "- 名字"
          for (let j = i + 1; j < fm.end; j++) {
            const im = YAML_ITEM_RE.exec(this.lines[j]);
            if (!im) break;
            this.categories.push(unquote(im[1]));
            fm.catEnd = j;
          }
        }
        break;
      }
    }

    // "默认"始终存在，但只补进内存——读取时不写文件
    if (!this.categories.includes(DEFAULT_CATEGORY)) {
      this.categories.unshift(DEFAULT_CATEGORY);
    }
    this.fm = fm;
  }

  private parseSections(): void {
    const contentStart = this.fm.start >= 0 ? this.fm.end + 1 : 0;
    const headings: number[] = [];
    for (let i = contentStart; i < this.lines.length; i++) {
      if (HEADING_RE.test(this.lines[i])) headings.push(i);
    }

    const sections: Section[] = [];
    // 隐式默认区：frontmatter 之后、首个标题之前
    sections.push({
      headingLine: -1,
      name: DEFAULT_CATEGORY,
      isCategory: true,
      start: contentStart,
      end: (headings.length ? headings[0] : this.lines.length) - 1,
    });

    headings.forEach((h, k) => {
      const m = HEADING_RE.exec(this.lines[h])!;
      const name = m[2].trim();
      sections.push({
        headingLine: h,
        name,
        isCategory: this.categories.includes(name),
        start: h + 1,
        end: (k + 1 < headings.length ? headings[k + 1] : this.lines.length) - 1,
      });
    });

    this.sections = sections;
  }

  private parseTodos(): void {
    this.todos = [];
    for (let i = 0; i < this.lines.length; i++) {
      const m = TASK_RE.exec(this.lines[i]);
      if (!m) continue;
      const [, indent, bullet, mark, rest] = m;
      const meta = extractMeta(rest);
      const sec = this.findSection(i);
      const isCat = !!sec && sec.isCategory;
      const width = indentWidth(indent);
      const blockEnd = this.blockEndOf(i, width);
      const { detail, checklist } = this.parseBlock(i, blockEnd);

      this.todos.push({
        lineIndex: i,
        blockEnd,
        detail,
        checklist,
        indent,
        bullet,
        status: statusOf(mark),
        description: meta.description,
        priority: meta.priority,
        created: meta.created,
        due: meta.due,
        done: meta.done,
        cancelled: meta.cancelled,
        category: isCat ? sec!.name : DEFAULT_CATEGORY,
        movable: isCat,
      });

      // 块内的任务行是这条待办的检查项，不再各自算一条待办
      i = blockEnd;
    }
  }

  /**
   * 块的最后一行：紧随任务行之后、缩进比它深的那一段。
   * 中间的空行只有在后面还有更深缩进时才算块内，否则块就在上一个非空行结束——
   * 不然分区末尾的空行会被吸进来，往返一次就少一个空行。
   */
  private blockEndOf(lineIndex: number, parentWidth: number): number {
    let end = lineIndex;
    for (let i = lineIndex + 1; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (line.trim() === "") continue;
      if (leadingWidth(line) <= parentWidth) break;
      end = i;
    }
    return end;
  }

  /** 拆块内容：任务行 → 检查项，其余非空行 → 描述。 */
  private parseBlock(lineIndex: number, blockEnd: number): { detail: string; checklist: ChecklistItem[] } {
    const checklist: ChecklistItem[] = [];
    const detailLines: string[] = [];

    for (let i = lineIndex + 1; i <= blockEnd; i++) {
      const line = this.lines[i];
      const m = TASK_RE.exec(line);
      if (m) {
        const mark = m[3];
        checklist.push({ text: m[4].trim(), done: mark !== " ", mark });
      } else if (line.trim() !== "" || detailLines.length) {
        detailLines.push(line.replace(/\s+$/, ""));
      }
    }

    // 描述整体去掉公共缩进，编辑框里看到的才是用户自己写的那几行
    const pads = detailLines.filter((l) => l.trim()).map((l) => LEADING_WS_RE.exec(l)![0].length);
    const pad = pads.length ? Math.min(...pads) : 0;
    while (detailLines.length && !detailLines[detailLines.length - 1].trim()) detailLines.pop();

    return { detail: detailLines.map((l) => l.slice(pad)).join("\n"), checklist };
  }

  private findSection(lineIndex: number): Section | undefined {
    return this.sections.find((s) => lineIndex >= s.start && lineIndex <= s.end);
  }

  /** 找某个类别的分区，显式标题优先于隐式默认区。 */
  private findCategorySection(name: string): Section | undefined {
    return (
      this.sections.find((s) => s.isCategory && s.name === name && s.headingLine >= 0) ??
      this.sections.find((s) => s.isCategory && s.name === name)
    );
  }

  get(lineIndex: number): Todo | undefined {
    return this.todos.find((t) => t.lineIndex === lineIndex);
  }

  // ---------------------------------------------------------------- 序列化
  private serialize(t: Todo): string {
    const parts: string[] = [t.description];
    if (t.priority !== "none") parts.push(PRIORITY_EMOJI[t.priority]);
    if (t.created) parts.push(`➕ ${t.created}`);
    if (t.due) parts.push(`📅 ${t.due}`);
    if (t.done) parts.push(`✅ ${t.done}`);
    if (t.cancelled) parts.push(`❌ ${t.cancelled}`);
    const body = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return `${t.indent}${t.bullet} [${markOf(t.status)}] ${body}`;
  }

  /** 整块的行：任务行 → 描述 → 检查项。顺序固定，写回时归一。 */
  private serializeBlock(t: Todo): string[] {
    const out = [this.serialize(t)];
    const childIndent = t.indent + CHILD_INDENT;

    const detail = t.detail.replace(/\s+$/, "");
    if (detail) {
      for (const line of detail.split("\n")) {
        out.push(line.trim() ? childIndent + line.replace(/\s+$/, "") : "");
      }
    }
    for (const c of t.checklist) {
      if (!c.text.trim()) continue;
      const mark = c.done ? (c.mark === "-" ? "-" : "x") : " ";
      out.push(`${childIndent}- [${mark}] ${c.text.trim()}`);
    }
    return out;
  }

  /**
   * 把改动写回文件。块的行数可能变（加了检查项、删了描述），
   * 所以整块替换后立刻 reparse——后面所有定位都依赖行号。
   */
  private commit(t: Todo): void {
    const span = t.blockEnd - t.lineIndex + 1;
    this.lines.splice(t.lineIndex, span, ...this.serializeBlock(t));
    this.parse();
  }

  /** 首次被操作时补写创建日期——读取时不写文件，改动时才补。 */
  private touch(t: Todo, today: string): void {
    if (!t.created) t.created = today;
  }

  /** 把某处连续的空行压成一个，避免反复增删类别时空行越积越多。 */
  private collapseBlankAt(index: number): void {
    if (this.lines[index]?.trim() !== "" && this.lines[index - 1]?.trim() !== "") return;
    let start = index;
    while (start > 0 && this.lines[start - 1].trim() === "") start--;
    let end = index;
    while (end < this.lines.length && this.lines[end].trim() === "") end++;
    const count = end - start;
    if (count > 1) this.lines.splice(start, count - 1);
  }

  /** 把一条待办的整块移到 before 行之前。描述和检查项必须跟着走。 */
  private moveBlock(t: Todo, before: number): void {
    const count = t.blockEnd - t.lineIndex + 1;
    if (before >= t.lineIndex && before <= t.blockEnd + 1) return; // 已经在那儿了
    const seg = this.lines.splice(t.lineIndex, count);
    this.lines.splice(before > t.lineIndex ? before - count : before, 0, ...seg);
  }

  // ---------------------------------------------------------------- 类别管理
  /** 把 categories 写回 frontmatter。返回在文件头部新增的行数（供调用方修正 lineIndex）。 */
  private writeCategories(): number {
    const line = `categories: [${this.categories.map(quoteIfNeeded).join(", ")}]`;
    let added = 0;

    if (this.fm.start < 0) {
      this.lines.unshift("---", line, "---", "");
      added = 4;
    } else if (this.fm.catStart < 0) {
      this.lines.splice(this.fm.end, 0, line);
      added = 1;
    } else {
      const span = this.fm.catEnd - this.fm.catStart + 1;
      this.lines.splice(this.fm.catStart, span, line);
      added = 1 - span;
    }

    this.parse();
    return added;
  }

  /** 确保类别在清单里。返回文件头部新增的行数。 */
  addCategory(name: string): number {
    if (this.categories.includes(name)) return 0;
    this.categories.push(name);
    return this.writeCategories();
  }

  /**
   * 确保该类别有可写入的分区。返回文件头部新增的行数——
   * 调用方若持有任务的 lineIndex，必须加上这个偏移量。
   */
  private ensureSection(name: string): number {
    let shift = 0;
    if (!this.categories.includes(name)) shift += this.addCategory(name);
    if (this.findCategorySection(name)) return shift;

    // 末尾追加标题；在文件尾部插入，不影响已有任务的行号
    if (this.lines.length && this.lines[this.lines.length - 1].trim() !== "") {
      this.lines.push("");
    }
    this.lines.push(`## ${name}`, "");
    this.parse();
    return shift;
  }

  /** 改类别名：frontmatter 清单与分区标题必须同时改，漏一处整个分区就落到不存在的类别上。 */
  renameCategory(oldName: string, newName: string): void {
    if (oldName === newName || oldName === DEFAULT_CATEGORY) return;
    const i = this.categories.indexOf(oldName);
    if (i >= 0) {
      this.categories[i] = newName;
      this.writeCategories();
    }
    const sec = this.sections.find((s) => s.name === oldName && s.headingLine >= 0);
    if (sec) {
      const m = HEADING_RE.exec(this.lines[sec.headingLine]);
      if (m) this.lines[sec.headingLine] = `${m[1]} ${newName}`;
    }
    this.parse();
  }

  /** 删类别：底下的任务全部移到"默认"，不销毁。 */
  removeCategory(name: string): void {
    if (name === DEFAULT_CATEGORY) return;

    for (let guard = 0; guard < 10000; guard++) {
      const t = this.todos.find((x) => x.category === name);
      if (!t) break;
      this.moveToCategory(t.lineIndex, DEFAULT_CATEGORY);
    }

    const sec = this.sections.find((s) => s.name === name && s.headingLine >= 0);
    if (sec) {
      this.lines.splice(sec.headingLine, 1);
      this.collapseBlankAt(sec.headingLine);
      this.parse();
    }

    this.categories = this.categories.filter((c) => c !== name);
    this.writeCategories();
  }

  // ---------------------------------------------------------------- 位置计算
  /**
   * 某类别下新条目的落点：该分区内"未完成区"的末尾。
   * exclude 用于排除条目自身（重新打开时上浮要跳过自己）。
   */
  private insertPositionFor(name: string, exclude = -1): number {
    const sec = this.findCategorySection(name);
    if (!sec) return this.lines.length;

    const tasks = this.todos.filter(
      (t) => t.lineIndex >= sec.start && t.lineIndex <= sec.end && t.lineIndex !== exclude,
    );
    const opens = tasks.filter((t) => t.status === "open");
    if (opens.length) return opens[opens.length - 1].blockEnd + 1;
    if (tasks.length) return tasks[0].lineIndex;

    // 分区里一条任务都没有：跳过标题后的空行
    let p = sec.start;
    while (p <= sec.end && this.lines[p].trim() === "") p++;
    return Math.min(p, sec.end + 1);
  }

  /** 完成/放弃后的落点：所在分区内所有任务之后。 */
  private sinkPositionFor(t: Todo): number | null {
    const sec = this.findSection(t.lineIndex);
    if (!sec) return null;
    const tasks = this.todos.filter((x) => x.lineIndex >= sec.start && x.lineIndex <= sec.end);
    if (!tasks.length) return null;
    return tasks[tasks.length - 1].blockEnd + 1;
  }

  // ---------------------------------------------------------------- 变更
  /**
   * 新增一条。落到目标类别未完成区的末尾；类别不存在时先建分区。
   * 返回新条目的 lineIndex——调用方要用它接着写描述或检查项。
   */
  add(
    rawText: string,
    category: string = DEFAULT_CATEGORY,
    today: string = todayStr(),
    extra: { detail?: string; checklist?: ChecklistItem[] } = {},
  ): number {
    this.ensureSection(category);
    const meta = extractMeta(rawText);
    const todo: Todo = {
      lineIndex: -1,
      blockEnd: -1,
      detail: extra.detail ?? "",
      checklist: extra.checklist ?? [],
      indent: "",
      bullet: "-",
      status: "open",
      description: meta.description,
      priority: meta.priority,
      created: meta.created ?? today,
      due: meta.due,
      done: null,
      cancelled: null,
      category,
      movable: true,
    };
    const block = this.serializeBlock(todo);
    const pos = this.insertPositionFor(category);

    // 文件为空（只有一行空串）时直接填入，否则按位置插入
    let at = pos;
    if (this.lines.length === 1 && this.lines[0].trim() === "") {
      this.lines.splice(0, 1, ...block);
      at = 0;
    } else {
      this.lines.splice(pos, 0, ...block);
    }
    this.parse();
    return at;
  }

  private setStatus(lineIndex: number, status: TodoStatus, today: string): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    t.status = status;
    t.done = status === "done" ? today : null;
    t.cancelled = status === "cancelled" ? today : null;
    this.commit(t); // 内含 reparse，下面必须重新取，块长度可能已经变了

    const cur = this.get(lineIndex);
    if (!cur || !cur.movable) return;

    if (status === "open") {
      const pos = this.insertPositionFor(cur.category, cur.lineIndex);
      this.moveBlock(cur, pos);
    } else {
      const pos = this.sinkPositionFor(cur);
      if (pos !== null) this.moveBlock(cur, pos);
    }
    this.parse();
  }

  complete(lineIndex: number, today: string = todayStr()): void {
    this.setStatus(lineIndex, "done", today);
  }

  /** "我不做了"。留痕不删除，沉到本分区底部。 */
  cancel(lineIndex: number, today: string = todayStr()): void {
    this.setStatus(lineIndex, "cancelled", today);
  }

  reopen(lineIndex: number, today: string = todayStr()): void {
    this.setStatus(lineIndex, "open", today);
  }

  /** 勾选框：未做 ↔ 已完成。已放弃的条目勾一下回到未做。 */
  toggle(lineIndex: number, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.setStatus(lineIndex, t.status === "open" ? "done" : "open", today);
  }

  setText(lineIndex: number, newRawText: string, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    const meta = extractMeta(newRawText);
    t.description = meta.description;
    t.priority = meta.priority;
    // 日期以显式输入为准，没输入则保留原值（避免内联编辑时丢掉元数据）
    t.created = meta.created ?? t.created;
    t.due = meta.due ?? t.due;
    this.commit(t);
  }

  setPriority(lineIndex: number, p: Priority, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    t.priority = p;
    this.commit(t);
  }

  setDue(lineIndex: number, due: string | null, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    t.due = due;
    this.commit(t);
  }

  /** 详细描述。空串表示删掉这段，块里对应的行会一起消失。 */
  setDetail(lineIndex: number, detail: string, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    t.detail = detail;
    this.commit(t);
  }

  /**
   * 整份检查项覆盖写入。
   * 检查项勾完不写完成日期、不归档、不沉底——它是父任务的进度刻度，不是一条待办。
   */
  setChecklist(lineIndex: number, items: ChecklistItem[], today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    t.checklist = items.filter((c) => c.text.trim());
    this.commit(t);
  }

  /** 勾选单个检查项，供列表里直接点用。 */
  toggleChecklistItem(lineIndex: number, index: number, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t || !t.checklist[index]) return;
    const items = t.checklist.map((c, i) => (i === index ? { ...c, done: !c.done } : c));
    this.setChecklist(lineIndex, items, today);
  }

  /** 改归属：行会被移动到目标分区。用户显式要求，优先于"不打乱排版"。 */
  setCategory(lineIndex: number, category: string, today: string = todayStr()): void {
    const t = this.get(lineIndex);
    if (!t) return;
    this.touch(t, today);
    this.commit(t);
    this.moveToCategory(lineIndex, category);
  }

  private moveToCategory(lineIndex: number, category: string): void {
    const shift = this.ensureSection(category);
    const idx = lineIndex + shift;
    const t = this.get(idx);
    if (!t || t.category === category) {
      this.parse();
      return;
    }
    const pos = this.insertPositionFor(category, idx);
    this.moveBlock(t, pos);
    this.parse();
  }
}

// ------------------------------------------------------------------ 排序与精选
export type SortKey = "priority" | "created" | "due" | "overdue" | "finished";

/** 排序用的到期时间：手填截止优先，否则按"创建 + 3 天"推导。这个值不写进 md。 */
export function effectiveDue(t: Todo): string | null {
  if (t.due) return t.due;
  return t.created ? addDays(t.created, 3) : null;
}

/** 超期资格只由手填的截止日期赋予——推导出来的有效到期不算。 */
export function isOverdue(t: Todo, today: string): boolean {
  return t.status === "open" && !!t.due && t.due < today;
}

export function overdueDays(t: Todo, today: string): number {
  return t.due ? diffDays(t.due, today) : 0;
}

/** 检查项进度。total 为 0 时界面不显示这个刻度。 */
export function checklistProgress(t: Todo): { done: number; total: number } {
  return { done: t.checklist.filter((c) => c.done).length, total: t.checklist.length };
}

/** 结束日期：完成或放弃的那天。 */
export function finishedAt(t: Todo): string | null {
  return t.done ?? t.cancelled;
}

// null 一律排在最后
function cmpNullable(a: string | null, b: string | null, desc = false): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return desc ? (a < b ? 1 : -1) : a < b ? -1 : 1;
}

function cmpFeatured(a: Todo, b: Todo): number {
  const r = priorityRank(b.priority) - priorityRank(a.priority);
  if (r !== 0) return r;
  const d = cmpNullable(effectiveDue(a), effectiveDue(b));
  if (d !== 0) return d;
  return a.lineIndex - b.lineIndex;
}

export function sortTodos(todos: Todo[], key: SortKey, today: string = todayStr()): Todo[] {
  const list = [...todos];
  switch (key) {
    case "priority":
      return list.sort(cmpFeatured);
    case "created":
      // 新建的在前
      return list.sort((a, b) => cmpNullable(a.created, b.created, true) || a.lineIndex - b.lineIndex);
    case "due":
      return list.sort((a, b) => cmpNullable(a.due, b.due) || a.lineIndex - b.lineIndex);
    case "overdue":
      // 超得最久的在前
      return list.sort(
        (a, b) => overdueDays(b, today) - overdueDays(a, today) || a.lineIndex - b.lineIndex,
      );
    case "finished":
      // 最近结束的在前
      return list.sort(
        (a, b) => cmpNullable(finishedAt(a), finishedAt(b), true) || a.lineIndex - b.lineIndex,
      );
  }
}

/**
 * 精选六条。
 * 前 5 条按 优先级 → 有效到期 排；第 6 条是配额位，留给"重要（不紧急）"档里
 * 创建最早的那条，防止这一档永久沉底。没有创建日期的条目参与不了这个比较。
 */
export function pickFeatured(todos: Todo[], today: string = todayStr()): Todo[] {
  const open = todos.filter((t) => t.status === "open");
  const ranked = [...open].sort(cmpFeatured);
  if (ranked.length <= 6) return ranked;

  const top5 = ranked.slice(0, 5);
  const oldestMedium = open
    .filter((t) => t.priority === "medium" && t.created)
    .sort((a, b) => cmpNullable(a.created, b.created) || a.lineIndex - b.lineIndex)
    .find((t) => !top5.includes(t));

  const sixth = oldestMedium ?? ranked[5];
  return [...top5, sixth];
}
