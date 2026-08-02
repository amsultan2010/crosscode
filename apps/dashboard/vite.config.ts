import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname),
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
