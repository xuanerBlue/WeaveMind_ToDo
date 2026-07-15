// 桥接层：把所有 Tauri v2 API 收敛到这里，UI 只依赖这些稳定的函数。
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppConfig } from "./types";

// 当前窗口：在悬浮球里就是 ball，在面板里就是 panel（各自加载自己的 bundle）
const self = getCurrentWebviewWindow();

const EVT_TOGGLE = "toggle-panel"; // 悬浮球 → 面板：切换显示
const EVT_TODOS = "todos-changed"; // 面板 → 悬浮球：未完成数量变化

export interface BallGeometry {
  x: number; // 物理像素
  y: number;
  w: number;
  h: number;
  scale: number;
}

// ---------------------------------------------------------------- 配置
export async function loadConfig(): Promise<AppConfig> {
  const raw = await invoke<string>("load_config");
  if (!raw) return { todoFilePath: null };
  try {
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { todoFilePath: null };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { contents: JSON.stringify(config, null, 2) });
}

// ---------------------------------------------------------------- 文件读写
export async function readTodoFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export async function writeTodoFile(path: string, content: string): Promise<void> {
  await invoke("write_file", { path, contents: content });
}

// ---------------------------------------------------------------- 原生文件选择
export async function pickTodoFile(): Promise<string | null> {
  // 走 Rust 端的 blocking 模态对话框，比 JS 版 open() 在置顶/无边框窗口下更可靠
  const res = await invoke<string | null>("pick_todo_file");
  return res ?? null;
}

// ---------------------------------------------------------------- 悬浮球侧
export async function startBallDrag(): Promise<void> {
  await self.startDragging();
}

export async function getBallGeometry(): Promise<BallGeometry> {
  const pos = await self.outerPosition();
  const size = await self.outerSize();
  const scale = await self.scaleFactor();
  return { x: pos.x, y: pos.y, w: size.width, h: size.height, scale };
}

export async function setBallPosition(x: number, y: number): Promise<void> {
  await self.setPosition(new PhysicalPosition(x, y));
}

export async function onBallMoved(
  cb: (x: number, y: number) => void,
): Promise<UnlistenFn> {
  return self.onMoved(({ payload }) => cb(payload.x, payload.y));
}

export async function emitTogglePanel(geom: BallGeometry): Promise<void> {
  await emit(EVT_TOGGLE, geom);
}

export async function onTodosChanged(
  cb: (pending: number) => void,
): Promise<UnlistenFn> {
  return listen<number>(EVT_TODOS, ({ payload }) => cb(payload));
}

// ---------------------------------------------------------------- 面板侧
export async function onTogglePanel(
  cb: (geom: BallGeometry) => void,
): Promise<UnlistenFn> {
  return listen<BallGeometry>(EVT_TOGGLE, ({ payload }) => cb(payload));
}

export async function showPanelAt(x: number, y: number): Promise<void> {
  await self.setPosition(new PhysicalPosition(x, y));
  await self.show();
  await self.setFocus();
}

export async function hidePanel(): Promise<void> {
  await self.hide();
}

export async function isPanelVisible(): Promise<boolean> {
  return self.isVisible();
}

export async function onPanelBlur(cb: () => void): Promise<UnlistenFn> {
  return self.onFocusChanged(({ payload: focused }) => {
    if (!focused) cb();
  });
}

export async function getPanelOuterSize(): Promise<{ w: number; h: number }> {
  const size = await self.outerSize();
  return { w: size.width, h: size.height };
}

export async function getCurrentMonitorBounds(): Promise<{
  x: number;
  y: number;
  w: number;
  h: number;
}> {
  const mon = await currentMonitor();
  if (!mon) return { x: 0, y: 0, w: 1920, h: 1080 };
  return {
    x: mon.position.x,
    y: mon.position.y,
    w: mon.size.width,
    h: mon.size.height,
  };
}

export async function emitTodosChanged(pending: number): Promise<void> {
  await emit(EVT_TODOS, pending);
}

// 确保当前窗口可见并获得焦点（选完文件后把面板重新显示出来）
export async function ensureVisible(): Promise<void> {
  if (!(await self.isVisible())) await self.show();
  await self.setFocus();
}

// 临时切换置顶：macOS 上原生文件对话框会被 alwaysOnTop 窗口挡在后面，
// 打开对话框前先取消置顶，结束后恢复。
export async function setPanelAlwaysOnTop(on: boolean): Promise<void> {
  await self.setAlwaysOnTop(on);
}

// ---------------------------------------------------------------- 文件监听 & 托盘
export async function watchFile(path: string): Promise<void> {
  await invoke("watch_file", { path });
}

export async function onTodoFileChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("todo-file-changed", () => cb());
}

export async function onTrayShowPanel(cb: () => void): Promise<UnlistenFn> {
  return listen("tray-show-panel", () => cb());
}
