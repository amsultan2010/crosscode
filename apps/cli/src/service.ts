import {
  createInviteRequestSchema,
  createProjectRequestSchema,
  redeemSyncInviteResponseSchema,
  syncInviteSchema,
  syncProjectSchema,
  type CreateInviteRequest,
  type CreateProjectRequest,
  type RedeemSyncInviteResponse,
  type SyncInvite,
  type SyncProject
} from "../../../packages/protocol/src/sync.js";
import { z } from "zod";
import { CliError } from "./errors.js";

/**
 * `GET /v1/legal/acceptances`: which documents this account still owes, and at which version
 * the current ones are published.
 *
 * The versions are read off this answer and posted straight back, never composed locally.
 * The service refuses a version that is not the current one, so a CLI that guessed would
 * fail loudly rather than record an acceptance of a text nobody was shown.
 */
const legalStatusSchema = z.object({
  accepted: z.record(z.string(), z.string()),
  outstanding: z.array(z.string()),
  documents: z.array(z.object({ document: z.string(), version: z.string(), url: z.string() }))
});

export type LegalStatus = z.infer<typeof legalStatusSchema>;

/**
 * The three service routes the CLI needs, as a narrow interface.
 *
 * The service itself is being written in parallel, so the CLI builds against the contract in
 * `packages/protocol/src/sync.ts` and against nothing else: request and response bodies are
 * parsed with the contract's own schemas, so the day the routes land a mismatch is a loud
 * validation failure here rather than a wrong value carried onward.
 *
 * Tests substitute their own implementation of this type; there is no other seam.
 */
export type SyncService = {
  /**
   * `POST /v1/projects`.
   *
   * STUB (behaviour not in the contract): assumed idempotent per `repo` -- a caller who
   * already has a project for `acme/app` gets that project back rather than a second one.
   * `crosscode start` has to be safe to run twice, and the contract describes no `GET
   * /v1/projects` to look one up with, so the idempotency has to live in the write route.
   */
  createProject(request: CreateProjectRequest): Promise<SyncProject>;
  /** `POST /v1/invites`. */
  createInvite(request: CreateInviteRequest): Promise<SyncInvite>;
  /**
   * `POST /v1/invites/:code/redeem`. Fails when the caller has no access to the repo.
   *
   * `githubToken` is the invitee's own GitHub OAuth token, which the service asks GitHub
   * about before it lets anybody into a room -- an invite code is forwardable, so the
   * repository is the gate. It comes out of the sign-in that just happened; see
   * SignInResult in auth.ts.
   */
  redeemInvite(code: string, githubToken: string): Promise<RedeemSyncInviteResponse>;
  /** `GET /v1/legal/acceptances`. What this account still has to accept. */
  legalStatus(): Promise<LegalStatus>;
  /**
   * `POST /v1/legal/acceptances`. Records that the person at this terminal accepted, at the
   * versions `legalStatus()` just reported. Client-side assent that is never sent is not
   * evidence of anything, which is the whole reason this route exists.
   */
  acceptTerms(documents: Record<string, string>): Promise<void>;
};

/** The credential header the redeem route reads. Mirrors GITHUB_TOKEN_HEADER in the service. */
const GITHUB_TOKEN_HEADER = "x-crosscode-github-token";

export function httpSyncService(baseUrl: string, accessToken: string, fetchImpl: typeof fetch = fetch): SyncService {
  async function post<T>(path: string, body: unknown, schema: { parse: (value: unknown) => T }, describe: string, headers: Record<string, string> = {}): Promise<T> {
    // Absolute path onto an origin: `new URL` discards any path the base carries, which is
    // why SERVICE_URL is origin-only.
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}`, ...headers },
      body: JSON.stringify(body)
    }).catch((error: Error) => {
      throw new CliError("SERVICE_UNREACHABLE", `${describe} could not reach ${baseUrl}: ${error.message}`, "Check your network connection and try again.");
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new CliError(
        response.status === 401 || response.status === 403 ? "SERVICE_FORBIDDEN" : "SERVICE_FAILED",
        `${describe} failed: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`,
        response.status === 401 ? "Your sign-in has expired. Run `crosscode start` to sign in again." : undefined
      );
    }
    // The service wraps every answer in `{ ok, data }`; the contract describes what is
    // inside that, so the envelope comes off before the schema sees it.
    const payload: unknown = await response.json();
    return schema.parse(typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data: unknown }).data : payload);
  }

  async function get<T>(path: string, schema: { parse: (value: unknown) => T }, describe: string): Promise<T> {
    const response = await fetchImpl(new URL(path, baseUrl), {
      headers: { authorization: `Bearer ${accessToken}` }
    }).catch((error: Error) => {
      throw new CliError("SERVICE_UNREACHABLE", `${describe} could not reach ${baseUrl}: ${error.message}`, "Check your network connection and try again.");
    });
    if (!response.ok) {
      throw new CliError(
        response.status === 401 || response.status === 403 ? "SERVICE_FORBIDDEN" : "SERVICE_FAILED",
        `${describe} failed: ${response.status}`,
        response.status === 401 ? "Your sign-in has expired. Run `crosscode start` to sign in again." : undefined
      );
    }
    const payload: unknown = await response.json();
    return schema.parse(typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data: unknown }).data : payload);
  }

  return {
    createProject: (request) => post("/v1/projects", createProjectRequestSchema.parse(request), syncProjectSchema, "Creating the project"),
    createInvite: (request) => post("/v1/invites", createInviteRequestSchema.parse(request), syncInviteSchema, "Creating the invite"),
    redeemInvite: (code, githubToken) => post(
      `/v1/invites/${encodeURIComponent(code)}/redeem`, {}, redeemSyncInviteResponseSchema, "Redeeming the invite",
      { [GITHUB_TOKEN_HEADER]: githubToken }
    ),
    legalStatus: () => get("/v1/legal/acceptances", legalStatusSchema, "Checking the terms"),
    acceptTerms: async (documents) => {
      await post("/v1/legal/acceptances", { surface: "cli", documents }, z.unknown(), "Recording your acceptance of the terms");
    }
  };
}
