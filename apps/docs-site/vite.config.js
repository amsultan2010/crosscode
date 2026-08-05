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
        privacy: resolve(root, "docs/privacy.html"),
        protocol: resolve(root, "docs/protocol.html"),
        mcp: resolve(root, "docs/mcp-clients.html"),
        limitations: resolve(root, "docs/limitations.html"),
        support: resolve(root, "docs/support.html"),
        terms: resolve(root, "docs/terms.html"),
        refundPolicy: resolve(root, "docs/refund-policy.html"),
        signin: resolve(root, "auth/signin.html"),
        signup: resolve(root, "auth/signup.html"),
        passwordReset: resolve(root, "auth/reset.html"),
        cliLogin: resolve(root, "auth/cli.html")
      }
    }
  }
});
