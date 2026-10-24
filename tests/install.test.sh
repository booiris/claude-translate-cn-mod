#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-translate-test.XXXXXX")"
trap 'rm -rf -- "$fixture_dir"' EXIT
mkdir -p "$fixture_dir/bin"
cat > "$fixture_dir/bin/claude" <<'MOCK'
#!/usr/bin/env bash
set -eu
[[ "$1" == plugin && "$2" == validate ]]
[[ -f "$3/.claude-plugin/plugin.json" && -f "$3/hooks/register.js" ]]
exit "${VALIDATE_EXIT:-0}"
MOCK
chmod +x "$fixture_dir/bin/claude"
export PATH="$fixture_dir/bin:$PATH"
export CLAUDE_CONFIG_DIR="$fixture_dir/config with spaces"
target="$CLAUDE_CONFIG_DIR/skills/codex-translate"
bash "$project_dir/install.sh" --help >/dev/null
[[ ! -e "$CLAUDE_CONFIG_DIR" ]]
bash "$project_dir/install.sh" >/dev/null
cmp "$project_dir/hooks/register.js" "$target/hooks/register.js"
[[ -f "$target/hooks/model_catalog.py" && ! -d "$target/tests" && ! -d "$target/.git" ]]
echo 'user settings' > "$CLAUDE_CONFIG_DIR/settings.json"
echo 'old runtime' > "$target/hooks/register.js"
if VALIDATE_EXIT=1 bash "$project_dir/install.sh" >/dev/null 2>&1; then
  echo 'Failed validation must stop installation' >&2; exit 1
fi
[[ "$(cat "$target/hooks/register.js")" == 'old runtime' ]]
bash "$project_dir/install.sh" >/dev/null
cmp "$project_dir/hooks/register.js" "$target/hooks/register.js"
[[ "$(cat "$CLAUDE_CONFIG_DIR/settings.json")" == 'user settings' ]]
rm "$target/hooks/register.js"
ln -s "$fixture_dir/elsewhere" "$target/hooks/register.js"
if bash "$project_dir/install.sh" >/dev/null 2>&1; then
  echo 'Symlink destination must be rejected' >&2; exit 1
fi
[[ ! -e "$fixture_dir/elsewhere" ]]
echo 'Installer checks passed: first install, update, spaces, validation failure, settings preservation, symlink guard.'
