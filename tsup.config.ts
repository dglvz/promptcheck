import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  splitting: false,
});
