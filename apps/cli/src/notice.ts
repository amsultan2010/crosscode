import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./errors.js";

/**
 * The notice `crosscode start` shows before it does anything, and the keypress that answers
 * it.
 *
 * This matters beyond the contract. Crosscode writes other people's edits into the working
 * tree of the checkout it is pointed at -- it can overwrite a file somebody is looking at,
 * and §9 of the terms disclaims exactly that. A disclaimer belongs where the risk is taken,
 * which is a terminal, not a footer on a website nobody opened.
 *
 * Once per machine, not once per checkout: the person running this has already read it by
 * the time they set up their second repository, and a notice that appears every time is a
 * notice nobody reads. The flag lives under the user's config directory for the same reason
 * -- a checkout-local file would reappear with every clone.
 */

const APP_URL = "https://www.getcrosscode.dev";
export const TERMS_URL = `${APP_URL}/docs/terms.html`;
export const PRIVACY_URL = `${APP_URL}/docs/privacy-policy.html`;

/**
 * Bumped when the notice's *text* changes materially, so a machine that acknowledged an
 * older wording is shown the newer one. It is not the terms' version: whether the terms
 * themselves have been accepted is the service's answer, not a local file's.
 */
const NOTICE_VERSION = 1;

export const FIRST_RUN_NOTICE = [
  "Before Crosscode starts:",
  "",
  "  * Crosscode writes your teammates' uncommitted edits into this working tree. It can",
  "    overwrite a file you are looking at. Git is your source of truth -- commit or stash",
  "    anything you are not willing to have changed.",
  "  * Only Git-tracked files sync. The hosted service holds their contents for about seven",
  "    days and can read them; there is no end-to-end encryption.",
  "  * Crosscode is provided as is, with no warranty, and liability is limited.",
  "",
  `  Terms of Service: ${TERMS_URL}`,
  `  Privacy Policy:   ${PRIVACY_URL}`
].join("\n");

export const TERMS_CHANGED_NOTICE = [
  "The Crosscode terms have changed since you last accepted them.",
  "",
  `  Terms of Service: ${TERMS_URL}`,
  `  Privacy Policy:   ${PRIVACY_URL}`
].join("\n");

export type ConfirmKind = "first-run" | "changed";

export type ConfirmTermsOptions = {
  kind: ConfirmKind;
  /** `--yes`: assent given on the command line, for CI and scripted installs. */
  assumeYes?: boolean;
  report?: (line: string) => void;
  /** Overridden in tests. Defaults to the user's config directory. */
  configHome?: string;
  /** Overridden in tests. Defaults to one keypress on a TTY. */
  waitForKeypress?: () => Promise<boolean>;
};

/**
 * Shows the notice and waits for assent, unless this machine has already seen it.
 *
 * Returns whether it prompted, because that is what tells the caller the person in front of
 * the terminal actually agreed to something just now -- which is the only circumstance in
 * which `crosscode start` records an acceptance on their behalf.
 */
export async function confirmTerms(options: ConfirmTermsOptions): Promise<boolean> {
  const report = options.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (options.kind === "first-run" && await alreadyAcknowledged(options.configHome)) return false;

  report(options.kind === "first-run" ? FIRST_RUN_NOTICE : TERMS_CHANGED_NOTICE);
  if (options.assumeYes) {
    report("Accepted with --yes.");
  } else {
    report("Press any key to accept and continue, or Ctrl-C to stop.");
    const confirmed = await (options.waitForKeypress ?? waitForKeypress)();
    if (!confirmed) {
      throw new CliError(
        "TERMS_NOT_ACCEPTED",
        "Crosscode needs you to accept its terms before it sets this checkout up",
        `Read them at ${TERMS_URL}, then run the command again in a terminal -- or pass --yes to accept them from a script.`
      );
    }
  }
  await recordAcknowledgement(options.configHome);
  return true;
}

/** Where the "this machine has seen the notice" flag lives. */
export function noticeStatePath(configHome?: string): string {
  // `||`, not `??`: an exported but empty XDG_CONFIG_HOME is a real shell environment, and
  // it made this a relative path -- the flag went into whatever directory `crosscode start`
  // was run from, so the notice reappeared in every checkout and left a stray file in each.
  const base = configHome || process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "crosscode", "first-run.json");
}

async function alreadyAcknowledged(configHome?: string): Promise<boolean> {
  const contents = await readFile(noticeStatePath(configHome), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (contents === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(contents);
    // An unreadable or older flag is treated as "not seen": showing the notice twice is a
    // small annoyance, and not showing it at all is the failure that matters.
    return typeof parsed === "object" && parsed !== null && (parsed as { noticeVersion?: unknown }).noticeVersion === NOTICE_VERSION;
  } catch {
    return false;
  }
}

async function recordAcknowledgement(configHome?: string): Promise<void> {
  const path = noticeStatePath(configHome);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ noticeVersion: NOTICE_VERSION, acknowledgedAt: new Date().toISOString() }, null, 2)}\n`);
}

/**
 * One keypress, or false when there is nobody to press one.
 *
 * A non-interactive stdin is not a silent yes: CI and scripted installs say so with `--yes`,
 * and anything else hangs forever or, worse, proceeds on an assent nobody gave.
 */
async function waitForKeypress(): Promise<boolean> {
  const input = process.stdin;
  if (!input.isTTY) return false;
  return new Promise<boolean>((resolve) => {
    input.setRawMode(true);
    input.resume();
    input.once("data", (data: Buffer) => {
      input.setRawMode(false);
      input.pause();
      // Ctrl-C and Escape are the two ways a person says no to a "press any key" prompt.
      resolve(data[0] !== 0x03 && data[0] !== 0x1b);
    });
  });
}
