import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The factory serves web/dist itself (loopback only, strict CSP); in `pnpm web:dev` the API is proxied to a running `factory serve`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, modulePreload: { polyfill: false } },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4780", "/health": "http://127.0.0.1:4780" } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"], include: ["src/**/*.test.{ts,tsx}"], css: false },
});
