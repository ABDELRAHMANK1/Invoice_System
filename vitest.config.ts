import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/e2e/**", "**/.next/**"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["**/__tests__/**", "**/*.config.*", "**/.next/**"],
    },
  },
});
