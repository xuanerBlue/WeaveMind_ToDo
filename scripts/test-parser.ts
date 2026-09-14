// 解析器验收用例。直接跑：node scripts/test-parser.ts
// （Node 22.6+ 原生剥离 TS 类型，不需要额外依赖）
import {
  TodoDoc,
  pickFeatured,
  effectiveDue,
  isOverdue,
  sortTodos,
  DEFAULT_CATEGORY,
  FILE_SKELETON,
  FORMAT_NOTE,
  FORMAT_NOTE_HEADING,
} from "../src/todo-parser.ts";

let pass = 0;
const fails: string[] = [];

function ok(cond: boolean, msg: string): void {
  if (cond) pass++;
  else fails.push(msg);
}
function eq(a: unknown, b: unknown, msg: string): void {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) pass++;
  else fails.push(`${msg}\n    实际: ${JSON.stringify(a)}\n    期望: ${JSON.stringify(b)}`);
}
function group(name: string): void {
  console.log(`\n── ${name}`);
}

const TODAY = "2026-09-09";
const descs = (d: TodoDoc) => d.todos.map((t) => t.description);

// ------------------------------------------------------------------
group("1. 老文件：平铺、无 frontmatter、无创建日期");
{
  const src = ["- [x] 甲 ✅ 2026-07-20", "- [ ] 乙 ⏫", "- [ ] 丙 🔽", "", "## 备注", "随手写的一段话"].join("\n");
  const d = new TodoDoc(src);
  eq(d.todos.length, 3, "应解析出 3 条");
  eq(d.todos.map((t) => t.status), ["done", "open", "open"], "三态解析");
  eq(d.todos.map((t) => t.priority), ["none", "high", "low"], "🔽 保留为 low 档");
  eq(d.todos.map((t) => t.created), [null, null, null], "读取时不补创建日期");
  eq(d.todos.map((t) => t.category), [DEFAULT_CATEGORY, DEFAULT_CATEGORY, DEFAULT_CATEGORY], "全部归默认类别");
  eq(d.toString(), src, "纯读取不改动文件一个字节");
}

group("2. 首次被操作时才补写 ➕");
{
  const d = new TodoDoc(["- [ ] 甲", "- [ ] 乙"].join("\n"));
  d.setPriority(0, "highest", TODAY);
  eq(d.todos[0].created, TODAY, "被改的那条补上创建日期");
  eq(d.todos[1].created, null, "没动过的那条不补");
  eq(d.lines[0], "- [ ] 甲 🔺 ➕ 2026-09-09", "写回格式");
}

group("3. 分区归属：类别分区 / 非类别标题 / 隐式默认区");
{
  const src = [
    "---",
    "weave-id: abc",
    "categories: [默认, 工作]",
    "---",
    "",
    "- [ ] 顶部",
    "",
    "## 工作",
    "- [ ] 工作项",
    "",
    "## 备注",
    "- [ ] 备注项",
  ].join("\n");
  const d = new TodoDoc(src);
  eq(d.categories, ["默认", "工作"], "读出 categories 清单");
  eq(d.todos.map((t) => t.category), ["默认", "工作", "默认"], "归属判定");
  eq(d.todos.map((t) => t.movable), [true, true, false], "非类别标题下的条目不可自动移动");
  eq(d.toString(), src, "解析不改文件");
}

group("4. 完成即沉底（仅限可移动的条目）");
{
  const d = new TodoDoc(["---", "categories: [默认, 工作]", "---", "## 工作", "- [ ] 甲", "- [ ] 乙", "- [ ] 丙"].join("\n"));
  const jia = d.todos.find((t) => t.description === "甲")!;
  d.complete(jia.lineIndex, TODAY);
  eq(descs(d), ["乙", "丙", "甲"], "完成的沉到本分区底部");
  eq(d.todos[2].status, "done", "状态为已完成");
  ok(d.lines.some((l) => l.includes("- [x] 甲 ➕ 2026-09-09 ✅ 2026-09-09")), "写回格式含 ➕ 与 ✅");
}
{
  const d = new TodoDoc(["## 备注", "- [ ] 甲", "- [ ] 乙"].join("\n"));
  d.complete(1, TODAY);
  eq(descs(d), ["甲", "乙"], "非类别标题下：完成不移动行，保护用户排版");
}

group("5. 我不做了：留痕、沉底、可被重新打开");
{
  const d = new TodoDoc(["---", "categories: [默认]", "---", "- [ ] 甲", "- [ ] 乙"].join("\n"));
  const jia = d.todos[0].lineIndex;
  d.cancel(jia, TODAY);
  eq(descs(d), ["乙", "甲"], "放弃的沉底");
  eq(d.todos[1].status, "cancelled", "状态为已放弃");
  ok(d.lines.some((l) => l.includes("- [-] 甲 ➕ 2026-09-09 ❌ 2026-09-09")), "写回 [-] 与 ❌");
  const back = new TodoDoc(d.toString());
  eq(back.todos.map((t) => t.status), ["open", "cancelled"], "往返解析保持三态");
  back.reopen(back.todos[1].lineIndex, TODAY);
  eq(back.todos.map((t) => t.status), ["open", "open"], "重新打开");
  eq(back.todos.map((t) => t.cancelled), [null, null], "放弃日期被清掉");
}

group("6. 新增：落到目标分区未完成区的末尾");
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作]", "---", "## 工作", "- [ ] 甲", "- [x] 旧 ✅ 2026-09-01"].join("\n"),
  );
  d.add("新条目", "工作", TODAY);
  eq(descs(d), ["甲", "新条目", "旧"], "插在未完成区末尾、已完成之前");
  eq(d.todos[1].created, TODAY, "新条目带创建日期");
}
{
  // 类别不存在 → 建分区并写进 frontmatter
  const d = new TodoDoc(["- [ ] 甲"].join("\n"));
  d.add("学习一下", "学习", TODAY);
  ok(d.categories.includes("学习"), "新类别写进 categories");
  ok(d.lines.some((l) => l.trim() === "## 学习"), "创建了分区标题");
  ok(d.lines[0].trim() === "---", "补出了 frontmatter");
  const back = new TodoDoc(d.toString());
  eq(back.todos.find((t) => t.description === "学习一下")!.category, "学习", "往返后归属正确");
}
{
  // 老的平铺文件：没有任何标题时，新条目追加到末尾
  const d = new TodoDoc(["- [ ] 甲", "- [ ] 乙"].join("\n"));
  d.add("丙", DEFAULT_CATEGORY, TODAY);
  eq(descs(d), ["甲", "乙", "丙"], "平铺文件不被强行加标题");
  ok(!d.lines.some((l) => l.startsWith("#")), "确实没加标题");
}

group("7. 类别管理");
{
  const d = new TodoDoc(["---", "categories: [默认, 工作]", "---", "## 工作", "- [ ] 甲"].join("\n"));
  d.renameCategory("工作", "九安");
  eq(d.categories, ["默认", "九安"], "frontmatter 清单已改");
  ok(d.lines.some((l) => l.trim() === "## 九安"), "分区标题已改");
  eq(d.todos[0].category, "九安", "任务归属跟着走，没落到不存在的类别上");
}
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作]", "---", "- [ ] 顶部", "", "## 工作", "- [ ] 甲", "- [ ] 乙"].join("\n"),
  );
  d.removeCategory("工作");
  eq(d.categories, ["默认"], "类别已删");
  ok(!d.lines.some((l) => l.trim() === "## 工作"), "标题已删");
  eq(d.todos.length, 3, "任务一条没少");
  eq(d.todos.map((t) => t.category), ["默认", "默认", "默认"], "任务全部移到默认");
}

group("8. 有效到期只用于排序，超期只认手填的截止日");
{
  const d = new TodoDoc(
    ["- [ ] 随手记 ➕ 2026-08-01", "- [ ] 有截止 ➕ 2026-08-01 📅 2026-09-01", "- [ ] 光秃秃"].join("\n"),
  );
  const [a, b, c] = d.todos;
  eq(effectiveDue(a), "2026-08-04", "无截止时按创建 + 3 天推导");
  eq(effectiveDue(b), "2026-09-01", "有截止时用手填的");
  eq(effectiveDue(c), null, "无创建无截止 → 无限远");
  eq(isOverdue(a, TODAY), false, "随手记的不会因为默认三天变超期");
  eq(isOverdue(b, TODAY), true, "手填的截止日过了才算超期");
  eq(isOverdue(c, TODAY), false, "光秃秃的不超期");
  ok(!d.toString().includes("2026-08-04"), "推导出来的到期不写进文件");
}

group("9. 精选：前 5 条按序 + 第 6 条配额位");
{
  const mk = (n: string, p: string, created: string, due?: string) =>
    `- [ ] ${n} ${p} ➕ ${created}${due ? ` 📅 ${due}` : ""}`.replace("  ", " ");
  const d = new TodoDoc(
    [
      mk("h1", "🔺", "2026-09-01"),
      mk("h2", "🔺", "2026-09-02"),
      mk("g1", "⏫", "2026-09-01"),
      mk("g2", "⏫", "2026-09-02"),
      mk("g3", "⏫", "2026-09-03"),
      mk("g4", "⏫", "2026-09-04"),
      mk("m1", "🔼", "2026-08-01"),
      mk("m2", "🔼", "2026-08-15"),
      mk("n1", "", "2026-09-01"),
    ].join("\n"),
  );
  const picked = pickFeatured(d.todos, TODAY).map((t) => t.description);
  eq(picked, ["h1", "h2", "g1", "g2", "g3", "m1"], "第 6 条被重要档最老的那条占住，把 g4 挤掉");
}
{
  // 重要档全部已落在前 5 内 → 第 6 条退回按序补位
  const d = new TodoDoc(
    [
      "- [ ] h1 🔺 ➕ 2026-09-01",
      "- [ ] g1 ⏫ ➕ 2026-09-01",
      "- [ ] m1 🔼 ➕ 2026-08-01",
      "- [ ] m2 🔼 ➕ 2026-08-15",
      "- [ ] m3 🔼 ➕ 2026-08-20",
      "- [ ] n1 ➕ 2026-09-01",
      "- [ ] n2 ➕ 2026-09-02",
    ].join("\n"),
  );
  const picked = pickFeatured(d.todos, TODAY).map((t) => t.description);
  eq(picked, ["h1", "g1", "m1", "m2", "m3", "n1"], "没有可用的配额条目时按序补第 6 条");
}
{
  const d = new TodoDoc(["- [ ] a ➕ 2026-09-01", "- [x] b ✅ 2026-09-01", "- [-] c ❌ 2026-09-01"].join("\n"));
  eq(pickFeatured(d.todos, TODAY).map((t) => t.description), ["a"], "只收未完成的，不足 6 条全给");
}

group("10. 排序键");
{
  const d = new TodoDoc(
    [
      "- [ ] 早 ➕ 2026-08-01 📅 2026-08-20",
      "- [ ] 晚 ➕ 2026-09-05 📅 2026-09-30",
      "- [x] 完 ➕ 2026-08-01 ✅ 2026-09-08",
      "- [-] 弃 ➕ 2026-08-01 ❌ 2026-09-07",
    ].join("\n"),
  );
  eq(sortTodos(d.todos, "created", TODAY).map((t) => t.description)[0], "晚", "创建时间：新的在前");
  eq(sortTodos(d.todos, "due", TODAY).map((t) => t.description)[0], "早", "截止时间：近的在前");
  eq(sortTodos(d.todos.filter((t) => t.status === "open"), "overdue", TODAY).map((t) => t.description)[0], "早", "超期时长：超得久的在前");
  eq(
    sortTodos(d.todos.filter((t) => t.status !== "open"), "finished", TODAY).map((t) => t.description),
    ["完", "弃"],
    "结束时间：最近结束的在前",
  );
}

group("11. 非任务内容与换行风格原样保留");
{
  const src = ["# 我的待办", "", "- [ ] 甲", "", "## 备注", "", "这一段普通文字不该被动。", ""].join("\r\n");
  const d = new TodoDoc(src);
  d.complete(d.todos[0].lineIndex, TODAY);
  const out = d.toString();
  ok(out.includes("\r\n"), "CRLF 换行保持");
  ok(out.includes("这一段普通文字不该被动。"), "自由段落保留");
  ok(out.includes("# 我的待办"), "用户自己的一级标题保留");
}

group("11b. 删类别不留下堆积的空行");
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作, 学习]", "---", "", "- [ ] 顶部", "", "## 工作", "", "- [ ] 甲", "", "## 学习", "", "- [ ] 乙"].join("\n"),
  );
  d.removeCategory("工作");
  const out = d.toString();
  ok(!/\n\n\n/.test(out), "不出现连续两个以上空行");
  eq(d.todos.map((t) => t.category), ["默认", "默认", "学习"], "任务归属正确");
  ok(out.includes("## 学习"), "另一个分区的标题还在");
}

group("12. 改归属：行被移到目标分区");
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作, 学习]", "---", "- [ ] 顶部", "", "## 工作", "- [ ] 甲", "", "## 学习", "- [ ] 乙"].join("\n"),
  );
  const jia = d.todos.find((t) => t.description === "甲")!;
  d.setCategory(jia.lineIndex, "学习", TODAY);
  const moved = d.todos.find((t) => t.description === "甲")!;
  eq(moved.category, "学习", "归属已改");
  eq(descs(d), ["顶部", "乙", "甲"], "行确实移到了目标分区内");
  const back = new TodoDoc(d.toString());
  eq(back.todos.find((t) => t.description === "甲")!.category, "学习", "往返后仍在学习分区");
}
{
  // 移到尚不存在的类别：建分区 + 写 frontmatter，且原条目的 lineIndex 偏移要被正确修正
  const d = new TodoDoc(["- [ ] 甲", "- [ ] 乙"].join("\n"));
  d.setCategory(1, "工作", TODAY);
  const yi = d.todos.find((t) => t.description === "乙")!;
  eq(yi.category, "工作", "frontmatter 插入导致行号整体下移后，仍改对了目标条目");
  eq(d.todos.find((t) => t.description === "甲")!.category, DEFAULT_CATEGORY, "另一条没被误伤");
}

group("13. 勾选框往返");
{
  const d = new TodoDoc(["---", "categories: [默认]", "---", "- [ ] 甲", "- [ ] 乙"].join("\n"));
  const jia = d.todos[0].lineIndex;
  d.toggle(jia, TODAY);
  eq(d.todos.map((t) => [t.description, t.status]), [["乙", "open"], ["甲", "done"]], "勾选后沉底");
  d.toggle(d.todos[1].lineIndex, TODAY);
  eq(d.todos.map((t) => [t.description, t.status]), [["乙", "open"], ["甲", "open"]], "取消勾选回到未完成区末尾");
  eq(d.todos.find((t) => t.description === "甲")!.done, null, "完成日期被清掉");
}

group("14. 多行写法的 categories");
{
  const d = new TodoDoc(
    ["---", "categories:", "  - 默认", "  - 工作", "weave-id: abc", "---", "## 工作", "- [ ] 甲"].join("\n"),
  );
  eq(d.categories, ["默认", "工作"], "多行 YAML 列表能读出来");
  eq(d.todos[0].category, "工作", "分区归属正确");
  d.addCategory("学习");
  eq(d.categories, ["默认", "工作", "学习"], "新增后清单正确");
  ok(d.lines.some((l) => l.startsWith("categories: [")), "写回时归一成行内数组");
  ok(d.lines.some((l) => l.trim() === "weave-id: abc"), "frontmatter 里的其它字段没被冲掉");
  eq(new TodoDoc(d.toString()).categories, ["默认", "工作", "学习"], "往返一致");
}

group("15. 描述与检查项：缩进子块属于父任务，不是独立待办");
{
  const src = [
    "- [ ] 父任务 ⏫ ➕ 2026-09-01",
    "  这是一段描述，",
    "  写了两行。",
    "  - [ ] 检查项甲",
    "  - [x] 检查项乙",
    "- [ ] 另一条",
  ].join("\n");
  const d = new TodoDoc(src);
  eq(descs(d), ["父任务", "另一条"], "检查项不算独立待办");
  eq(d.todos[0].detail, "这是一段描述，\n写了两行。", "描述去掉公共缩进后读出");
  eq(d.todos[0].checklist.map((c) => [c.text, c.done]), [["检查项甲", false], ["检查项乙", true]], "检查项与勾选状态");
  eq(d.todos[0].blockEnd, 4, "块范围到最后一个检查项");
  eq(d.todos[1].blockEnd, 5, "没有子块时 blockEnd 等于 lineIndex");
  eq(d.toString(), src, "纯读取不改动文件一个字节");
}
{
  // tab 缩进 + 三层嵌套：都算这条待办的检查项，不各自成条
  const d = new TodoDoc(["- [ ] 父", "\t- [ ] 子", "\t\t- [ ] 孙"].join("\n"));
  eq(descs(d), ["父"], "更深层级仍归到最外层那条");
  eq(d.todos[0].checklist.length, 2, "两个检查项");
}

group("16. 写回：描述在前、检查项在后，[-] 不被篡改");
{
  const d = new TodoDoc(["- [ ] 甲"].join("\n"));
  d.setChecklist(0, [
    { text: "一", done: false, mark: " " },
    { text: "二", done: true, mark: "x" },
    { text: "", done: false, mark: " " },
  ], TODAY);
  d.setDetail(0, "说明", TODAY);
  eq(d.lines, ["- [ ] 甲 ➕ 2026-09-09", "    说明", "    - [ ] 一", "    - [x] 二"], "描述在前检查项在后，空检查项被丢掉");
  eq(new TodoDoc(d.toString()).todos[0].checklist.length, 2, "往返一致");

  d.toggleChecklistItem(0, 0, TODAY);
  eq(d.todos[0].checklist.map((c) => c.done), [true, true], "单项勾选");
  ok(!d.toString().includes("✅"), "检查项不写完成日期");
}
{
  // 用户手写的 [-] 在没被动过时原样保留
  const d = new TodoDoc(["- [ ] 甲", "  - [-] 放弃掉的子项"].join("\n"));
  d.setDetail(0, "说明", TODAY);
  ok(d.lines.some((l) => l.includes("- [-] 放弃掉的子项")), "[-] 写回时不被改成 [x]");
}

group("17. 块移动：完成沉底、改归属，描述和检查项跟着走");
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作]", "---", "## 工作", "- [ ] 甲", "  说明甲", "  - [ ] 子甲", "- [ ] 乙"].join("\n"),
  );
  const jia = d.todos.find((t) => t.description === "甲")!;
  d.complete(jia.lineIndex, TODAY);
  eq(descs(d), ["乙", "甲"], "甲沉底");
  const moved = d.todos.find((t) => t.description === "甲")!;
  eq(moved.detail, "说明甲", "描述跟着走");
  eq(moved.checklist.map((c) => c.text), ["子甲"], "检查项跟着走");
  eq(d.lines.filter((l) => l.includes("说明甲")).length, 1, "没有被复制成两份");
  eq(d.todos.find((t) => t.description === "乙")!.checklist, [], "乙没被误伤");
}
{
  const d = new TodoDoc(
    ["---", "categories: [默认, 工作, 学习]", "---", "- [ ] 顶部", "", "## 工作", "- [ ] 甲", "  - [ ] 子甲", "", "## 学习", "- [ ] 乙"].join("\n"),
  );
  const jia = d.todos.find((t) => t.description === "甲")!;
  d.setCategory(jia.lineIndex, "学习", TODAY);
  const moved = d.todos.find((t) => t.description === "甲")!;
  eq(moved.category, "学习", "归属已改");
  eq(moved.checklist.map((c) => c.text), ["子甲"], "检查项跟到了新分区");
  eq(new TodoDoc(d.toString()).todos.length, 3, "往返后仍是三条待办");
}
{
  // 新建时带描述和检查项，返回的 lineIndex 要指向那条新待办
  const d = new TodoDoc(["---", "categories: [默认]", "---", "- [ ] 甲"].join("\n"));
  const at = d.add("乙", DEFAULT_CATEGORY, TODAY, {
    detail: "两行\n描述",
    checklist: [{ text: "子乙", done: false, mark: " " }],
  });
  eq(d.get(at)!.description, "乙", "返回的行号指向新条目");
  eq(d.get(at)!.checklist.map((c) => c.text), ["子乙"], "检查项一并写入");
  eq(descs(d), ["甲", "乙"], "落在未完成区末尾");
}

group("18. 文末格式说明：它自己不能被当成待办");
{
  const d = new TodoDoc(FILE_SKELETON);
  eq(d.todos.length, 0, "新建骨架里一条待办都没有——说明里的示例复选框包在引用块里");
  eq(d.categories, [DEFAULT_CATEGORY], "只有内置类别");
  ok(d.lines.some((l) => l.trim() === FORMAT_NOTE_HEADING), "说明标题在");

  // 新建的条目要落在说明之前，不能跑到说明底下
  d.add("第一条", DEFAULT_CATEGORY, TODAY);
  const noteAt = d.lines.findIndex((l) => l.trim() === FORMAT_NOTE_HEADING);
  ok(d.todos[0].lineIndex < noteAt, "新条目插在说明之前");
  eq(d.todos.length, 1, "加完仍只有这一条待办");
}
{
  // 说明是非类别标题，它下面的东西不参与任何自动移动
  const d = new TodoDoc(["---", "categories: [默认]", "---", "- [ ] 甲", "", FORMAT_NOTE].join("\n"));
  eq(descs(d), ["甲"], "说明没制造出幽灵待办");
  d.complete(d.todos[0].lineIndex, TODAY);
  const back = new TodoDoc(d.toString());
  eq(descs(back), ["甲"], "完成沉底之后也没有");
  ok(back.toString().includes("> - [ ] 写周报"), "说明原文一字未动");
}

// ------------------------------------------------------------------
console.log(`\n${"─".repeat(50)}`);
if (fails.length) {
  console.log(`✗ ${fails.length} 条失败，${pass} 条通过\n`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log(`✓ 全部 ${pass} 条断言通过`);
}
