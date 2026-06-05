import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "#connection": path.resolve(__dirname, "src/connection"),
      "#circuit": path.resolve(__dirname, "src/circuit"),
      "#helper": path.resolve(__dirname, "src/helper"),
    },
  },
});
