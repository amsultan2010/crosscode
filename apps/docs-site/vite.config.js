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
        accessibility: resolve(root, "docs/accessibility.html"),
        dmca: resolve(root, "docs/dmca.html"),
        dsaContact: resolve(root, "docs/dsa-contact.html"),
        privacyPolicy: resolve(root, "docs/privacy-policy.html"),
        cookies: resolve(root, "docs/cookies.html"),
        subprocessors: resolve(root, "docs/subprocessors.html"),
        dpa: resolve(root, "docs/dpa.html"),
        signin: resolve(root, "auth/signin.html"),
        signup: resolve(root, "auth/signup.html"),
        passwordReset: resolve(root, "auth/reset.html"),
        cliLogin: resolve(root, "auth/cli.html"),
        // One page for every /join/:code; vercel.json rewrites the code into it.
        join: resolve(root, "join.html"),
        // Where `crosscode start` sends a terminal to be signed in.
        device: resolve(root, "device.html")
      }
    }
  }
});
