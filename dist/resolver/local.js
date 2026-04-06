import { readFile } from 'fs/promises';
import { detectLanguage } from '../prepare/language.js';
function parseDiffText(diffText) {
    const hunks = [];
    const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean);
    for (const block of fileBlocks) {
        const lines = block.split('\n');
        const headerLine = lines[0] ?? '';
        // Extract filenames from "a/path b/path"
        const headerMatch = headerLine.match(/^a\/(.+) b\/(.+)$/);
        if (!headerMatch)
            continue;
        const aPath = headerMatch[1];
        const bPath = headerMatch[2];
        let status = 'modified';
        let previousFilename;
        const deletedMatch = block.match(/^deleted file mode/m);
        const newFileMatch = block.match(/^new file mode/m);
        const renameFromMatch = block.match(/^rename from (.+)$/m);
        const renameToMatch = block.match(/^rename to (.+)$/m);
        if (deletedMatch) {
            status = 'deleted';
        }
        else if (newFileMatch) {
            status = 'added';
        }
        else if (renameFromMatch && renameToMatch) {
            status = 'renamed';
            previousFilename = renameFromMatch[1].trim();
        }
        const filename = status === 'deleted' ? aPath : bPath;
        // Extract the actual patch lines (@@...)
        const patchStart = block.indexOf('\n@@');
        const patch = patchStart >= 0 ? block.slice(patchStart + 1) : '';
        let additions = 0;
        let deletions = 0;
        for (const line of patch.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++'))
                additions++;
            if (line.startsWith('-') && !line.startsWith('---'))
                deletions++;
        }
        hunks.push({
            filename,
            status,
            previousFilename,
            patch,
            additions,
            deletions,
        });
    }
    return hunks;
}
export async function loadLocalDiff(filePath) {
    const content = await readFile(filePath, 'utf-8');
    return parseDiffFromString(content);
}
export function parseDiffFromString(diffText) {
    const hunks = parseDiffText(diffText);
    const files = hunks.map((h) => ({
        filename: h.filename,
        status: h.status,
        additions: h.additions,
        deletions: h.deletions,
        patch: h.patch,
        language: detectLanguage(h.filename),
        previousFilename: h.previousFilename,
    }));
    return {
        files,
        source: 'local',
        rawDiff: diffText,
    };
}
//# sourceMappingURL=local.js.map