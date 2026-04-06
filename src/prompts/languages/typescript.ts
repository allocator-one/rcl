export const TYPESCRIPT_PROMPT_ADDITION = `## TypeScript-Specific Review Areas

- Type safety: unsafe \`any\`, type assertions without guards, missing return types on exported functions
- Null/undefined handling: optional chaining gaps, nullish coalescing opportunities, non-null assertions (\`!\`) without validation
- Async patterns: unhandled promise rejections, missing \`await\`, floating promises, race conditions
- Import/module issues: circular imports, missing .js extensions for ESM, incorrect module resolution
- Generic constraints: overly loose or missing constraints
- Discriminated unions: exhaustiveness checks, missing cases in switch/if chains
- Error handling: catch blocks that swallow errors, error types that are \`unknown\` without narrowing
- Class patterns: uninitialized properties, constructor ordering
- Readonly violations, immutability issues
- tsconfig strictness bypasses`;
