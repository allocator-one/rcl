import type { Finding, ModelReview, DeduplicatedGroup } from './types.js';

const LINE_WINDOW = 5;

/**
 * Compute Jaccard similarity between two strings (word-level tokenization)
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    return new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2)
    );
  };

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

interface TaggedFinding {
  finding: Finding;
  model: string;
  role: string;
}

function linesOverlap(a: Finding, b: Finding, window: number): boolean {
  const aStart = Math.max(0, a.startLine - window);
  const aEnd = a.endLine + window;
  const bStart = Math.max(0, b.startLine - window);
  const bEnd = b.endLine + window;
  return aStart <= bEnd && bStart <= aEnd;
}

function areSameFile(a: Finding, b: Finding): boolean {
  return a.file === b.file;
}

function sameCategory(a: Finding, b: Finding): boolean {
  return a.category === b.category;
}

function areDuplicates(
  a: Finding,
  b: Finding,
  jaccardThreshold: number,
  lineWindow: number
): boolean {
  if (!areSameFile(a, b)) return false;
  if (!sameCategory(a, b)) return false;
  if (!linesOverlap(a, b, lineWindow)) return false;

  const titleSim = jaccardSimilarity(a.title, b.title);
  const descSim = jaccardSimilarity(a.description, b.description);
  const maxSim = Math.max(titleSim, descSim);

  return maxSim >= jaccardThreshold;
}

/**
 * Choose the representative finding from a group:
 * - Prefer higher severity
 * - Break ties by description length (more detail wins)
 */
function chooseRepresentative(members: TaggedFinding[]): Finding {
  const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };

  return members.reduce((best, curr) => {
    const bestScore = severityOrder[best.finding.severity];
    const currScore = severityOrder[curr.finding.severity];
    if (currScore < bestScore) return curr;
    if (currScore === bestScore && curr.finding.description.length > best.finding.description.length)
      return curr;
    return best;
  }).finding;
}

export function deduplicateFindings(
  reviews: ModelReview[],
  jaccardThreshold = 0.3,
  lineWindow = LINE_WINDOW
): DeduplicatedGroup[] {
  // Flatten all findings with attribution
  const all: TaggedFinding[] = [];
  for (const review of reviews) {
    if (review.status !== 'success') continue;
    for (const finding of review.findings) {
      all.push({ finding, model: review.model, role: review.role });
    }
  }

  if (all.length === 0) return [];

  // Union-Find style grouping
  const groupOf = new Array<number>(all.length).fill(-1);

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (
        areDuplicates(all[i]!.finding, all[j]!.finding, jaccardThreshold, lineWindow)
      ) {
        // Merge groups: find root of i
        let rootI = i;
        while (groupOf[rootI] !== -1) rootI = groupOf[rootI]!;
        let rootJ = j;
        while (groupOf[rootJ] !== -1) rootJ = groupOf[rootJ]!;

        if (rootI !== rootJ) {
          groupOf[rootJ] = rootI;
        }
      }
    }
  }

  // Collect groups
  const groups = new Map<number, TaggedFinding[]>();
  for (let i = 0; i < all.length; i++) {
    let root = i;
    while (groupOf[root] !== -1) root = groupOf[root]!;
    const existing = groups.get(root) ?? [];
    existing.push(all[i]!);
    groups.set(root, existing);
  }

  const result: DeduplicatedGroup[] = [];
  for (const members of groups.values()) {
    result.push({
      representative: chooseRepresentative(members),
      members,
    });
  }

  // Sort by severity then file
  const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };
  result.sort((a, b) => {
    const sevDiff =
      severityOrder[a.representative.severity] -
      severityOrder[b.representative.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.representative.file.localeCompare(b.representative.file);
  });

  return result;
}
