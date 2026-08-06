// @vitest-environment jsdom
//
// Accessibility regression suite. The fixes in docs/accessibility.md decay within a month
// without something that fails when they are undone, so this is that something.
//
// Two things it deliberately does:
//
//   * It runs axe against the *rendered* page, not the HTML file. The sign-in, join, and
//     device pages ship a `<main>` containing one empty `<div>`; everything a person sees
//     is built by JS. Scanning the file scans nothing.
//   * It disables `color-contrast`. jsdom has no layout and does not apply the stylesheet,
//     so axe cannot compute a single real contrast ratio here and would return every node
//     as "incomplete". Contrast is checked in a real browser instead, against the colours
//     the page actually composites, and docs/accessibility.md says so. The site has one
//     theme -- dark, no light variant -- so that is one pass, not two.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { beforeAll, describe, expect, it } from "vitest";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Variable specifiers: these modules are plain JavaScript and the root tsconfig compiles
// TypeScript only, so a literal specifier would be type-checked as a missing module.
const JOIN = "./join.js";
const DEVICE = "./device.js";
const AUTH_FORM = "../auth/src/auth-form.js";

type Renderer = (root: HTMLElement, state: { status: string; [key: string]: unknown }) => void;

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function violationsFor(page: string, mount?: () => void | Promise<void>) {
  const html = readFileSync(path.join(siteRoot, page), "utf8");
  // Replaces the whole document, `<html lang>` and `<head>` included, so document-level
  // rules (html-has-lang, page-has-heading-one, landmark rules) see the real page.
  document.open();
  document.write(html);
  document.close();
  await mount?.();

  const results = await axe.run(document, {
    runOnly: { type: "tag", values: WCAG_TAGS },
    rules: { "color-contrast": { enabled: false } },
    resultTypes: ["violations"]
  });
  return results.violations;
}

/** Names the rule and the offending markup, so a failure says what to fix. */
function describeViolations(violations: axe.Result[]) {
  return violations
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.html}`).join("\n")}`)
    .join("\n");
}

async function expectClean(page: string, mount?: () => void | Promise<void>) {
  const violations = await violationsFor(page, mount);
  expect(describeViolations(violations)).toBe("");
}

beforeAll(() => {
  // docs/*.html is generated and gitignored, so a clean checkout has none of it.
  if (!existsSync(path.join(siteRoot, "docs/privacy.html"))) {
    execFileSync("node", [path.join(siteRoot, "scripts/generate-docs.mjs")], { stdio: "inherit" });
  }
});

describe("static pages", () => {
  it("landing page has no axe violations", async () => {
    await expectClean("index.html");
  });

  for (const page of ["docs/index.html", "docs/install.html", "docs/cli.html", "docs/limitations.html"]) {
    it(`${page} has no axe violations`, async () => {
      await expectClean(page);
    });
  }

  // Generated pages share one template in scripts/generate-docs.mjs, so these two stand
  // in for all of them -- and the accessibility statement is one of them, which means the
  // page that claims conformance is itself under the check.
  for (const page of ["docs/privacy.html", "docs/accessibility.html"]) {
    it(`generated page ${page} has no axe violations`, async () => {
      await expectClean(page);
    });
  }
});

describe("auth pages, as rendered", () => {
  for (const mode of ["signin", "signup"] as const) {
    it(`${mode} form has no axe violations`, async () => {
      await expectClean(`auth/${mode}.html`, async () => {
        const { mountAuthForm } = (await import(AUTH_FORM)) as {
          mountAuthForm: (root: HTMLElement, options: { mode: string; onSession: () => void }) => void;
        };
        mountAuthForm(document.querySelector("#auth")!, { mode, onSession: () => {} });
      });
    });
  }

  // The submit error is the state a keyboard or screen-reader user is most likely to hit
  // and the one most likely to be conveyed by colour alone, so it gets its own scan.
  it("sign-in form with a visible error has no axe violations", async () => {
    await expectClean("auth/signin.html", async () => {
      const { mountAuthForm } = (await import(AUTH_FORM)) as {
        mountAuthForm: (root: HTMLElement, options: { mode: string; onSession: () => void }) => void;
      };
      mountAuthForm(document.querySelector("#auth")!, { mode: "signin", onSession: () => {} });
      document.querySelector<HTMLElement>("#auth-error")!.textContent = "Invalid login credentials";
      for (const input of document.querySelectorAll("#auth-form input")) input.setAttribute("aria-invalid", "true");
    });
  });
});

describe("join page, every state", () => {
  const states = [
    { status: "signed-out" },
    { status: "bad-link" },
    { status: "expired" },
    { status: "no-access" },
    { status: "unreachable" },
    { status: "ready", code: "CC-7F3A-9C2E", repo: "acme/app", cloneCommand: "git clone git@github.com:acme/app.git && cd app" }
  ];

  for (const state of states) {
    it(`${state.status} has no axe violations`, async () => {
      await expectClean("join.html", async () => {
        const { renderJoin } = (await import(JOIN)) as { renderJoin: Renderer };
        renderJoin(document.querySelector<HTMLElement>("#join")!, state);
      });
    });
  }
});

describe("device page, every state", () => {
  const states = [
    { status: "signed-out" },
    { status: "signed-out", staleSession: true },
    { status: "ready", userCode: "" },
    { status: "bad-code", userCode: "nope" },
    { status: "expired", userCode: "WDJB-MJHT" },
    { status: "used", userCode: "WDJB-MJHT" },
    { status: "not-github", userCode: "WDJB-MJHT" },
    { status: "unreachable", userCode: "WDJB-MJHT" },
    { status: "bound" }
  ];

  for (const state of states) {
    it(`${state.status}${state.staleSession ? " (stale session)" : ""} has no axe violations`, async () => {
      await expectClean("device.html", async () => {
        const { renderDevice } = (await import(DEVICE)) as { renderDevice: Renderer };
        renderDevice(document.querySelector<HTMLElement>("#device")!, state);
      });
    });
  }
});

// The skip link is the one fix that is trivial to lose when a page is copied from another,
// and axe has no rule for it (bypass passes on any page with a landmark).
describe("skip links", () => {
  const pages = [
    "index.html",
    "join.html",
    "device.html",
    "docs/index.html",
    "docs/install.html",
    "docs/cli.html",
    "docs/limitations.html",
    "docs/privacy.html",
    "docs/accessibility.html",
    "auth/signin.html",
    "auth/signup.html",
    "auth/reset.html",
    "auth/cli.html"
  ];

  for (const page of pages) {
    it(`${page} has a skip link pointing at an element that exists`, () => {
      const html = readFileSync(path.join(siteRoot, page), "utf8");
      document.open();
      document.write(html);
      document.close();

      const skip = document.querySelector<HTMLAnchorElement>("a.skip-link");
      expect(skip, `${page} has no a.skip-link`).not.toBeNull();
      expect(skip!.getAttribute("href")).toMatch(/^#\S+/);
      const target = document.querySelector(skip!.getAttribute("href")!);
      expect(target, `${page}: skip link target ${skip!.getAttribute("href")} does not exist`).not.toBeNull();
    });
  }
});
