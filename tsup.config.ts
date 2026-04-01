import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["cli/index.ts", "index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
