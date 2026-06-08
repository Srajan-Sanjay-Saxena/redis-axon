import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/connection/commands.ts",
    "src/connection/connection.ts",
    "src/connection/pool.ts",
    "src/connection/cluster.ts",
    "src/circuit/circuitBreaker.ts",
    "src/health/health.ts",
    "src/health/single.strategy.ts",
    "src/health/pool.strategy.ts",
    "src/health/cluster.strategy.ts",
    "src/helper/types.helper.ts",
    "src/log/logger.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: "dist",
  splitting: false,
  esbuildOptions(options) {
    options.alias = {
      "@connection": "./src/connection",
      "@circuit": "./src/circuit",
      "@helper": "./src/helper",
      "@health": "./src/health",
      "@log": "./src/log",
    };
  },
});
