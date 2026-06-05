import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
  resolve: {
    alias: {
      "@connection": path.resolve(__dirname, "src/connection"),
      "@circuit": path.resolve(__dirname, "src/circuit"),
      "@helper": path.resolve(__dirname, "src/helper"),
      "@health": path.resolve(__dirname, "src/health"),
      "@log": path.resolve(__dirname, "src/log"),
    },
  },
});
