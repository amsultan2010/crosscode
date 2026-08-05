import { discoverRepository } from "@crosscode/git";
import type { SyncInvite } from "../../../packages/protocol/src/sync.js";
import { readConfig } from "./config.js";
import { CliError } from "./errors.js";
import type { Environment } from "./setup.js";

/**
 * `crosscode invite` -- one URL, which is the entire sending half of onboarding. The
 * receiving half is the `/join/:code` page in apps/docs-site.
 */
export async function invite(directory: string, environment: Environment): Promise<SyncInvite> {
  const repository = await discoverRepository(directory).catch(() => undefined);
  if (!repository) throw new CliError("NOT_A_GIT_REPOSITORY", "Crosscode runs inside a Git repository", "cd into your project first.");

  const config = await readConfig(repository.root);
  if (!config?.service.session) {
    throw new CliError("NOT_CONFIGURED", "This checkout is not set up for Crosscode yet", "Run `crosscode start` first.");
  }
  return environment.createService(config.service.session.accessToken).createInvite({ projectId: config.projectId, expiresInHours: 168 });
}
