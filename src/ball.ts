import "./styles/ball.css";
import { TodoDoc } from "./todo-parser";
import type { AppConfig } from "./types";
import * as bridge from "./bridge";

const ballEl = document.getElementById("ball")!;
const badgeEl = document.getElementById("badge")!;

let config: AppConfig = { todoFilePath: null };

// 拖拽 vs 点击判定阈值（像素）
const DRAG_THRESHOLD = 4;

function updateBadge(pending: number): void {
  if (pending > 0) {
    badgeEl.textContent = pending > 99 ? "99+" : String(pending);
    badgeEl.classList.add("show");
  } else {
    badgeEl.classList.remove("show");
  }
}

async function refreshCount(): Promise<void> {
  if (!config.todoFilePath) {
    updateBadge(0);
    return;
  }
  try {
    const content = await bridge.readTodoFile(config.todoFilePath);
    const doc = new TodoDoc(content);
    updateBadge(doc.todos.filter((t) => t.status === "open").length);
  } catch {
    updateBadge(0);
  }
}

// 请求切换面板（点击悬浮球或托盘菜单都走这里）
async function requestToggle(): Promise<void> {
  const geom = await bridge.getBallGeometry();
  await bridge.emitTogglePanel(geom);
}

// 按下悬浮球：移动超过阈值 → 交给系统拖拽；否则松开算一次点击 → 切换面板
ballEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const startX = e.screenX;
  const startY = e.screenY;
  let dragging = false;

  const onMove = (me: MouseEvent) => {
    if (dragging) return;
    if (
      Math.abs(me.screenX - startX) > DRAG_THRESHOLD ||
      Math.abs(me.screenY - startY) > DRAG_THRESHOLD
    ) {
      dragging = true;
      ballEl.classList.add("dragging");
      cleanup();
      void bridge.startBallDrag(); // 系统接管拖拽，之后不再触发点击
      // 拖拽期间收不到 mouseup，延时清除视觉态
      setTimeout(() => ballEl.classList.remove("dragging"), 400);
    }
  };

  const onUp = () => {
    cleanup();
    if (!dragging) void requestToggle();
  };

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

async function init(): Promise<void> {
  config = await bridge.loadConfig();

  if (config.ballPosition) {
    await bridge.setBallPosition(config.ballPosition.x, config.ballPosition.y);
  }

  // 拖动后记住位置（防抖写入）。写前先读最新配置再合并，避免覆盖
  // 面板刚保存的 todoFilePath（两个窗口写同一个 settings.json）。
  let saveTimer: number | null = null;
  await bridge.onBallMoved((x, y) => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const latest = await bridge.loadConfig();
      latest.ballPosition = { x, y };
      await bridge.saveConfig(latest);
      config = latest;
    }, 400);
  });

  // 面板写入待办后，刷新角标数字
  await bridge.onTodosChanged(updateBadge);

  // 托盘菜单「显示/隐藏面板」
  await bridge.onTrayShowPanel(() => void requestToggle());

  await refreshCount();
}

void init();
