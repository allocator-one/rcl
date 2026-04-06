import { writeFile } from 'fs/promises';
export function toJson(result, pretty = true) {
    return JSON.stringify(result, null, pretty ? 2 : 0);
}
export async function writeJsonOutput(result, path) {
    await writeFile(path, toJson(result), 'utf-8');
}
//# sourceMappingURL=json.js.map