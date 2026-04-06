import { z } from 'zod';
const FindingSchema = z.object({
    id: z.string(),
    file: z.string(),
    startLine: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative(),
    severity: z.enum(['critical', 'important', 'minor', 'nitpick']),
    category: z.enum(['security', 'correctness', 'best-practices', 'tests', 'api-design']),
    title: z.string().max(200),
    description: z.string(),
    suggestedFix: z.string().optional(),
});
const ReviewOutputSchema = z.object({
    findings: z.array(FindingSchema),
});
/**
 * Extract JSON from a string that may have prose around it
 */
function extractJson(text) {
    // Try direct parse first
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return trimmed;
    }
    // Try to find JSON block in markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }
    // Try to find the first { ... } block
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        return text.slice(start, end + 1);
    }
    return null;
}
export function parseReviewOutput(rawOutput, model, role) {
    const warnings = [];
    if (!rawOutput || rawOutput.trim().length === 0) {
        warnings.push(`${model}/${role}: empty output`);
        return { findings: [], warnings };
    }
    const jsonText = extractJson(rawOutput);
    if (!jsonText) {
        warnings.push(`${model}/${role}: could not extract JSON from output`);
        return { findings: [], warnings };
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        warnings.push(`${model}/${role}: JSON parse error: ${String(err)}`);
        return { findings: [], warnings };
    }
    const result = ReviewOutputSchema.safeParse(parsed);
    if (!result.success) {
        // Try to salvage individual findings
        if (typeof parsed === 'object' &&
            parsed !== null &&
            'findings' in parsed &&
            Array.isArray(parsed.findings)) {
            const rawFindings = parsed.findings;
            const salvaged = [];
            for (const item of rawFindings) {
                const itemResult = FindingSchema.safeParse(item);
                if (itemResult.success) {
                    salvaged.push(itemResult.data);
                }
                else {
                    warnings.push(`${model}/${role}: dropped malformed finding: ${JSON.stringify(item).slice(0, 100)}`);
                }
            }
            if (salvaged.length > 0) {
                warnings.push(`${model}/${role}: schema validation errors (salvaged ${salvaged.length} findings)`);
                return { findings: salvaged, warnings };
            }
        }
        warnings.push(`${model}/${role}: schema validation failed: ${result.error.issues.map((e) => e.message).join(', ')}`);
        return { findings: [], warnings };
    }
    // Assign stable IDs if missing or colliding
    const findings = result.data.findings.map((f, i) => ({
        ...f,
        id: f.id || `${model.replace(/[^a-z0-9]/gi, '')}_${role}_${i}`,
    }));
    return { findings, warnings };
}
//# sourceMappingURL=parser.js.map