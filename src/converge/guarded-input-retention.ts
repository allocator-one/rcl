const ENCODING = 'json-string-table-v1' as const;
const MAX_DECODED_GUARDED_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_GUARDED_INPUT_NODES = 1_000_000;

type Scalar = null | boolean | number;
type EncodedNode = ['s', number] | ['v', Scalar] | ['a', EncodedNode[]] |
  ['o', Array<[number, EncodedNode]>];

export interface RetainedGuardedInput {
  version: 1;
  encoding: typeof ENCODING;
  strings: string[];
  root: EncodedNode;
}

export type StoredGuardedInput = Record<string, unknown> | RetainedGuardedInput;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function interned(strings: string[], indices: Map<string, number>, value: string): number {
  const existing = indices.get(value);
  if (existing !== undefined) return existing;
  const index = strings.length;
  strings.push(value);
  indices.set(value, index);
  return index;
}

/**
 * Retain exact JSON while storing repeated prompt and context strings once.
 * Canonical JSON size is counted during traversal so an admitted archive is
 * always within the decoder's recovery bound without materializing repeated
 * prompt strings first.
 */
export function retainGuardedInput(value: Record<string, unknown>): RetainedGuardedInput {
  if (!plainRecord(value)) throw new Error('guarded_input_invalid');
  const strings: string[] = [];
  const indices = new Map<string, number>();
  let nodes = 0;
  let expandedBytes = 0;
  const addExpandedBytes = (bytes: number): void => {
    expandedBytes += bytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_DECODED_GUARDED_INPUT_BYTES) {
      throw new Error('guarded_input_archive_expands_too_large');
    }
  };

  const encode = (item: unknown): EncodedNode => {
    nodes++;
    if (nodes > MAX_GUARDED_INPUT_NODES) throw new Error('guarded_input_too_complex');
    if (typeof item === 'string') {
      addExpandedBytes(Buffer.byteLength(JSON.stringify(item), 'utf8'));
      return ['s', interned(strings, indices, item)];
    }
    if (item === null || typeof item === 'boolean') {
      addExpandedBytes(Buffer.byteLength(JSON.stringify(item), 'utf8'));
      return ['v', item];
    }
    if (typeof item === 'number') {
      const canonical = Number.isFinite(item) ? (Object.is(item, -0) ? 0 : item) : null;
      addExpandedBytes(Buffer.byteLength(JSON.stringify(canonical), 'utf8'));
      return ['v', canonical];
    }
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      addExpandedBytes(4);
      return ['v', null];
    }
    if (Array.isArray(item)) {
      addExpandedBytes(2 + Math.max(0, item.length - 1));
      return ['a', Array.from({ length: item.length }, (_, index) => encode(item[index]))];
    }
    if (plainRecord(item)) {
      const entries = Object.entries(item).filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      addExpandedBytes(2 + Math.max(0, entries.length - 1));
      return ['o', entries.map(([key, child]) => {
        addExpandedBytes(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
        return [interned(strings, indices, key), encode(child)];
      })];
    }
    throw new Error('guarded_input_invalid');
  };

  return { version: 1, encoding: ENCODING, strings, root: encode(value) };
}

function isRetained(value: unknown): value is RetainedGuardedInput {
  return plainRecord(value) && value.encoding === ENCODING;
}

/** Restore and authenticate the canonical retained representation. */
export function restoreGuardedInput(value: StoredGuardedInput): Record<string, unknown> {
  if (!isRetained(value)) {
    if (!plainRecord(value)) throw new Error('guarded_input_invalid');
    return value;
  }
  if (Object.keys(value).sort().join(',') !== 'encoding,root,strings,version' ||
      value.version !== 1 || !Array.isArray(value.strings) ||
      value.strings.some(item => typeof item !== 'string') ||
      new Set(value.strings).size !== value.strings.length) {
    throw new Error('guarded_input_archive_invalid');
  }

  let nodes = 0;
  let expandedBytes = 0;
  let nextFirstStringIndex = 0;
  const seenStringIndices = new Set<number>();
  const encodedStringBytes = value.strings.map(string =>
    Buffer.byteLength(JSON.stringify(string), 'utf8'));
  const addExpandedBytes = (bytes: number): void => {
    expandedBytes += bytes;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_DECODED_GUARDED_INPUT_BYTES) {
      throw new Error('guarded_input_archive_expands_too_large');
    }
  };
  const stringAt = (index: unknown): string => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 ||
        (index as number) >= value.strings.length) throw new Error('guarded_input_archive_invalid');
    const resolved = index as number;
    if (!seenStringIndices.has(resolved)) {
      if (resolved !== nextFirstStringIndex) throw new Error('guarded_input_archive_invalid');
      seenStringIndices.add(resolved);
      nextFirstStringIndex++;
    }
    return value.strings[resolved]!;
  };
  const decode = (node: unknown): unknown => {
    nodes++;
    if (nodes > MAX_GUARDED_INPUT_NODES) throw new Error('guarded_input_too_complex');
    if (!Array.isArray(node) || typeof node[0] !== 'string') {
      throw new Error('guarded_input_archive_invalid');
    }
    if (node[0] === 's' && node.length === 2) {
      const string = stringAt(node[1]);
      addExpandedBytes(encodedStringBytes[node[1] as number]!);
      return string;
    }
    if (node[0] === 'v' && node.length === 2 &&
        (node[1] === null || typeof node[1] === 'boolean' ||
          (typeof node[1] === 'number' && Number.isFinite(node[1]) && !Object.is(node[1], -0)))) {
      addExpandedBytes(Buffer.byteLength(JSON.stringify(node[1]), 'utf8'));
      return node[1];
    }
    if (node[0] === 'a' && node.length === 2 && Array.isArray(node[1])) {
      addExpandedBytes(2 + Math.max(0, node[1].length - 1));
      return node[1].map(decode);
    }
    if (node[0] === 'o' && node.length === 2 && Array.isArray(node[1])) {
      const result: Record<string, unknown> = {};
      let previousKey: string | undefined;
      addExpandedBytes(2 + Math.max(0, node[1].length - 1));
      for (const entry of node[1]) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error('guarded_input_archive_invalid');
        const key = stringAt(entry[0]);
        if (previousKey !== undefined && previousKey >= key) throw new Error('guarded_input_archive_invalid');
        previousKey = key;
        addExpandedBytes(encodedStringBytes[entry[0] as number]! + 1);
        Object.defineProperty(result, key, {
          value: decode(entry[1]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    }
    throw new Error('guarded_input_archive_invalid');
  };

  const restored = decode(value.root);
  if (!plainRecord(restored) || nextFirstStringIndex !== value.strings.length) {
    throw new Error('guarded_input_archive_invalid');
  }
  return restored;
}
