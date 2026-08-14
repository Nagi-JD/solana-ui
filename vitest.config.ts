import { defineConfig } from "vitest/config";

// Vitest config for the allocation/trading unit tests. Kept separate from
// vite.config.js so the app build is untouched. Tests are pure TS modules
// (no DOM required), so the default node environment is sufficient.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    globals: false,
  },
});
