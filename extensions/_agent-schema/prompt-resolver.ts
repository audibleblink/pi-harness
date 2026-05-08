/**
 * Resolve the `prompt` field. If it matches `{file:./relative/path}`, the path
 * is read from disk relative to the defining file's directory. Otherwise the
 * prompt string is returned verbatim. If `prompt` is undefined and a markdown
 * body is provided, the body is returned.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const FILE_REF = /^\s*\{file:([^}]+)\}\s*$/;

export function resolvePrompt(
	prompt: string | undefined,
	body: string | undefined,
	sourcePath: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
	if (typeof prompt !== "string") {
		return { ok: true, value: body };
	}
	const m = prompt.match(FILE_REF);
	if (!m) return { ok: true, value: prompt };
	const ref = m[1].trim();
	const baseDir = dirname(sourcePath);
	const abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
	try {
		return { ok: true, value: readFileSync(abs, "utf-8") };
	} catch (e) {
		return { ok: false, error: `failed to read prompt file "${ref}": ${(e as Error).message}` };
	}
}
