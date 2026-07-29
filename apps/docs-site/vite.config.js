import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(__dirname);

export default defineConfig({
  root,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        docsIndex: resolve(root, "docs/index.html"),
        architecture: resolve(root, "docs/architecture.html"),
        install: resolve(root, "docs/install.html"),
        cli: resolve(root, "docs/cli.html"),
        safety: resolve(root, "docs/safety.html"),
        mcp: resolve(root, "docs/mcp-clients.html"),
        limitations: resolve(root, "docs/limitations.html")
      }
    }
  }
});
