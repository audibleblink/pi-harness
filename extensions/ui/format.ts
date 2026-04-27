/**
 * Shared display formatters used by footer and widget.
 */

/** 1 → "1", 1234 → "1.2k", 12345 → "12k". */
export function formatCount(value: number): string {
	if (value < 1000) return `${value}`;
	if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
	return `${Math.round(value / 1000)}k`;
}
