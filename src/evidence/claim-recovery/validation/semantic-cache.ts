import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_SEVERITY_ORDER } from '../../../config/defaults.js';
import type { FindingEntry, SemanticSighting } from './types.js';

/** Check cached report fields without freezing later verdicts or recovery projections. */
export function semanticCacheMatches(entry: FindingEntry, members: SemanticSighting[],
  originalTitles: ReadonlyMap<SemanticSighting, string>): boolean {
  // The producer keeps its first representative's title and descriptor. For
  // equal descriptors its stable sort retains original report order.
  const representative = members.find(s => s.round === entry.firstRound &&
    isDeepStrictEqual(s.claimDescriptor, entry.claimDescriptor));
  const latest = members.filter(s => s.round === entry.lastRound);
  if (!representative || latest.length === 0 || !originalTitles.has(representative)) return false;
  const severity = DEFAULT_SEVERITY_ORDER.find(value => latest.some(s => s.severity === value));
  let startLine = latest[0]!.startLine;
  let endLine = latest[0]!.endLine;
  for (const sighting of latest.slice(1)) {
    startLine = Math.min(startLine, sighting.startLine);
    endLine = Math.max(endLine, sighting.endLine);
  }
  return entry.title === originalTitles.get(representative) && entry.severity === severity &&
    entry.startLine === startLine && entry.endLine === endLine;
}
