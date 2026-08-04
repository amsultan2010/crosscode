/**
 * The CLI's structured failure shape: every command failure prints as
 * `{"error":{code,message,hint}}` so an agent can branch on `code` instead of matching
 * prose. Lives in its own module because both `index.ts` and the modules it delegates to
 * throw these, and importing back into the entrypoint would be a cycle.
 */
export class CliError extends Error {
  constructor(public readonly code: string, message: string, public readonly hint?: string) {
    super(message);
  }
}
