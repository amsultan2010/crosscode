/**
 * The one place a legal document's current version is written down.
 *
 * Everything that shows a document, records an acceptance, or decides whether somebody has
 * to accept again reads it from here -- the service constant is authoritative and every
 * other surface asks the service for it (`GET /v1/legal`) rather than carrying its own copy.
 * That is the whole point: the version stored against a user has to be the version of the
 * text they were shown, and two constants in two languages drift the first time one of them
 * is edited.
 *
 * A version is a date string, and it is compared for *equality*, never for order. Any change
 * to the text is a new version, and a new version means everybody accepts again -- which is
 * what §11 of the terms promises.
 */

/** Every document an acceptance can be recorded against. Matches the table's CHECK. */
export const LEGAL_DOCUMENTS = ["terms", "privacy", "dpa"] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** Where an acceptance was given. Matches the table's CHECK. */
export const ACCEPTANCE_SURFACES = ["signup", "signin", "device", "join", "cli"] as const;
export type AcceptanceSurface = (typeof ACCEPTANCE_SURFACES)[number];

/**
 * The current version of each document, or null for one that does not exist yet.
 *
 * These strings must equal the effective date printed at the top of the document itself.
 * `docs/terms.md` is still a draft with an unfilled `[EFFECTIVE DATE]`, so this is the date
 * the acceptance mechanism was built and is the value to change -- in this file, once -- the
 * day the text is finalised.
 */
export const LEGAL_VERSIONS: Record<LegalDocument, string | null> = {
  terms: "2026-08-01",
  privacy: "2026-08-01",
  // No data processing addendum exists yet. The document is accepted-against-able the day
  // one does; until then nobody can be asked to accept a text that is not written.
  dpa: null
};

/** Where each document is published, relative to the site origin. */
export const LEGAL_URLS: Record<LegalDocument, string> = {
  terms: "/docs/terms.html",
  privacy: "/docs/privacy-policy.html",
  dpa: "/docs/dpa.html"
};

/**
 * The documents somebody has to have accepted before the service will do anything for them.
 * Derived from LEGAL_VERSIONS rather than listed again, so a document with no text cannot
 * become mandatory by being mentioned in two places and only written in one.
 */
export const REQUIRED_DOCUMENTS: readonly LegalDocument[] = ["terms", "privacy"];

export type LegalDocumentInfo = { document: LegalDocument; version: string; url: string };

/** What `GET /v1/legal` answers: what to show, at which version, and what is mandatory. */
export function currentLegalDocuments(): LegalDocumentInfo[] {
  return LEGAL_DOCUMENTS.flatMap((document) => {
    const version = LEGAL_VERSIONS[document];
    return version ? [{ document, version, url: LEGAL_URLS[document] }] : [];
  });
}

/**
 * The required documents this user has not accepted at their current version.
 *
 * Equality, not recency: a stored version that is merely *different* from the current one is
 * outstanding, so a correction that lowers a date still prompts rather than silently
 * counting as accepted.
 */
export function outstandingDocuments(accepted: Partial<Record<LegalDocument, string>>): LegalDocument[] {
  return REQUIRED_DOCUMENTS.filter((document) => {
    const current = LEGAL_VERSIONS[document];
    return current !== null && accepted[document] !== current;
  });
}

/** True when this document is at exactly the version currently published. */
export function isCurrentVersion(document: LegalDocument, version: string): boolean {
  return LEGAL_VERSIONS[document] === version;
}
