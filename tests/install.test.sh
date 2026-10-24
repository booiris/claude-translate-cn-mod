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
cmp "$project_dir/LICENSE" "$target/LICENSE"
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
rm "$target/hooks/register.js"

# Simulate a public archive download, with no network or credentials.
mkdir "$fixture_dir/archive-root"
cp -R "$project_dir/.claude-plugin" "$project_dir/hooks" "$project_dir/README.md" "$project_dir/LICENSE" "$fixture_dir/archive-root/"
tar -czf "$fixture_dir/source.tar.gz" -C "$fixture_dir" archive-root
export INSTALL_TEST_ARCHIVE="$fixture_dir/source.tar.gz"
cat > "$fixture_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -eu
output=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --header) echo 'Public downloads must not send credentials' >&2; exit 1 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ "$url" == 'https://codeload.github.com/booiris/claude-translate-cn-mod/tar.gz/refs/heads/main' ]]
[[ "${DOWNLOAD_FAIL:-0}" == 0 ]] || exit 22
cp "$INSTALL_TEST_ARCHIVE" "$output"
MOCK
chmod +x "$fixture_dir/bin/curl"
cat > "$fixture_dir/bin/gh" <<'MOCK'
#!/usr/bin/env bash
echo 'Public installation must not request GitHub authentication' >&2
exit 1
MOCK
chmod +x "$fixture_dir/bin/gh"
unset GH_TOKEN GITHUB_TOKEN
cat "$project_dir/install.sh" | bash >/dev/null
cmp "$project_dir/hooks/register.js" "$target/hooks/register.js"
cmp "$project_dir/LICENSE" "$target/LICENSE"
[[ ! -e "$target/auth.headers" && ! -e "$target/source.tar.gz" ]]
echo 'previous version' > "$target/hooks/register.js"
if cat "$project_dir/install.sh" | DOWNLOAD_FAIL=1 bash >/dev/null 2>&1; then
  echo 'Download failure must stop installation' >&2; exit 1
fi
[[ "$(cat "$target/hooks/register.js")" == 'previous version' ]]
echo 'Installer checks passed: local install/update, piped remote install, failed download/validation, settings and symlink guards.'
