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

/** 球的中心是否落在某块显示器里。 */
function centerVisible(
  pos: { x: number; y: number },
  size: { w: number; h: number },
  monitors: bridge.MonitorRect[],
): boolean {
  const cx = pos.x + size.w / 2;
  const cy = pos.y + size.h / 2;
  return monitors.some((m) => cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h);
}

/**
 * 兜底位置：主屏右下角，留出 Dock / 任务栏的地方。
 * 边距按 scale 折算——这里的坐标是物理像素，写死 40 在 2 倍屏上只有半个边距。
 */
function fallbackPosition(
  primary: bridge.MonitorRect,
  size: { w: number; h: number },
  scale: number,
): { x: number; y: number } {
  const side = 24 * scale;
  const bottom = 80 * scale; // 躲开 Dock / 任务栏
  return {
    x: Math.round(primary.x + primary.w - size.w - side),
    y: Math.round(primary.y + primary.h - size.h - bottom),
  };
}

/**
 * 恢复上次的位置，但先确认那个坐标现在还看得见。
 *
 * 记住的是**物理像素**坐标。外接屏拔掉、或（Windows 上很常见）改了显示缩放比之后，
 * 旧坐标可能落到所有屏幕之外——球就再也点不到了，只能去删配置文件。
 * 所以位置不可见时退回主屏右下角，并把这个位置存回去。
 */
async function restorePosition(): Promise<void> {
  const geom = await bridge.getBallGeometry();
  const size = { w: geom.w, h: geom.h };

  let monitors: bridge.MonitorRect[] = [];
  let primary: bridge.MonitorRect | null = null;
  try {
    monitors = await bridge.getMonitorRects();
    primary = await bridge.getPrimaryMonitorRect();
  } catch {
    /* 拿不到显示器信息就别乱动位置 */
  }

  const saved = config.ballPosition;

  // 拿不到显示器列表时不做判断，宁可保持原样
  if (saved && (monitors.length === 0 || centerVisible(saved, size, monitors))) {
    await bridge.setBallPosition(saved.x, saved.y);
    return;
  }

  const target = primary ?? monitors[0];
  if (!target) return;
  const pos = fallbackPosition(target, size, geom.scale);
  await bridge.setBallPosition(pos.x, pos.y);
  // 存回去，免得下次启动又算一遍
  const latest = await bridge.loadConfig();
  latest.ballPosition = pos;
  await bridge.saveConfig(latest);
  config = latest;
}

async function init(): Promise<void> {
  config = await bridge.loadConfig();

  await restorePosition();

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
