import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vitest transforms via esbuild, which handles the TUI's JSX on its own — no need
  // for @vitejs/plugin-react (whose peer range lags the vite version vitest ships).
  esbuild: { jsx: "automatic" },
  test: {
    include: ["tests/unit/**/*.test.ts?(x)", "tests/integration/**/*.test.ts?(x)"],
    environment: "node",
    restoreMocks: true,
    clearMocks: true,
  },
});
