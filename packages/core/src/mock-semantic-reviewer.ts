import type { SemanticReview, SemanticReviewer, SemanticReviewRequest } from "./semantic-review.js";

/**
 * Test-double `SemanticReviewer` for integration fixtures (section 25 "AI review test plan":
 * "Use a mock reviewer in integration fixtures"). It never makes a network call and has no
 * tool capability -- it just returns a canned or rule-derived response so the rest of the
 * pipeline (redaction, schema validation, policy gates, human approval) can be exercised
 * without a configured provider.
 */
export class MockSemanticReviewer implements SemanticReviewer {
  constructor(private readonly responses: Map<string, SemanticReview> = new Map(), private readonly fallback?: (request: SemanticReviewRequest) => SemanticReview) {}

  static withFixedResponse(response: SemanticReview): MockSemanticReviewer {
    return new MockSemanticReviewer(new Map(), () => response);
  }

  queueResponseFor(operationId: string, response: SemanticReview): void {
    this.responses.set(operationId, response);
  }

  async review(request: SemanticReviewRequest): Promise<SemanticReview> {
    const queued = this.responses.get(request.operationId);
    if (queued) return queued;
    if (this.fallback) return this.fallback(request);
    return {
      classification: "uncertain",
      confidence: 0,
      affectedSymbols: [],
      evidence: ["No mock response was configured for this operation"],
      invariantsToPreserve: [],
      requiresHumanApproval: true
    };
  }
}
