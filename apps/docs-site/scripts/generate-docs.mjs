#!/usr/bin/env node
// Generates docs-site HTML pages and public/llms*.txt from the root docs/*.md
// markdown sources. Run automatically before dev/build (see package.json) so the
// site can never drift from the markdown source of truth. Do not hand-edit the
// generated docs/*.html files listed in GENERATED_HTML below, or public/docs/*.md,
// or public/llms.txt / public/llms-full.txt. Edit the root docs/*.md instead.

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
// Canonical origin. The apex 308-redirects here, so every canonical, og:url and sitemap
// entry has to name www or it points at a redirect.
const SITE_URL = "https://www.getcrosscode.dev";

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

// `pre` scrolls sideways (overflow-x: auto in style.css), and a scrollable region a
// keyboard cannot reach is WCAG 2.1.1 -- the arrow keys need somewhere to land. Making
// it focusable is the whole fix; a markdown code block has no name of its own to give it.
for (const rule of ["fence", "code_block"]) {
  const base = md.renderer.rules[rule];
  md.renderer.rules[rule] = (...args) => base(...args).replace("<pre", '<pre tabindex="0"');
}

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
    label: "start here",
    links: [{ href: "/docs/index.html", label: "overview", key: "index" }]
  },
  {
    label: "architecture & safety",
    links: [
      { href: "/docs/architecture.html", label: "architecture", key: "architecture" },
      { href: "/docs/safety.html", label: "safety model", key: "safety" },
      { href: "/docs/privacy.html", label: "privacy", key: "privacy" },
      { href: "/docs/protocol.html", label: "network protocol", key: "protocol" }
    ]
  },
  {
    label: "setup & operation",
    links: [
      { href: "/docs/install.html", label: "install & quickstart", key: "install" },
      { href: "/docs/mcp-clients.html", label: "mcp client setup", key: "mcp-clients" }
    ]
  },
  {
    label: "reference",
    links: [
      { href: "/docs/cli.html", label: "cli reference", key: "cli" },
      { href: "/docs/limitations.html", label: "limitations", key: "limitations" }
    ]
  },
  {
    label: "support & legal",
    links: [
      { href: "/docs/support.html", label: "support", key: "support" },
      { href: "/docs/terms.html", label: "terms of service", key: "terms" },
      { href: "/docs/dmca.html", label: "copyright and dmca", key: "dmca" },
      { href: "/docs/dsa-contact.html", label: "eu dsa contact", key: "dsa-contact" },
      { href: "/docs/privacy-policy.html", label: "privacy policy", key: "privacy-policy" },
      { href: "/docs/cookies.html", label: "cookies", key: "cookies" },
      { href: "/docs/subprocessors.html", label: "subprocessors", key: "subprocessors" },
      { href: "/docs/dpa.html", label: "data processing agreement", key: "dpa" },
      { href: "/docs/accessibility.html", label: "accessibility", key: "accessibility" }
    ]
  }
];

// docs/*.md sources rendered straight to docs-site/docs/*.html, plus a raw copy
// under public/docs/ so an agent can GET the markdown directly instead of HTML.
const GENERATED_PAGES = [
  {
    key: "architecture",
    title: "architecture",
    description:
      "how the crosscode cli, the daemon in each checkout, the stdio mcp server and the coordination service fit together, and the exact path one file edit takes to reach a teammate's working tree.",
    mdFile: "architecture.md",
    htmlOut: "architecture.html",
    nextHref: "/docs/safety.html",
    nextLabel: "safety model"
  },
  {
    key: "safety",
    title: "safety model",
    description:
      "the threat model behind the crosscode cli: how the daemon, the mcp server, the coordination service and the local clients are each defended, and what none of them defends against.",
    mdFile: "security.md",
    htmlOut: "safety.html",
    mdOutName: "safety.md",
    nextHref: "/docs/privacy.html",
    nextLabel: "privacy"
  },
  {
    key: "privacy",
    title: "privacy",
    description:
      "what the hosted coordination service actually holds while uncommitted edits pass through it from the crosscode cli and its mcp server, and what it never sees. the short, honest version.",
    mdFile: "privacy.md",
    htmlOut: "privacy.html",
    nextHref: "/docs/protocol.html",
    nextLabel: "network protocol"
  },
  {
    key: "protocol",
    title: "network protocol",
    description:
      "the zod wire contract shared by the daemon, the crosscode cli, the mcp server and the coordination service. one file is one change; every schema strict, protocol version 3.",
    mdFile: "protocol.md",
    htmlOut: "protocol.html",
    nextHref: "/docs/install.html",
    nextLabel: "install & quickstart"
  },
  {
    key: "mcp-clients",
    title: "mcp client setup",
    description:
      "what the crosscode cli's start command installs for a coding agent: the stdio mcp server, the skill that teaches an agent to use it, and hooks for claude code and the codex cli.",
    mdFile: "mcp-clients.md",
    htmlOut: "mcp-clients.html",
    nextHref: "/docs/cli.html",
    nextLabel: "cli reference"
  },
  {
    key: "support",
    title: "support",
    description:
      "where to take a bug in the crosscode cli or its mcp server, an account problem or a data deletion request, what to bring with you, and how long a first reply actually takes.",
    mdFile: "support.md",
    htmlOut: "support.html",
    nextHref: "/docs/terms.html",
    nextLabel: "terms of service"
  },
  {
    key: "terms",
    title: "terms of service",
    description:
      "the agreement covering use of the hosted coordination service the crosscode cli and its mcp server connect to: your content, acceptable use, availability, liability and termination.",
    mdFile: "terms.md",
    htmlOut: "terms.html",
    nextHref: "/docs/dmca.html",
    nextLabel: "copyright and dmca"
  },
  {
    key: "dmca",
    title: "copyright and dmca",
    description:
      "how to send a copyright notice about a file stored in crosscode's hosted service, how to counter-notify, and what happens to repeat infringers.",
    mdFile: "dmca.md",
    htmlOut: "dmca.html",
    nextHref: "/docs/dsa-contact.html",
    nextLabel: "eu dsa contact"
  },
  {
    key: "dsa-contact",
    title: "eu dsa contact",
    description:
      "crosscode's single point of contact and its notice-and-action procedure under the eu digital services act, regulation (eu) 2022/2065.",
    mdFile: "dsa-contact.md",
    htmlOut: "dsa-contact.html",
    nextHref: "/docs/privacy-policy.html",
    nextLabel: "privacy policy"
  },
  {
    key: "privacy-policy",
    title: "privacy policy",
    description:
      "the full gdpr article 13 and 14 notice: every category of personal data, the legal basis for it, how long it is kept, and how to exercise your rights.",
    mdFile: "privacy-policy.md",
    htmlOut: "privacy-policy.html",
    nextHref: "/docs/cookies.html",
    nextLabel: "cookies and local storage"
  },
  {
    key: "cookies",
    title: "cookies and local storage",
    description:
      "every cookie, localstorage and sessionstorage item crosscode sets, what each is for, how long it lasts, and whether it needs your consent.",
    mdFile: "cookies.md",
    htmlOut: "cookies.html",
    nextHref: "/docs/subprocessors.html",
    nextLabel: "subprocessors"
  },
  {
    key: "subprocessors",
    title: "subprocessors",
    description:
      "the six vendors that process data on crosscode's behalf, what each one receives and where it sits. no fonts, no cdn scripts, no third-party tags.",
    mdFile: "subprocessors.md",
    htmlOut: "subprocessors.html",
    nextHref: "/docs/dpa.html",
    nextLabel: "data processing agreement"
  },
  {
    key: "dpa",
    title: "data processing agreement",
    description:
      "the article 28 processor agreement for personal data inside the files you sync. it applies automatically to the hosted service, with nothing to sign.",
    mdFile: "dpa.md",
    htmlOut: "dpa.html",
    nextHref: "/docs/accessibility.html",
    nextLabel: "accessibility"
  },
  {
    key: "accessibility",
    title: "accessibility",
    description:
      "where www.getcrosscode.dev stands against wcag 2.2 level aa: what is tested, what is known to fall short, and how to report a barrier you hit.",
    mdFile: "accessibility.md",
    htmlOut: "accessibility.html",
    nextHref: "/docs/index.html",
    nextLabel: "docs overview"
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

function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage({ title, activeKey, description, canonicalPath, bodyHtml, mdHref, mdSourceRel, nextHref, nextLabel }) {
  const canonical = `${SITE_URL}${canonicalPath}`;
  const fullTitle = `${title} · crosscode cli (mcp server)`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: fullTitle,
        description,
        url: canonical,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", name: "crosscode", url: `${SITE_URL}/` },
        publisher: { "@type": "Organization", name: "crosscode", url: `${SITE_URL}/` }
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "home", item: `${SITE_URL}/` },
          { "@type": "ListItem", position: 2, name: "docs", item: `${SITE_URL}/docs/index.html` },
          { "@type": "ListItem", position: 3, name: title, item: canonical }
        ]
      }
    ]
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${fullTitle}</title>
  <meta name="description" content="${escapeAttr(description)}" />
  <link rel="canonical" href="${canonical}" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml" sizes="any" />
  <link rel="icon" type="image/png" sizes="192x192" href="/brand/favicon-192.png" />
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Crosscode" />
  <meta property="og:title" content="${fullTitle}" />
  <meta property="og:description" content="${escapeAttr(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="/brand/logo-social.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${fullTitle}" />
  <meta name="twitter:description" content="${escapeAttr(description)}" />
  <meta name="twitter:image" content="/brand/logo-social.png" />
  <link rel="stylesheet" href="/src/style.css" />
  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
  </script>
</head>
<body>
  <a class="skip-link" href="#main">skip to content</a>

  <header class="site-header">
    <nav aria-label="primary">
      <a class="brand" href="/">crosscode</a>
      <a href="/docs/index.html">docs</a>
      <a href="/docs/install.html">install &amp; quickstart</a>
      <a href="/docs/cli.html">cli reference</a>
      <a href="/docs/limitations.html">limitations</a>
      <a class="nav-github" href="${GITHUB_REPO}" rel="noopener">
        ${GITHUB_SVG}
        github
      </a>
    </nav>
  </header>

  <main id="main" class="docs-layout wide">
    <nav class="docs-sidebar" aria-label="docs navigation">
${renderSidebar(activeKey)}
    </nav>

    <div class="docs-content">
${bodyHtml}
      <p class="install-steps">
        <a href="${mdHref}">view raw markdown</a> &middot; generated from
        <code>${mdSourceRel}</code> at build time, do not hand-edit this page.
      </p>

      <div class="docs-next">
        <a href="${nextHref}">next: ${nextLabel} →</a>
      </div>
    </div>
  </main>

  <footer class="site-footer">
    <p>crosscode: local-first git coordination.</p>
    <p><a href="/">home</a> &middot; <a href="/docs/accessibility.html">accessibility</a> &middot; <a href="${GITHUB_REPO}" rel="noopener">view on github</a></p>
    <p>
      <a href="/docs/privacy.html">privacy</a> &middot;
      <a href="/docs/privacy-policy.html">privacy policy</a> &middot;
      <a href="/docs/cookies.html">cookies</a> &middot;
      <a href="/docs/subprocessors.html">subprocessors</a> &middot;
      <a href="/docs/dpa.html">dpa</a>
    </p>
  </footer>
</body>
</html>
`;
}

// Legal docs carry `<!-- LAWYER: ... -->` notes flagging choices that need review. The
// renderer runs with html:false, so a comment left in would be escaped and printed on the
// page as visible text. Strip them from everything published; the repo's docs/*.md keeps
// them, which is where they are meant to be read.
function stripHtmlComments(markdown) {
  return markdown.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/gm, "");
}

function generateDocPages() {
  mkdirSync(siteDocsDir, { recursive: true });
  mkdirSync(publicDocsDir, { recursive: true });

  for (const p of GENERATED_PAGES) {
    const mdPath = path.join(rootDocsDir, p.mdFile);
    const mdContent = stripHtmlComments(readFileSync(mdPath, "utf8"));
    const bodyHtml = md.render(mdContent);
    const mdOutName = p.mdOutName ?? p.mdFile;
    const mdHref = `/docs/${mdOutName}`;

    const html = renderPage({
      title: p.title,
      activeKey: p.key,
      description: p.description,
      canonicalPath: `/docs/${p.htmlOut}`,
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
  // `<pre` carries attributes now (tabindex, for keyboard access to the scroll), so the
  // match cannot assume a bare tag.
  const blockRe = /(<pre[^>]*><code id="install-prompt-text">)[\s\S]*?(<\/code><\/pre>)/;
  if (!blockRe.test(indexHtml)) {
    throw new Error('Could not find <pre><code id="install-prompt-text"> block in index.html');
  }
  const updated = indexHtml.replace(blockRe, `$1${escaped}$2`);
  writeFileSync(indexPath, updated);
}

function generateLlmsTxt() {
  const entries = [
    { href: "/docs/architecture.md", label: "architecture", desc: "the daemon, the coordination service, and how one file change reaches a teammate." },
    { href: "/docs/safety.md", label: "safety model", desc: "the rules and threat model governing when crosscode may touch your working tree." },
    { href: "/docs/privacy.md", label: "privacy", desc: "exactly what the hosted coordination service can and cannot read. short answer: not your code." },
    { href: "/docs/protocol.md", label: "network protocol", desc: "the wire contract (zod) shared by the daemon, cli, mcp server, and coordination service." },
    { href: "/docs/mcp-clients.md", label: "mcp client setup", desc: "configuring claude code, codex cli, opencode, gemini cli, and cursor, plus the mcp tool catalog." },
    { href: "/docs/install-prompt.md", label: "install prompt", desc: "the exact text to paste into any mcp-capable coding agent to set up crosscode in a project." }
  ];

  const lines = [
    "# crosscode",
    "",
    "> local-first coordination layer for developers and coding agents working in",
    "> separate checkouts of the same git repository. a per-checkout daemon captures",
    "> settled work as durable transactions and syncs it through an authenticated",
    "> coordination service; remote work always arrives as a proposal you review and",
    "> accept yourself, never an automatic write to your working tree.",
    "",
    "coding agents should reach for the `crosscode` cli or the local mcp server for",
    "day-to-day work (status, claim, publish, accept/reject) instead of this site.",
    "this site and the markdown files linked below are for deeper reference.",
    "",
    "## docs",
    "",
    ...entries.map((e) => `- [${e.label}](${e.href}): ${e.desc}`),
    "",
    "## optional",
    "",
    "- [full documentation bundle](/llms-full.txt): every doc above concatenated into one file.",
    `- [github repository](${GITHUB_REPO})`,
    `- [AGENTS.md](${GITHUB_REPO}/blob/main/AGENTS.md): agent capability ladder and trust model (repo root).`,
    ""
  ];

  writeFileSync(path.join(publicDir, "llms.txt"), lines.join("\n"));
}

function generateLlmsFullTxt() {
  const sections = [
    { title: "architecture", file: "architecture.md" },
    { title: "safety model", file: "security.md" },
    { title: "privacy", file: "privacy.md" },
    { title: "network protocol", file: "protocol.md" },
    { title: "mcp client setup", file: "mcp-clients.md" },
    { title: "install prompt", file: "install-prompt.md" }
  ];

  const parts = [
    "# crosscode: full documentation bundle",
    "",
    "concatenation of every docs/*.md source in this repository, for llms/agents",
    "that want the complete reference in a single fetch. see /llms.txt for a",
    "curated index with per-page links.",
    ""
  ];

  for (const s of sections) {
    const content = stripHtmlComments(readFileSync(path.join(rootDocsDir, s.file), "utf8"));
    parts.push("---", "", `<!-- source: docs/${s.file} -->`, "", content.trimEnd(), "");
  }

  writeFileSync(path.join(publicDir, "llms-full.txt"), parts.join("\n"));
}

// The hand-written indexable pages. The generated ones come from GENERATED_PAGES, so the
// sitemap cannot drift from the pages this script actually writes. The six per-user pages
// (auth/*, join, device) and 404.html carry `robots: noindex` and are deliberately absent.
// No <lastmod>: there is no honest source for one here, and a build-clock value would be a
// lie that changes on every deploy.
const STATIC_INDEXABLE_PATHS = [
  "/",
  "/docs/index.html",
  "/docs/install.html",
  "/docs/cli.html",
  "/docs/limitations.html"
];

function generateSitemap() {
  const paths = [...STATIC_INDEXABLE_PATHS, ...GENERATED_PAGES.map((p) => `/docs/${p.htmlOut}`)];

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`),
    "</urlset>",
    ""
  ];

  writeFileSync(path.join(publicDir, "sitemap.xml"), lines.join("\n"));
}

mkdirSync(publicDir, { recursive: true });
generateDocPages();
syncInstallPrompt();
generateLlmsTxt();
generateLlmsFullTxt();
generateSitemap();

console.log("[generate-docs] wrote generated doc pages, public/docs/*.md, llms.txt, llms-full.txt, sitemap.xml");
