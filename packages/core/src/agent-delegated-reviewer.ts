import { randomUUID } from "node:crypto";
import {
  buildSemanticReviewPrompt, UNCERTAIN_FALLBACK,
  type SemanticReview, type SemanticReviewer, type SemanticReviewPrompt, type SemanticReviewRequest
} from "./semantic-review.js";

type PendingReview = {
  request: SemanticReviewRequest;
  prompt: SemanticReviewPrompt;
  resolve: (review: unknown) => void;
  requestedAt: string;
  timer: ReturnType<typeof setTimeout>;
};

export type PendingSemanticReview = {
  requestId: string;
  requestedAt: string;
  request: SemanticReviewRequest;
  /**
   * The same bundle rendered for a model: the fixed policy preamble plus the file
   * content wrapped in explicit `<untrusted-content>` delimiters.
   *
   * This is what makes the prompt-injection guarantee in docs/security.md true for the
   * delegated path. The reviewing agent is another LLM reading repository text that may
   * contain instructions aimed at it, so it must receive that text already framed as
   * data -- handing over only the raw request left the preamble unused and the framing
   * up to whatever the agent happened to do with a bare JSON blob.
   */
  prompt: SemanticReviewPrompt;
};

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Delegates review to whichever coding agent is connected to the daemon via MCP for this
 * session, instead of calling an external AI provider. `review()` parks a pending request
 * until `submit()` supplies the agent's answer (or `timeoutMs` elapses); it never validates
 * what it resolves with -- the daemon's `requestSemanticReview` already runs
 * `applyRiskSafetyGate(validateSemanticReview(raw), risk)` on the result.
 */
export class AgentDelegatedReviewer implements SemanticReviewer {
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingReview>();

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  review(request: SemanticReviewRequest): Promise<SemanticReview> {
    const requestId = randomUUID();
    const prompt = buildSemanticReviewPrompt(request);
    return new Promise<SemanticReview>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ...UNCERTAIN_FALLBACK });
      }, this.timeoutMs);
      this.pending.set(requestId, { request, prompt, resolve: resolve as (review: unknown) => void, requestedAt: new Date().toISOString(), timer });
    });
  }

  listPending(): PendingSemanticReview[] {
    return [...this.pending.entries()].map(([requestId, entry]) => ({
      requestId, requestedAt: entry.requestedAt, request: entry.request, prompt: entry.prompt
    }));
  }

  submit(requestId: string, review: unknown): { ok: true } | { ok: false; error: string } {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, error: `No pending semantic review for requestId "${requestId}"` };
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(review);
    return { ok: true };
  }
}
