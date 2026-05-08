#!/usr/bin/env bash
# Phase 4 verifier — @name inline dispatch + permission.task enforcement.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

FAIL=0
ok()   { echo "✓ $1"; }
fail() { echo "✗ $1"; FAIL=1; }

# 1. Tokenizer harness (10 cases per Phase 4 plan).
HARNESS="$REPO/scripts/.phase4-harness.ts"
trap 'rm -f "$HARNESS"' EXIT
cat > "$HARNESS" <<'TS'
import { extractAtDispatches } from "../extensions/agents/at-dispatch.ts";
import { listAtMentionAgents } from "../extensions/agents/at-autocomplete.ts";
import { dispatchSpawn, checkTaskPermission } from "../extensions/agents/spawn.ts";
import type { AgentDef } from "../extensions/_agent-schema/types.ts";

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
	const a = JSON.stringify(got); const b = JSON.stringify(want);
	if (a !== b) { console.error(`  ✗ ${label}: got ${a} want ${b}`); failed++; }
	else console.log(`  ✓ ${label}`);
}

function mkDef(name: string, mode: AgentDef["mode"], extra: Partial<AgentDef> = {}): AgentDef {
	return {
		name, sourcePath: "<test>", mode, modeImplicit: false,
		description: "test agent", raw: {}, ...extra,
	};
}

const agents = new Map<string, AgentDef>([
	["alice",       mkDef("alice", "subagent")],
	["bob",         mkDef("bob",   "subagent")],
	["primaryOnly", mkDef("primaryOnly", "primary")],
	["hiddenSub",   mkDef("hiddenSub", "subagent", { hidden: true })],
	["allMode",     mkDef("allMode", "all")],
	["disabledSub", mkDef("disabledSub", "subagent", { disable: true })],
]);

console.log("# tokenizer cases");
eq("@alice hi",
	extractAtDispatches("@alice hi", agents),
	{ strippedMessage: "hi", dispatches: [{ name: "alice" }] });
eq("hi @alice there",
	extractAtDispatches("hi @alice there", agents),
	{ strippedMessage: "hi there", dispatches: [{ name: "alice" }] });
eq("@alice and @bob",
	extractAtDispatches("@alice and @bob", agents),
	{ strippedMessage: "and", dispatches: [{ name: "alice" }, { name: "bob" }] });
eq("look at @src/foo.ts",
	extractAtDispatches("look at @src/foo.ts", agents),
	{ strippedMessage: "look at @src/foo.ts", dispatches: [] });
eq("see @notes.md",
	extractAtDispatches("see @notes.md", agents),
	{ strippedMessage: "see @notes.md", dispatches: [] });
eq("@unknown hello",
	extractAtDispatches("@unknown hello", agents),
	{ strippedMessage: "@unknown hello", dispatches: [] });
eq("\\@alice literal",
	extractAtDispatches("\\@alice literal", agents),
	{ strippedMessage: "@alice literal", dispatches: [] });
eq("@primaryOnly hi",
	extractAtDispatches("@primaryOnly hi", agents),
	{ strippedMessage: "hi", dispatches: [{ name: "primaryOnly", rejected: "primary-only" }] });
eq("@hiddenSub hi",
	extractAtDispatches("@hiddenSub hi", agents),
	{ strippedMessage: "hi", dispatches: [{ name: "hiddenSub" }] });
eq("@allMode hi",
	extractAtDispatches("@allMode hi", agents),
	{ strippedMessage: "hi", dispatches: [{ name: "allMode" }] });

console.log("# autocomplete filter");
const items = listAtMentionAgents(agents).map(i => i.value).sort();
eq("autocomplete excludes hidden/disable/primary",
	items, ["@alice", "@allMode", "@bob"]);

console.log("# permission.task enforcement");
const denyPerm = { task: { "alice": "deny" as const, "*": "allow" as const } };
const askPerm  = { task: { "alice": "ask"  as const, "*": "allow" as const } };
const allowPerm = { task: { "*": "allow" as const } };
eq("checkTaskPermission deny", checkTaskPermission(denyPerm, "alice"), "deny");
eq("checkTaskPermission ask",  checkTaskPermission(askPerm,  "alice"), "ask");
eq("checkTaskPermission allow",checkTaskPermission(allowPerm,"alice"), "allow");
eq("checkTaskPermission default-allow", checkTaskPermission(undefined, "alice"), "allow");

(async () => {
	let askEmits = 0;
	const performSpawn = async () => ({ agentId: "AID-1" });
	const denied = await dispatchSpawn({ invokerPermission: denyPerm, performSpawn }, "alice", "x");
	eq("dispatchSpawn deny", denied, { kind: "denied", subagentName: "alice" });
	const asked = await dispatchSpawn({
		invokerPermission: askPerm,
		performSpawn,
		emitAsk: () => { askEmits++; },
	}, "alice", "x");
	eq("dispatchSpawn ask",   asked, { kind: "ask", subagentName: "alice" });
	eq("ask emit count", askEmits, 1);
	const allowed = await dispatchSpawn({ invokerPermission: allowPerm, performSpawn }, "alice", "x");
	eq("dispatchSpawn allow", allowed, { kind: "spawned", agentId: "AID-1" });

	if (failed > 0) { console.error(`HARNESS FAILED (${failed})`); process.exit(1); }
	console.log("harness ok");
})();
TS

if npx -y tsx "$HARNESS"; then ok "tsx harness (10 tokenizer cases + autocomplete + permission)"
else fail "tsx harness"; fi

# 2. extractAtDispatches wired in agents/index.ts.
N=$( { rg -n "extractAtDispatches\(" extensions/agents/index.ts 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$N" -ge 1 ]; then ok "extractAtDispatches referenced in extensions/agents/index.ts ($N)"
else fail "extractAtDispatches not referenced in extensions/agents/index.ts"; fi

# 3. dispatchSpawn (shared spawn helper) used by both Agent tool and @-dispatch.
T=$( { rg -n "dispatchSpawn\(|checkTaskPermission\(" extensions/agents/ 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$T" -ge 3 ]; then ok "shared spawn / permission helpers wired ($T hits)"
else fail "shared spawn helpers underused ($T)"; fi

# 4. PERMISSION_ASK_EVENT name reachable from both call sites.
A=$( { rg -n "PERMISSION_ASK_EVENT" extensions/agents/ 2>/dev/null || true; } | wc -l | tr -d ' ')
if [ "$A" -ge 3 ]; then ok "PERMISSION_ASK_EVENT referenced from spawn + tools + index ($A)"
else fail "PERMISSION_ASK_EVENT under-referenced ($A)"; fi

# 5. Build + invariants.
if bash scripts/check-build.sh >/dev/null 2>&1; then ok "check-build.sh passes"
else fail "check-build.sh failed"; bash scripts/check-build.sh; fi
if bash scripts/check-invariants.sh >/dev/null 2>&1; then ok "check-invariants.sh passes"
else fail "check-invariants.sh failed"; fi

# 6. Smoke (manual) — documented for now.
echo ""
echo "smoke (agents-at-dispatch) — MANUAL until full smoke harness lands:"
echo "  1. enable agents.enabled in settings; load fixture agents alice + bob (subagent), hiddenSub (hidden)."
echo "  2. send '@alice and @bob run a check'; verify 2 spawns, prompt = 'and run a check'."
echo "  3. autocomplete '@' → list MUST exclude hiddenSub/disabled/primary-only agents."

if [ "$FAIL" -eq 1 ]; then echo ""; echo "PHASE 4 VERIFY FAILED"; exit 1; fi
echo ""; echo "All Phase 4 checks passed ✓"
