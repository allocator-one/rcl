import { type Chunk } from './chunker.js';
import type { Role } from '../roles/types.js';
export interface PromptContext {
    contextFiles?: string[];
    specFile?: string;
}
export interface BuiltPrompt {
    systemPrompt: string;
    userPrompt: string;
}
export declare function buildPrompt(chunk: Chunk, role: Role, context?: PromptContext): Promise<BuiltPrompt>;
