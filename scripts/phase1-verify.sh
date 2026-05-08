#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

FAIL=0
say() { echo "$@"; }
fail() { echo "  FAIL: $1"; FAIL=1; }

# 1. All seven schema files exist; module exports parseAgentFrontmatter, parseAgentJson, checkPermission.
say "1. Schema files exist + exports"
for f in types.ts parse-frontmatter.ts parse-json.ts permission.ts prompt-resolver.ts tools-spec.ts defaults.ts load-settings-agents.ts; do
  [ -f "extensions/_agent-schema/$f" ] || fail "missing extensions/_agent-schema/$f"
done
grep -q "export function parseAgentFrontmatter" extensions/_agent-schema/parse-frontmatter.ts || fail "parseAgentFrontmatter not exported"
grep -q "export function parseAgentJson" extensions/_agent-schema/parse-json.ts || fail "parseAgentJson not exported"
grep -q "export function checkPermission" extensions/_agent-schema/permission.ts || fail "checkPermission not exported"

# 2. >= 2 parseAgentFrontmatter hits across modes.ts + orchestration/
say "2. parseAgentFrontmatter delegated"
HITS=$(grep -RHn "parseAgentFrontmatter(" extensions/modes.ts extensions/orchestration/ 2>/dev/null | wc -l | tr -d ' ')
[ "$HITS" -ge 2 ] || fail "expected >=2 parseAgentFrontmatter call sites, got $HITS"

# 3. >= 1 parseAgentJson hit across extensions/
say "3. parseAgentJson wired"
HITS=$(grep -RHn "parseAgentJson(" extensions/ 2>/dev/null | wc -l | tr -d ' ')
[ "$HITS" -ge 1 ] || fail "expected >=1 parseAgentJson call site, got $HITS"

# 4. tsx harness — 11 parser behaviors
say "4. tsx harness"
PFIXTURE="$(mktemp -d -t phase1-fixture-XXXXXX)"
HARNESS="$PFIXTURE/harness.ts"
trap 'rm -rf "$PFIXTURE"' EXIT

echo "hello from file" > "$PFIXTURE/p.txt"

cat > "$HARNESS" <<TSHEAD
import { parseAgentFrontmatter } from "$REPO/extensions/_agent-schema/parse-frontmatter.js";
import { parseAgentJson } from "$REPO/extensions/_agent-schema/parse-json.js";
import { checkPermission } from "$REPO/extensions/_agent-schema/permission.js";
TSHEAD
cat >> "$HARNESS" <<'TS'

let failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log("  ok  " + label);
  else { console.log("  FAIL " + label + (detail ? " — " + detail : "")); failed++; }
}

const fixtureDir = process.env.FIXTURE_DIR!;

// (a) absent mode -> "all"
{
  const r = parseAgentFrontmatter("---\ndescription: x\n---\nbody", "/x/a.md");
  check("absent mode -> all", r.ok && r.def.mode === "all" && r.def.modeImplicit === true);
}

// (b) mode: primary
{
  const r = parseAgentFrontmatter("---\nmode: primary\n---\n", "/x/p.md");
  check("mode: primary", r.ok && r.def.mode === "primary" && r.def.modeImplicit === false);
}

// (c) mode: bogus -> error with exact format
{
  const r = parseAgentFrontmatter("---\nmode: bogus\n---\n", "/x/b.md");
  check("mode: bogus -> error",
    !r.ok && /invalid mode "bogus" \(expected primary\|subagent\|all\)/.test(r.error),
    r.ok ? "expected error" : r.error);
}

// (d) JSON subagent with description; without -> error
{
  const ok = parseAgentJson("review", { mode: "subagent", description: "x" }, "/x/s.json");
  check("JSON subagent w/ description", ok.ok && ok.def.mode === "subagent");
  const bad = parseAgentJson("review", { mode: "subagent" }, "/x/s.json");
  check("JSON subagent w/o description -> error", !bad.ok && /requires "description"/.test(bad.error));
}

// (e) unknown permission key
{
  const r = parseAgentFrontmatter("---\nmode: all\npermission:\n  editz: allow\n---\n", "/x/e.md");
  check("unknown permission key -> error", !r.ok && /unknown permission key "editz"/.test(r.error));
}

// (f) bash pattern map: "git push" -> ask, others -> allow
{
  const r = parseAgentFrontmatter(
    `---\nmode: all\npermission:\n  bash:\n    "git push": ask\n    "*": allow\n---\n`,
    "/x/b.md",
  );
  check("bash pattern map parses", r.ok);
  if (r.ok) {
    check("checkPermission(git push) === ask", checkPermission(r.def.permission, "bash", "git push") === "ask");
    check("checkPermission(ls) === allow", checkPermission(r.def.permission, "bash", "ls") === "allow");
  }
}

// (g) prompt: "{file:./p.txt}" resolves
{
  const r = parseAgentFrontmatter(
    `---\nmode: all\nprompt: "{file:./p.txt}"\n---\n`,
    fixtureDir + "/agent.md",
  );
  check("prompt {file:...} resolves",
    r.ok && typeof r.def.prompt === "string" && r.def.prompt.includes("hello from file"),
    r.ok ? `got: ${r.def.prompt}` : r.error);
}

// (h) maxSteps -> steps
{
  const r = parseAgentFrontmatter("---\nmode: all\nmaxSteps: 3\n---\n", "/x/m.md");
  check("maxSteps alias -> steps", r.ok && r.def.steps === 3);
}

// (i) enabled: false -> disable: true
{
  const r = parseAgentFrontmatter("---\nmode: all\nenabled: false\n---\n", "/x/d.md");
  check("enabled: false alias -> disable: true", r.ok && r.def.disable === true);
}

// (j) tools both shapes
{
  const csv = parseAgentFrontmatter("---\nmode: all\ntools: read, bash\n---\n", "/x/t.md");
  check("tools csv parses", csv.ok && csv.def.tools?.kind === "csv"
    && csv.def.tools.allowed.has("read") && csv.def.tools.allowed.has("bash"));
  const obj = parseAgentJson("a", { mode: "all", tools: { write: false, bash: true } }, "/x/t.json");
  check("tools object parses", obj.ok && obj.def.tools?.kind === "object"
    && obj.def.tools.allowed.has("bash") && obj.def.tools.deniedGlobs.includes("write"));
}

// (k) PI-specific field passthrough
{
  const src = `---
mode: all
prompt_mode: replace
display_name: Plan
inherit_context: true
memoryScope: session
thinkingLevel: high
isolation: worktree
run_in_background: true
extensions: true
skills: true
---
body
`;
  const r = parseAgentFrontmatter(src, "/x/pi.md");
  check("PI fields passthrough",
    r.ok
    && r.def.prompt_mode === "replace"
    && r.def.display_name === "Plan"
    && r.def.inherit_context === true
    && r.def.memoryScope === "session"
    && r.def.thinkingLevel === "high"
    && r.def.isolation === "worktree"
    && r.def.run_in_background === true
    && r.def.extensions === true
    && r.def.skills === true);
}

if (failed > 0) { console.error(`HARNESS FAILED (${failed} cases)`); process.exit(1); }
console.log("HARNESS OK");
TS

if ! FIXTURE_DIR="$PFIXTURE" npx --yes tsx --tsconfig "$REPO/tsconfig.json" "$HARNESS"; then
  fail "tsx harness failed"
fi

# 5. check-build.sh returns 0
say "5. check-build.sh"
bash scripts/check-build.sh || fail "check-build.sh failed"

if [ "$FAIL" -ne 0 ]; then echo "PHASE 1 VERIFY FAILED"; exit 1; fi
echo "PHASE 1 VERIFY OK"
