// @vitest-environment jsdom
//
// SEO regression suite. Canonicals, descriptions, the sitemap and the noindex boundary are
// all invisible in the rendered page, so nothing about the site looks wrong when one of
// them is dropped -- which is exactly how the site got here. This fails instead.
//
// It reads the *source* tree, not dist/. Vite rewrites asset URLs at build time but passes
// <head> metadata through untouched, so the source files are the honest place to assert
// this, and it keeps the suite consistent with a11y.test.ts.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SITE_URL = "https://www.getcrosscode.dev";

/** The 14 pages written by scripts/generate-docs.mjs. */
const GENERATED_DOCS = [
  "architecture",
  "safety",
  "privacy",
  "protocol",
  "mcp-clients",
  "support",
  "terms",
  "dmca",
  "dsa-contact",
  "privacy-policy",
  "cookies",
  "subprocessors",
  "dpa",
  "accessibility"
].map((key) => `docs/${key}.html`);

/** The 19 pages that belong in the sitemap. */
const INDEXABLE = [
  "index.html",
  "docs/index.html",
  "docs/install.html",
  "docs/cli.html",
  "docs/limitations.html",
  ...GENERATED_DOCS
];

/** Per-user flows: real pages, but nothing a search engine should hold. */
const NOINDEX = [
  "auth/signin.html",
  "auth/signup.html",
  "auth/reset.html",
  "auth/cli.html",
  "join.html",
  "device.html"
];

/** Every page the site ships, 404 included. */
const ALL_PAGES = [...INDEXABLE, ...NOINDEX, "404.html"];

/** index.html is served at the origin, not at /index.html. */
const SITEMAP_URLS = INDEXABLE.map((page) => `${SITE_URL}/${page === "index.html" ? "" : page}`);

function parse(page: string) {
  const html = readFileSync(path.join(siteRoot, page), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

beforeAll(() => {
  // docs/*.html and public/sitemap.xml are generated and gitignored, so a clean checkout
  // has none of them.
  if (!existsSync(path.join(siteRoot, "docs/privacy.html")) || !existsSync(path.join(siteRoot, "public/sitemap.xml"))) {
    execFileSync("node", [path.join(siteRoot, "scripts/generate-docs.mjs")], { stdio: "inherit" });
  }
});

describe("page counts", () => {
  it("covers 19 indexable pages and 6 noindex pages", () => {
    expect(INDEXABLE).toHaveLength(19);
    expect(NOINDEX).toHaveLength(6);
  });
});

describe("titles", () => {
  for (const page of ALL_PAGES) {
    it(`${page} has a non-empty title`, () => {
      expect(parse(page).title.trim()).not.toBe("");
    });
  }

  it("every title is unique", () => {
    const titles = ALL_PAGES.map((page) => parse(page).title.trim());
    const duplicated = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(duplicated, `duplicate <title>: ${duplicated.join(", ")}`).toEqual([]);
  });
});

describe("descriptions", () => {
  for (const page of ALL_PAGES) {
    it(`${page} has a non-empty meta description`, () => {
      const meta = parse(page).querySelector('meta[name="description"]');
      expect(meta, `${page} has no <meta name="description">`).not.toBeNull();
      expect(meta!.getAttribute("content")?.trim()).toBeTruthy();
    });
  }

  it("no two pages share a description", () => {
    const descriptions = ALL_PAGES.map(
      (page) => parse(page).querySelector('meta[name="description"]')!.getAttribute("content")!.trim()
    );
    const duplicated = descriptions.filter((d, i) => descriptions.indexOf(d) !== i);
    expect(duplicated, `duplicate description: ${duplicated.join(" | ")}`).toEqual([]);
  });
});

describe("canonicals", () => {
  for (const page of ALL_PAGES) {
    it(`${page} has a canonical on the www origin`, () => {
      const link = parse(page).querySelector('link[rel="canonical"]');
      expect(link, `${page} has no <link rel="canonical">`).not.toBeNull();
      expect(link!.getAttribute("href")).toMatch(new RegExp(`^${SITE_URL}`));
    });
  }

  it("the landing page canonicalises to the bare origin", () => {
    expect(parse("index.html").querySelector('link[rel="canonical"]')!.getAttribute("href")).toBe(`${SITE_URL}/`);
  });

  it("no two pages claim the same canonical", () => {
    const hrefs = ALL_PAGES.map((page) => parse(page).querySelector('link[rel="canonical"]')!.getAttribute("href")!);
    const duplicated = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(duplicated, `duplicate canonical: ${duplicated.join(", ")}`).toEqual([]);
  });
});

describe("the noindex boundary", () => {
  it("is exactly the per-user flows plus 404", () => {
    const noindexed = ALL_PAGES.filter((page) => {
      const meta = parse(page).querySelector('meta[name="robots"]');
      return (meta?.getAttribute("content") ?? "").includes("noindex");
    });
    expect(noindexed.sort()).toEqual([...NOINDEX, "404.html"].sort());
  });
});

describe("sitemap", () => {
  const sitemapPath = path.join(siteRoot, "public/sitemap.xml");

  function locs() {
    const xml = new DOMParser().parseFromString(readFileSync(sitemapPath, "utf8"), "text/xml");
    expect(xml.querySelector("parsererror"), "public/sitemap.xml is not well-formed XML").toBeNull();
    return [...xml.getElementsByTagName("loc")].map((el) => el.textContent!.trim());
  }

  it("exists", () => {
    expect(existsSync(sitemapPath), "public/sitemap.xml is missing -- run scripts/generate-docs.mjs").toBe(true);
  });

  it("lists exactly the 19 indexable URLs", () => {
    expect(locs().sort()).toEqual([...SITEMAP_URLS].sort());
  });

  it("lists none of the noindex pages", () => {
    const listed = locs();
    for (const page of [...NOINDEX, "404.html"]) {
      expect(listed.some((url) => url.endsWith(`/${page}`)), `${page} must not be in the sitemap`).toBe(false);
    }
    expect(listed.some((url) => url.includes("/device")), "/device must not be in the sitemap").toBe(false);
  });
});

describe("structured data", () => {
  for (const page of ALL_PAGES) {
    it(`${page} has only valid schema.org JSON-LD`, () => {
      for (const script of parse(page).querySelectorAll('script[type="application/ld+json"]')) {
        const parsed = JSON.parse(script.textContent!) as { "@context"?: string };
        expect(parsed["@context"], `${page}: JSON-LD block has no schema.org @context`).toBe("https://schema.org");
      }
    });
  }

  it("the landing page describes the application", () => {
    const blocks = [...parse("index.html").querySelectorAll('script[type="application/ld+json"]')].map(
      (s) => JSON.parse(s.textContent!) as Record<string, unknown>
    );
    const types = blocks.flatMap((b) => ((b["@graph"] as Record<string, unknown>[]) ?? [b]).map((n) => n["@type"]));
    expect(types).toContain("SoftwareApplication");
    expect(types).toContain("Organization");
  });

  it("generated docs pages carry an article and a breadcrumb", () => {
    for (const page of GENERATED_DOCS) {
      const blocks = [...parse(page).querySelectorAll('script[type="application/ld+json"]')].map(
        (s) => JSON.parse(s.textContent!) as Record<string, unknown>
      );
      const types = blocks.flatMap((b) => ((b["@graph"] as Record<string, unknown>[]) ?? [b]).map((n) => n["@type"]));
      expect(types, `${page} is missing TechArticle`).toContain("TechArticle");
      expect(types, `${page} is missing BreadcrumbList`).toContain("BreadcrumbList");
    }
  });
});
