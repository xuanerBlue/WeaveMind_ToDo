// 优先级。需求只用四档：highest（重要且紧急）> high（紧急）> medium（重要）> none（一般）。
// low / lowest 仅用于兼容已有 md 文件里的 🔽 ⏬——解析时保留不篡改，排序并入 none，
// 界面显示为只读的灰底「低」，表单不提供这两个选项。
export type Priority = "highest" | "high" | "medium" | "none" | "low" | "lowest";

// 三态：未做 / 已完成 / 已放弃（"我不做了"）。放弃留痕，不删除。
export type TodoStatus = "open" | "done" | "cancelled";

// 检查项（子任务）。它不是独立待办：不进任何视图、不参与精选与归档、不计入球上的数字，
// 只跟着父任务走。text 是整段原文，不抽取优先级与日期——检查项没有这些字段。
export interface ChecklistItem {
  text: string;
  done: boolean;
  mark: string; // md 里的原始标记。用户手写的 [-] 在没被动过时原样写回
}

// 一条待办。description 保留正文原文（含用户手写的 #标签），
// 结构化元数据被单独抽出，序列化时再按固定顺序拼回行尾。
//
// 一条待办在文件里占的不止一行：任务行之下缩进的那一段（描述 + 检查项）同属这条待办，
// 合称它的「块」，范围是 [lineIndex, blockEnd]。凡是移动行的地方都必须整块移动。
export interface Todo {
  lineIndex: number; // 任务行在文件行数组中的下标
  blockEnd: number; // 块的最后一行；没有描述也没有检查项时等于 lineIndex
  detail: string; // 详细描述，多行。空串表示没写
  checklist: ChecklistItem[];
  indent: string; // 前导缩进（保留子任务层级）
  bullet: string; // 列表符号 "-" / "*" / "+"
  status: TodoStatus;
  description: string;
  priority: Priority;
  created: string | null; // ➕ 创建日期
  due: string | null; // 📅 截止日期。只有手填才有，有它才有"超期"资格
  done: string | null; // ✅ 完成日期
  cancelled: string | null; // ❌ 放弃日期
  category: string; // 所属类别
  movable: boolean; // 是否允许行移动（在类别分区或隐式默认区内才允许）
}

// 文件里的一个区段。类别靠 "## 标题" 表达；
// 不在 frontmatter categories 清单里的标题（如 "## 备注"）isCategory 为 false，
// 其下的任务归"默认"类别参与展示，但不参与行移动。
export interface Section {
  headingLine: number; // 标题所在行号；-1 表示"隐式默认区"（首个标题之前的区域）
  name: string;
  isCategory: boolean;
  start: number; // 内容起始行（含）
  end: number; // 内容结束行（含）
}

// 应用配置（持久化到 app config 目录）
export interface AppConfig {
  todoFilePath: string | null; // 选定的 Todo.md 绝对路径
  ballPosition?: { x: number; y: number }; // 悬浮球上次位置
}
