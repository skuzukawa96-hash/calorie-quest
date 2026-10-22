import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `tauri android dev` sets this to the PC's address on the network, which the phone loads the page from.
const host = process.env.TAURI_DEV_HOST;

// Tauri expects a fixed port; the Rust side reads `devUrl` from tauri.conf.json.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
  },
});
