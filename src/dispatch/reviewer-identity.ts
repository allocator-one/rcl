/** The existing consensus key is eligible only when it identifies one exact tuple. */
export interface ReviewerIdentity { readonly model: string; readonly role: string }

export class AmbiguousReviewerIdentityError extends Error {
  constructor(first: ReviewerIdentity, second: ReviewerIdentity) {
    super(`ambiguous_reviewer_identity: ${JSON.stringify([first.model, first.role])} and ${JSON.stringify([second.model, second.role])} share a consensus key. Use unambiguous reviewer model and role combinations.`);
    this.name = 'AmbiguousReviewerIdentityError';
  }
}

/** Preserve duplicate assignment instances and legacy merge semantics for eligible inputs. */
export function assertUnambiguousReviewerIdentities(reviewers: readonly ReviewerIdentity[]): void {
  const byKey = new Map<string, ReviewerIdentity>();
  for (const reviewer of reviewers) {
    const key = `${reviewer.model}::${reviewer.role}`;
    const previous = byKey.get(key);
    if (previous && (previous.model !== reviewer.model || previous.role !== reviewer.role)) {
      throw new AmbiguousReviewerIdentityError(previous, reviewer);
    }
    byKey.set(key, reviewer);
  }
}
