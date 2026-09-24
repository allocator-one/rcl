/** Requirements for an OUTER filesystem adapter, never proof that a path was read safely. */
export interface SourcePathRequirement {
  kind: 'report' | 'migration' | 'native-predecessor';
  sha256: string;
  /** Exact path retained in the source, including any original alias. */
  storedPath?: string;
  /** Append to the canonical target's native state path, then qualify with realpath. */
  nativePathSuffix?: string;
}
export interface RetainedSources {
  reports: Map<string, string>;
  snapshots: Map<string, string>;
  usedReports: Set<string>;
  pathRequirements: SourcePathRequirement[];
}
