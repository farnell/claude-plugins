#!/usr/bin/env bash
# Force this machine's Claude Code install of adversarial-review to match the
# latest committed release — bypassing the version-gated `/plugin update` flow.
#
# WHY THIS EXISTS
#   Merging a release to `main` does NOT update any local copy. Claude Code
#   installs plugins into a version-gated cache and a SessionStart hook copies the
#   workflow engine from that cache into ~/.claude/workflows/. The catch:
#     • there is no `/plugin update` CLI — `/plugin update` just opens the browser;
#     • the version gate compares against the *marketplace clone on disk*, and
#       auto-update silently no-ops when that clone is stale or has diverged
#       (this repo squash-merges, which rewrites history and causes divergence).
#   So a merged fix can sit invisible on your machine indefinitely. This script
#   does deterministically what the installer is supposed to: refresh the clone,
#   (re)build the cache dir for the released version, repoint installed_plugins.json,
#   and sync the live engine. Idempotent; safe to run anytime.
#
# USAGE:  scripts/sync-local.sh        # after merging a release to main
set -euo pipefail

PLUGIN="adversarial-review"
MKT="farnell-plugins"
CLONE="$HOME/.claude/plugins/marketplaces/$MKT"
CACHE_BASE="$HOME/.claude/plugins/cache/$MKT/$PLUGIN"
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
LIVE="$HOME/.claude/workflows/$PLUGIN.js"
KEY="$PLUGIN@$MKT"

[ -d "$CLONE/.git" ] || {
  echo "✗ marketplace clone not found at $CLONE"
  echo "  Install the plugin first:  /plugin marketplace add farnell/claude-plugins"
  exit 1
}

echo "→ refreshing marketplace clone to origin/main (reset --hard tolerates squash-merge divergence)"
git -C "$CLONE" fetch --quiet origin main
git -C "$CLONE" reset --quiet --hard origin/main
SHA="$(git -C "$CLONE" rev-parse HEAD)"

SRC="$CLONE/$PLUGIN"
VER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/.claude-plugin/plugin.json")"
[ -n "$VER" ] || { echo "✗ could not read version from $SRC/.claude-plugin/plugin.json"; exit 1; }

DST="$CACHE_BASE/$VER"
echo "→ (re)building cache dir for v$VER"
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"
rm -rf "$DST/.git" "$DST/.DS_Store"

if [ -f "$INSTALLED" ]; then
  echo "→ repointing installed_plugins.json → v$VER (backup: installed_plugins.json.bak)"
  cp "$INSTALLED" "$INSTALLED.bak"
  python3 - "$INSTALLED" "$KEY" "$DST" "$VER" "$SHA" <<'PY'
import json, sys, datetime
ip, key, dst, ver, sha = sys.argv[1:6]
d = json.load(open(ip)); d.setdefault("plugins", {})
recs = d["plugins"].get(key) or [{}]
r = recs[0]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
r.setdefault("scope", "user")
r.setdefault("installedAt", now)
r.update(installPath=dst, version=ver, gitCommitSha=sha, lastUpdated=now)
d["plugins"][key] = [r]
json.dump(d, open(ip, "w"), indent=2)
PY
else
  echo "  (no installed_plugins.json — skipping the version record; the engine is still synced below)"
fi

echo "→ syncing live engine (what the SessionStart hook does on session start)"
mkdir -p "$HOME/.claude/workflows"
cp -f "$DST/workflows/$PLUGIN.js" "$LIVE"

echo "✓ synced $PLUGIN → v$VER  (${SHA:0:7})"
echo "  live engine: $LIVE"
