import type { Priority, Todo } from "./types";

// 优先级 → emoji（Obsidian Tasks 规范）
export const PRIORITY_EMOJI: Record<Exclude<Priority, "none">, string> = {
  highest: "🔺",
  high: "⏫",
  medium: "🔼",
  low: "🔽",
  lowest: "⏬",
};

// emoji → 优先级（反查）
const EMOJI_PRIORITY: Record<string, Priority> = {
  "🔺": "highest",
  "⏫": "high",
  "🔼": "medium",
  "🔽": "low",
  "⏬": "lowest",
};

// 排序权重：无优先级排在 medium 与 low 之间（与 Tasks 一致）
const PRIORITY_RANK: Record<Priority, number> = {
  highest: 5,
  high: 4,
  medium: 3,
  none: 2,
  low: 1,
  lowest: 0,
};

// 匹配复选框任务行，支持 - * + 三种列表符号
const TASK_RE = /^(\s*)([-*+]) \[([ xX])\] (.*)$/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const TAG_RE = /(?:^|\s)(#[^\s#]+)/g;

// 探测文件主导的换行风格，写回时保持一致（Windows 上 Obsidian 常用 CRLF）
function detectEol(content: string): string {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? "\r\n" : "\n";
}

// 从任务正文中抽取结构化元数据，返回剩余正文（保留 #标签）
function extractMeta(rest: string): {
  description: string;
  priority: Priority;
  due: string | null;
  done: string | null;
  tags: string[];
} {
  // 归一化：去掉 emoji 变体选择符 U+FE0F、把不间断空格 U+00A0 变成普通空格，
  // 否则 "⏫️" 之类会导致 emoji 匹配后残留半个字符（Tasks 文档明确的坑）。
  let text = rest.replace(/️/g, "").replace(/ /g, " ");

  let priority: Priority = "none";
  for (const [emoji, p] of Object.entries(EMOJI_PRIORITY)) {
    if (text.includes(emoji)) {
      priority = p;
      text = text.replace(emoji, " ");
      break;
    }
  }

  let due: string | null = null;
  const dm = DUE_RE.exec(text);
  if (dm) {
    due = dm[1];
    text = text.replace(DUE_RE, " ");
  }

  let done: string | null = null;
  const dnm = DONE_RE.exec(text);
  if (dnm) {
    done = dnm[1];
    text = text.replace(DONE_RE, " ");
  }

  const tags: string[] = [];
  let tm: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((tm = TAG_RE.exec(text)) !== null) tags.push(tm[1]);

  const description = text.replace(/\s+/g, " ").trim();
  return { description, priority, due, done, tags };
}

/**
 * TodoDoc：一份 Todo.md 的可变文档模型。
 * - 只改动任务行，其它内容（标题、正文、空行）逐字节保留。
 * - 未改动的任务行也保持原样，仅被修改的行才按规范重写，降低 diff 噪音。
 * - 所有变更操作按 lineIndex 定位，改完立即 reparse 以保证下标一致。
 */
export class TodoDoc {
  lines: string[];
  eol: string;
  todos: Todo[] = [];

  constructor(content: string) {
    this.eol = detectEol(content);
    this.lines = content.split(/\r\n|\n/);
    this.parse();
  }

  private parse(): void {
    this.todos = [];
    this.lines.forEach((line, i) => {
      const m = TASK_RE.exec(line);
      if (!m) return;
      const [, indent, bullet, mark, rest] = m;
      const meta = extractMeta(rest);
      this.todos.push({
        lineIndex: i,
        indent,
        bullet,
        checked: mark.toLowerCase() === "x",
        description: meta.description,
        priority: meta.priority,
        due: meta.due,
        done: meta.done,
        tags: meta.tags,
      });
    });
  }

  toString(): string {
    return this.lines.join(this.eol);
  }

  private serialize(t: Todo): string {
    const parts: string[] = [t.description];
    if (t.priority !== "none") parts.push(PRIORITY_EMOJI[t.priority]);
    if (t.due) parts.push(`📅 ${t.due}`);
    if (t.done) parts.push(`✅ ${t.done}`);
    const body = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return `${t.indent}${t.bullet} [${t.checked ? "x" : " "}] ${body}`;
  }

  private find(lineIndex: number): Todo | undefined {
    return this.todos.find((t) => t.lineIndex === lineIndex);
  }

  private commit(t: Todo): void {
    this.lines[t.lineIndex] = this.serialize(t);
  }

  /** 勾选/取消完成。勾选时写入完成日期（today: YYYY-MM-DD），取消时清除。 */
  toggle(lineIndex: number, today: string): void {
    const t = this.find(lineIndex);
    if (!t) return;
    t.checked = !t.checked;
    t.done = t.checked ? today : null;
    this.commit(t);
  }

  /** 内联编辑正文；用户新输入里若带 emoji 元数据会被重新解析。 */
  setText(lineIndex: number, newRawText: string): void {
    const t = this.find(lineIndex);
    if (!t) return;
    const meta = extractMeta(newRawText);
    t.description = meta.description;
    t.priority = meta.priority;
    t.due = meta.due;
    t.tags = meta.tags;
    this.commit(t);
  }

  setPriority(lineIndex: number, p: Priority): void {
    const t = this.find(lineIndex);
    if (!t) return;
    t.priority = p;
    this.commit(t);
  }

  setDue(lineIndex: number, due: string | null): void {
    const t = this.find(lineIndex);
    if (!t) return;
    t.due = due;
    this.commit(t);
  }

  remove(lineIndex: number): void {
    this.lines.splice(lineIndex, 1);
    this.parse();
  }

  /** 新增一条待办，追加到文件末尾。 */
  add(rawText: string): void {
    const meta = extractMeta(rawText);
    const todo: Todo = {
      lineIndex: 0,
      indent: "",
      bullet: "-",
      checked: false,
      description: meta.description,
      priority: meta.priority,
      due: meta.due,
      done: null,
      tags: meta.tags,
    };
    const line = this.serialize(todo);
    // 文件为空（只有一行空串）时直接填入，否则追加
    if (this.lines.length === 1 && this.lines[0].trim() === "") {
      this.lines[0] = line;
    } else {
      this.lines.push(line);
    }
    this.parse();
  }
}

/** 展示排序：未完成在前 → 优先级高在前 → 截止日期近在前。 */
export function sortTodos(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    if (a.checked !== b.checked) return a.checked ? 1 : -1;
    if (PRIORITY_RANK[b.priority] !== PRIORITY_RANK[a.priority]) {
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    }
    const ad = a.due ?? "9999-99-99";
    const bd = b.due ?? "9999-99-99";
    if (ad !== bd) return ad < bd ? -1 : 1;
    return a.lineIndex - b.lineIndex;
  });
}
