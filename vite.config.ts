import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

// Tauri 在开发时通过固定端口访问 Vite dev server
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Tauri 自己负责清屏/日志
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // 不监听 Rust 侧文件，避免无谓热重载
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    // 双入口：悬浮球窗口 + 面板窗口
    rollupOptions: {
      input: {
        ball: fileURLToPath(new URL("./index.html", import.meta.url)),
        panel: fileURLToPath(new URL("./panel.html", import.meta.url)),
      },
    },
  },
});
