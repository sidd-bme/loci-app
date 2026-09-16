import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { searchForWorkspaceRoot } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../docs", import.meta.url))] } },
  build: {
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/renderer/test/setup.ts"],
    css: true,
  },
});
