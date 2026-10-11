/**
 * Task context shared by every reviewer prompt (RCL-191): the operator's
 * specification and, for a pull request, its author-supplied title and
 * description. Built once per run so every call carries identical, bounded
 * bytes; prompts only render it as untrusted reference data.
 */
export interface TaskContext {
  spec?: string;
  prTitle?: string;
  prBody?: string;
}

export const TASK_CONTEXT_LIMITS = Object.freeze({ specBytes: 16_384, prTitleChars: 300, prBodyBytes: 4_096 });

/** Cut on a code-point boundary and say so, never silently. */
function boundBytes(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  let shown = '', used = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (used + size > maxBytes) break;
    shown += point; used += size;
  }
  return `${shown}\n[truncated: ${used} of ${total} bytes shown]`;
}

function boundChars(text: string, maxChars: number): string {
  const points = [...text];
  return points.length <= maxChars ? text : `${points.slice(0, maxChars).join('')}…`;
}

const present = (text: string | undefined): text is string => typeof text === 'string' && text.trim() !== '';

export function buildTaskContext(input: { specContent?: string; pr?: { title?: string; body?: string } }): TaskContext | undefined {
  const context: TaskContext = {};
  if (present(input.specContent)) context.spec = boundBytes(input.specContent, TASK_CONTEXT_LIMITS.specBytes);
  if (present(input.pr?.title)) context.prTitle = boundChars(input.pr!.title.trim(), TASK_CONTEXT_LIMITS.prTitleChars);
  if (present(input.pr?.body)) context.prBody = boundBytes(input.pr!.body, TASK_CONTEXT_LIMITS.prBodyBytes);
  return Object.keys(context).length > 0 ? context : undefined;
}
