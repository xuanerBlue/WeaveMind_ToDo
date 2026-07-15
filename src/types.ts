// 优先级，与 Obsidian Tasks 插件的 emoji 语义对齐
export type Priority = "highest" | "high" | "medium" | "none" | "low" | "lowest";

// 一条待办事项。description 保留原始文字（含 #标签），但不含
// 优先级/截止/完成日期这些结构化元数据 —— 它们被单独抽出来，
// 序列化时再按 Tasks 规范拼回行尾，保证与 Obsidian 双向兼容。
export interface Todo {
  lineIndex: number;   // 在文件行数组中的下标（新建但未写入时为 -1）
  indent: string;      // 前导缩进（保留子任务层级）
  bullet: string;      // 列表符号 "-" / "*" / "+"
  checked: boolean;    // 是否完成
  description: string; // 任务正文（含 #标签，不含 emoji 元数据）
  priority: Priority;
  due: string | null;  // 截止日期 YYYY-MM-DD
  done: string | null; // 完成日期 YYYY-MM-DD
  tags: string[];      // 从正文抽取的 #标签（仅用于展示/筛选，正文里仍保留）
}

// 应用配置（持久化到 app config 目录）
export interface AppConfig {
  todoFilePath: string | null; // 选定的 Todo.md 绝对路径
  ballPosition?: { x: number; y: number }; // 悬浮球上次位置
}
