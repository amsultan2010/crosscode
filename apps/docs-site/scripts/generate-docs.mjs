#!/usr/bin/env node
// Generates docs-site HTML pages and public/llms*.txt from the root docs/*.md
// markdown sources. Run automatically before dev/build (see package.json) so the
// site can never drift from the markdown source of truth. Do not hand-edit the
// generated docs/*.html files listed in GENERATED_HTML below, or public/docs/*.md,
// or public/llms.txt / public/llms-full.txt — edit the root docs/*.md instead.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import MarkdownIt from "markdown-it";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(siteRoot, "../..");
const rootDocsDir = path.join(repoRoot, "docs");
const siteDocsDir = path.join(siteRoot, "docs");
const publicDir = path.join(siteRoot, "public");
const publicDocsDir = path.join(publicDir, "docs");

const md = new MarkdownIt({ html: false, linkify: true });

const GITHUB_REPO = "https://github.com/amsultan2010/crosscode";

// Root docs/*.md sometimes link to repo-root files (../README.md,
// ../BUILD_INSTRUCTIONS.md) with paths that only resolve inside the repo, not on
// the deployed docs-site. Rewrite those to GitHub so the generated page has no
// dead links.
const defaultLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIndex = tokens[idx].attrIndex("href");
  if (hrefIndex >= 0) {
    const href = tokens[idx].attrs[hrefIndex][1];
    if (href.startsWith("../")) {
      tokens[idx].attrs[hrefIndex][1] = `${GITHUB_REPO}/blob/main/${href.slice(3)}`;
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Gives every heading a stable slug id (e.g. "## Available tools" -> "available-tools")
// so other pages can deep-link with an anchor, matching common markdown-site behavior.
md.core.ruler.push("heading_anchor_ids", (state) => {
  const slugCounts = new Map();
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i];
    if (token.type !== "heading_open") continue;
    const inline = state.tokens[i + 1];
    const text = inline.children.map((c) => c.content).join("");
    let slug = text
      .toLowerCase()
      .trim()
      .replace(/[`'"]/g, "")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-");
    const seen = slugCounts.get(slug) || 0;
    slugCounts.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    token.attrSet("id", slug);
  }
});

// Every generated HTML page pulls its <nav class="docs-sidebar"> from this list,
// so adding a generated or hand-written doc page here keeps every page's sidebar
// in sync automatically.
const NAV_GROUPS = [
  {
    label: "Start here",
    links: [{ href: "/docs/index.html", label: "Overview", key: "index" }]
  },
  {
    label: "Architecture & safety",
    links: [
      { href: "/docs/architecture.html", label: "Architecture", key: "architecture" },
      { href: "/docs/safety.html", label: "Safety model", key: "safety" },
      { href: "/docs/protocol.html", label: "Network protocol", key: "protocol" }
    ]
  },
  {
    label: "Setup & operation",
    links: [
      { href: "/docs/install.html", label: "Install & quickstart", key: "install" },
      { href: "/docs/mcp-clients.html", label: "MCP client setup", key: "mcp-clients" }
    ]
  },
  {
    label: "Reference",
    links: [
      { href: "/docs/cli.html", label: "CLI reference", key: "cli" },
      { href: "/docs/limitations.html", label: "Limitations", key: "limitations" }
    ]
  }
];

// docs/*.md sources rendered straight to docs-site/docs/*.html, plus a raw copy
// under public/docs/ so an agent can GET the markdown directly instead of HTML.
const GENERATED_PAGES = [
  {
    key: "architecture",
    title: "Architecture",
    mdFile: "architecture.md",
    htmlOut: "architecture.html",
    nextHref: "/docs/safety.html",
    nextLabel: "Safety model"
  },
  {
    key: "safety",
    title: "Safety model",
    mdFile: "security.md",
    htmlOut: "safety.html",
    mdOutName: "safety.md",
    nextHref: "/docs/protocol.html",
    nextLabel: "Network protocol"
  },
  {
    key: "protocol",
    title: "Network protocol",
    mdFile: "protocol.md",
    htmlOut: "protocol.html",
    nextHref: "/docs/install.html",
    nextLabel: "Install & quickstart"
  },
  {
    key: "mcp-clients",
    title: "MCP client setup",
    mdFile: "mcp-clients.md",
    htmlOut: "mcp-clients.html",
    nextHref: "/docs/cli.html",
    nextLabel: "CLI reference"
  }
];

// Raw markdown files with no generated HTML counterpart, still copied so they're
// directly fetchable (linked from llms.txt).
const RAW_ONLY_FILES = ["install-prompt.md"];

const GITHUB_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

function renderSidebar(activeKey) {
  return NAV_GROUPS.map((group) => {
    const links = group.links
      .map((l) => {
        const active = l.key === activeKey ? ' class="active" aria-current="page"' : "";
        return `          <a href="${l.href}"${active}>${l.label}</a>`;
      })
      .join("\n");
    return `      <div>
        <div class="docs-sidebar-label">${group.label}</div>
        <div class="docs-sidebar-links">
${links}
        </div>
      </div>`;
  }).join("\n");
}

function renderPage({ title, activeKey, bodyHtml, mdHref, mdSourceRel, nextHref, nextLabel }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} · Crosscode</title>
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <header class="site-header">
    <nav>
      <a class="brand" href="/">Crosscode</a>
      <a href="/docs/index.html">Docs</a>
      <a href="/docs/install.html">Install &amp; quickstart</a>
      <a href="/docs/cli.html">CLI reference</a>
      <a href="/docs/limitations.html">Limitations</a>
      <a class="nav-github" href="${GITHUB_REPO}" rel="noopener">
        ${GITHUB_SVG}
        GitHub
      </a>
    </nav>
  </header>

  <main class="docs-layout wide">
    <nav class="docs-sidebar" aria-label="Docs navigation">
${renderSidebar(activeKey)}
    </nav>

    <div class="docs-content">
${bodyHtml}
      <p class="install-steps">
        <a href="${mdHref}">View raw markdown</a> &middot; generated from
        <code>${mdSourceRel}</code> at build time, do not hand-edit this page.
      </p>

      <div class="docs-next">
        <a href="${nextHref}">Next: ${nextLabel} →</a>
      </div>
    </div>
  </main>

  <footer class="site-footer">
    <p>Crosscode: local-first Git coordination.</p>
    <p><a href="/">Home</a> &middot; <a href="${GITHUB_REPO}" rel="noopener">View on GitHub</a></p>
  </footer>
</body>
</html>
`;
}

function generateDocPages() {
  mkdirSync(siteDocsDir, { recursive: true });
  mkdirSync(publicDocsDir, { recursive: true });

  for (const p of GENERATED_PAGES) {
    const mdPath = path.join(rootDocsDir, p.mdFile);
    const mdContent = readFileSync(mdPath, "utf8");
    const bodyHtml = md.render(mdContent);
    const mdOutName = p.mdOutName ?? p.mdFile;
    const mdHref = `/docs/${mdOutName}`;

    const html = renderPage({
      title: p.title,
      activeKey: p.key,
      bodyHtml,
      mdHref,
      mdSourceRel: `docs/${p.mdFile}`,
      nextHref: p.nextHref,
      nextLabel: p.nextLabel
    });

    writeFileSync(path.join(siteDocsDir, p.htmlOut), html);
    writeFileSync(path.join(publicDocsDir, mdOutName), mdContent);
  }

  for (const file of RAW_ONLY_FILES) {
    const mdContent = readFileSync(path.join(rootDocsDir, file), "utf8");
    writeFileSync(path.join(publicDocsDir, file), mdContent);
  }
}

// Keeps the install prompt embedded in the marketing homepage in sync with
// docs/install-prompt.md, which explicitly documents that the two must match.
function syncInstallPrompt() {
  const promptMd = readFileSync(path.join(rootDocsDir, "install-prompt.md"), "utf8");
  const match = promptMd.match(/````text\n([\s\S]*?)\n````/);
  if (!match) {
    throw new Error("Could not find fenced install prompt in docs/install-prompt.md");
  }
  const promptText = match[1];
  const escaped = promptText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const indexPath = path.join(siteRoot, "index.html");
  const indexHtml = readFileSync(indexPath, "utf8");
  const blockRe = /(<pre><code id="install-prompt-text">)[\s\S]*?(<\/code><\/pre>)/;
  if (!blockRe.test(indexHtml)) {
    throw new Error('Could not find <pre><code id="install-prompt-text"> block in index.html');
  }
  const updated = indexHtml.replace(blockRe, `$1${escaped}$2`);
  writeFileSync(indexPath, updated);
}

function generateLlmsTxt() {
  const entries = [
    { href: "/docs/architecture.md", label: "Architecture", desc: "The daemon, coordination service, and how transactions and proposals move between them." },
    { href: "/docs/safety.md", label: "Safety model", desc: "The rules and threat model governing when Crosscode may touch your working tree." },
    { href: "/docs/protocol.md", label: "Network protocol", desc: "The wire schema (Zod) shared by the daemon, CLI, MCP server, and coordination service." },
    { href: "/docs/mcp-clients.md", label: "MCP client setup", desc: "Configuring Claude Code, Codex CLI, OpenCode, Gemini CLI, and Cursor, plus the MCP tool catalog." },
    { href: "/docs/install-prompt.md", label: "Install prompt", desc: "The exact text to paste into any MCP-capable coding agent to set up Crosscode in a project." }
  ];

  const lines = [
    "# Crosscode",
    "",
    "> Local-first coordination layer for developers and coding agents working in",
    "> separate checkouts of the same Git repository. A per-checkout daemon captures",
    "> settled work as durable transactions and syncs it through an authenticated",
    "> coordination service; remote work always arrives as a proposal you review and",
    "> accept yourself, never an automatic write to your working tree.",
    "",
    "Coding agents should reach for the `crosscode` CLI or the local MCP server for",
    "day-to-day work (status, claim, publish, accept/reject) instead of this site.",
    "This site and the markdown files linked below are for deeper reference.",
    "",
    "## Docs",
    "",
    ...entries.map((e) => `- [${e.label}](${e.href}): ${e.desc}`),
    "",
    "## Optional",
    "",
    "- [Full documentation bundle](/llms-full.txt): every doc above concatenated into one file.",
    `- [GitHub repository](${GITHUB_REPO})`,
    `- [AGENTS.md](${GITHUB_REPO}/blob/main/AGENTS.md): agent capability ladder and trust model (repo root).`,
    ""
  ];

  writeFileSync(path.join(publicDir, "llms.txt"), lines.join("\n"));
}

function generateLlmsFullTxt() {
  const sections = [
    { title: "Architecture", file: "architecture.md" },
    { title: "Safety model", file: "security.md" },
    { title: "Network protocol", file: "protocol.md" },
    { title: "MCP client setup", file: "mcp-clients.md" },
    { title: "Install prompt", file: "install-prompt.md" }
  ];

  const parts = [
    "# Crosscode — full documentation bundle",
    "",
    "Concatenation of every docs/*.md source in this repository, for LLMs/agents",
    "that want the complete reference in a single fetch. See /llms.txt for a",
    "curated index with per-page links.",
    ""
  ];

  for (const s of sections) {
    const content = readFileSync(path.join(rootDocsDir, s.file), "utf8");
    parts.push("---", "", `<!-- source: docs/${s.file} -->`, "", content.trimEnd(), "");
  }

  writeFileSync(path.join(publicDir, "llms-full.txt"), parts.join("\n"));
}

mkdirSync(publicDir, { recursive: true });
generateDocPages();
syncInstallPrompt();
generateLlmsTxt();
generateLlmsFullTxt();

console.log("[generate-docs] wrote generated doc pages, public/docs/*.md, llms.txt, llms-full.txt");
