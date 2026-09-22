/** An interpretation of immutable JSON, never replacement artifact bytes. */
export interface ProseTransformation {
  path: string;
  code_unit_offset: number;
  source_byte_offset: number;
  original_unit: string;
  replacement: string;
}
/** Additive record for explicitly selected C0/DEL prose representation. */
export interface ControlProseTransformation extends ProseTransformation {
  version: 1;
  kind: 'control_code_unit';
}
export type OriginalProseTransformation = ProseTransformation | ControlProseTransformation;
export type OriginalProseMode = 'control-code-units-v1';
export interface DecodeOriginalReportOptions {
  originalProse?: OriginalProseMode;
  /** Refuse numeric tokens whose original decimal meaning is lost by JSON parsing. */
  exactNumbers?: boolean;
}
export const findingProsePath = /^(?:\/(?:findings|belowThresholdFindings)\/\d+|\/reviews\/\d+\/findings\/\d+)\/(?:title|description|suggestedFix)$/;
const pointer = (parts: string[]) => '/' + parts.map(p => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
const scalarToken = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;

/** Compare decimal meanings without converting the original token to a float. */
function decimalIdentity(token: string): string {
  const negative = token.startsWith('-');
  const [mantissa, exponent = '0'] = (negative ? token.slice(1) : token).toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa!.split('.');
  const digits = (integer! + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const significant = digits.replace(/0+$/, '');
  const power = Number(exponent) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(power)) throw new Error('invalid_or_ambiguous_original_json');
  return `${negative ? '-' : ''}${significant}e${power}`;
}

/** UTF-8 prefix lengths for the immutable source, computed once only when needed. */
function utf8Offsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    offsets[index] = bytes;
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) bytes++;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      // Buffer.byteLength on a prefix ending between a valid pair encodes the
      // detached high unit as U+FFFD; normal scanner offsets never land there.
      offsets[index + 1] = bytes + 3;
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

/** Strict JSON with duplicate-key detection and explicit prose-only lone-surrogate notation. */
export function decodeOriginalReport(text: string, options: DecodeOriginalReportOptions = {}): { value: unknown; transformations: OriginalProseTransformation[] } {
  if (options.originalProse !== undefined && options.originalProse !== 'control-code-units-v1') throw new Error('unsupported_original_prose_mode');
  let at = 0;
  const transformations: OriginalProseTransformation[] = [];
  let sourceOffsets: Uint32Array | undefined;
  const fail = (): never => { throw new Error('invalid_or_ambiguous_original_json'); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[at] ?? 'x')) at++; };
  function string(path: string[], key = false): string {
    const start = at++;
    if (text[start] !== '"') return fail();
    const offsets = new Map<number, number>();
    let units = 0;
    while (at < text.length && text[at] !== '"') {
      // Valid UTF-8 cannot contain a literal unpaired unit. Only \u escapes
      // need source positions; avoid one allocation per prose character.
      if ((text[at] === '\\' && (text[at + 1] === 'u' || 'bfnrt'.includes(text[at + 1] ?? ''))) || text.charCodeAt(at) === 0x7f) offsets.set(units, at);
      if (text[at] === '\\') { at += text[at + 1] === 'u' ? 6 : 2; }
      else at++;
      units++;
    }
    if (text[at++] !== '"') return fail();
    let value: string;
    try { value = JSON.parse(text.slice(start, at)) as string; } catch { return fail(); }
    const pathText = pointer(path);
    let result = '';
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      const forbiddenControl = unit === 0 || (unit >= 1 && unit <= 8) || unit === 11 || unit === 12 ||
        (unit >= 14 && unit <= 31) || unit === 127;
      if (forbiddenControl) {
        if (options.originalProse !== undefined) {
          if (key || !findingProsePath.test(pathText)) throw new Error('unsupported_control_in_original');
          const source = offsets.get(i);
          if (source === undefined) throw new Error('unsupported_literal_control');
          sourceOffsets ??= utf8Offsets(text);
          const original_unit = unit.toString(16).padStart(4, '0').toUpperCase();
          const replacement = `\\u${original_unit}`;
          transformations.push({ version: 1, kind: 'control_code_unit', path: pathText, code_unit_offset: i,
            source_byte_offset: sourceOffsets[source]!, original_unit, replacement });
          result += replacement;
          continue;
        }
        if (unit === 0) throw new Error('unsupported_nul_in_original');
        throw new Error('unsupported_control_in_original');
      }
      if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        result += value.slice(i, i + 2); i++; continue;
      }
      if (unit >= 0xd800 && unit <= 0xdfff) {
        if (key || !findingProsePath.test(pathText)) throw new Error('unsupported_structural_surrogate');
        const hex = unit.toString(16).toUpperCase(); const replacement = `\\u${hex}`;
        const source = offsets.get(i);
        if (source === undefined) throw new Error('unsupported_literal_surrogate');
        sourceOffsets ??= utf8Offsets(text);
        transformations.push({ path: pathText, code_unit_offset: i, source_byte_offset: sourceOffsets[source]!, original_unit: hex, replacement });
        result += replacement;
      } else result += value[i];
    }
    return result;
  }
  function value(path: string[], depth: number): unknown {
    if (depth > 64) throw new Error('original_json_too_deep');
    whitespace();
    if (text[at] === '"') return string(path);
    if (text[at] === '{') {
      at++; whitespace(); const out: Record<string, unknown> = Object.create(null);
      if (text[at] === '}') { at++; return out; }
      for (;;) {
        whitespace(); const key = string(path, true);
        if (Object.hasOwn(out, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail();
        whitespace(); if (text[at++] !== ':') return fail();
        out[key] = value([...path, key], depth + 1); whitespace();
        if (text[at] === '}') { at++; return out; }
        if (text[at++] !== ',') return fail();
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); const out: unknown[] = [];
      if (text[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value([...path, String(out.length)], depth + 1)); whitespace();
        if (text[at] === ']') { at++; return out; }
        if (text[at++] !== ',') return fail();
      }
    }
    scalarToken.lastIndex = at;
    const token = scalarToken.exec(text);
    if (!token) return fail(); at += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    if (typeof parsed === 'number' && (!Number.isFinite(parsed) || Math.abs(parsed) > Number.MAX_SAFE_INTEGER)) return fail();
    if (typeof parsed === 'number' && options.exactNumbers &&
        decimalIdentity(token[0]) !== decimalIdentity(JSON.stringify(parsed))) return fail();
    return parsed;
  }
  const result = value([], 0); whitespace(); if (at !== text.length) return fail();
  return { value: JSON.parse(JSON.stringify(result)) as unknown, transformations };
}
