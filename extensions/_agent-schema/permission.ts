/**
 * Permission map normalization + checkPermission() helper.
 *
 * Validation: unknown keys produce an error; values must be either a shorthand
 * action ("allow"|"ask"|"deny") or, for object-capable keys, an object whose
 * values are actions.
 *
 * checkPermission semantics: when the key holds an object map, patterns are
 * tested in source-iteration order and the FIRST matching pattern wins. This
 * lets users put specific patterns ahead of wildcards, e.g.
 *   { "git push": "ask", "*": "allow" }
 * makes "git push" → "ask" and any other command → "allow".
 */

import type {
	PermissionAction,
	PermissionKey,
	PermissionMap,
	PermissionValue,
} from "./types.js";
import { OBJECT_CAPABLE_PERMISSION_KEYS, PERMISSION_KEYS } from "./types.js";

const ACTIONS: ReadonlySet<PermissionAction> = new Set(["allow", "ask", "deny"]);
const KEY_SET: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function normalizePermission(
	raw: unknown,
): { ok: true; value: PermissionMap | undefined } | { ok: false; error: string } {
	if (raw === undefined || raw === null) return { ok: true, value: undefined };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: `permission must be an object` };
	}
	const out: PermissionMap = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!KEY_SET.has(k)) {
			return { ok: false, error: `unknown permission key "${k}"` };
		}
		const key = k as PermissionKey;
		if (typeof v === "string") {
			if (!ACTIONS.has(v as PermissionAction)) {
				return { ok: false, error: `invalid permission action "${v}" for "${k}"` };
			}
			out[key] = v as PermissionAction;
			continue;
		}
		if (v && typeof v === "object" && !Array.isArray(v)) {
			if (!OBJECT_CAPABLE_PERMISSION_KEYS.has(key)) {
				return { ok: false, error: `permission key "${k}" does not accept object form` };
			}
			const obj: Record<string, PermissionAction> = {};
			for (const [pat, act] of Object.entries(v as Record<string, unknown>)) {
				if (typeof act !== "string" || !ACTIONS.has(act as PermissionAction)) {
					return { ok: false, error: `invalid permission action for ${k}["${pat}"]` };
				}
				obj[pat] = act as PermissionAction;
			}
			out[key] = obj;
			continue;
		}
		return { ok: false, error: `invalid permission value for "${k}"` };
	}
	return { ok: true, value: out };
}

/** Glob → regex (supports `*` and `?` only). */
function globToRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

/**
 * Resolve an action for `key` (and optional `pattern`) against `perm`.
 * Returns undefined when no matching rule exists.
 */
export function checkPermission(
	perm: PermissionMap | undefined,
	key: PermissionKey,
	pattern?: string,
): PermissionAction | undefined {
	if (!perm) return undefined;
	const v: PermissionValue | undefined = perm[key];
	if (v === undefined) return undefined;
	if (typeof v === "string") return v;
	if (pattern === undefined) return undefined;
	for (const [pat, act] of Object.entries(v)) {
		if (globToRegex(pat).test(pattern)) return act;
	}
	return undefined;
}
