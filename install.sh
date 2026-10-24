#!/usr/bin/env bash
# Install/update the native plugin without changing Claude or Codex settings.
set -euo pipefail

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  echo '用法：bash install.sh'
  echo '安装到 ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/codex-translate'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo '不支持的参数；运行 bash install.sh --help 查看用法。' >&2
  exit 2
fi
command -v claude >/dev/null 2>&1 || { echo '未找到 claude，请先安装 Claude Code。' >&2; exit 1; }

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
config_dir="${CLAUDE_CONFIG_DIR:-${HOME:?HOME 未设置}/.claude}"
target_dir="$config_dir/skills/codex-translate"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-translate-install.XXXXXX")"
trap 'rm -rf -- "$stage_dir"' EXIT

# Copy only runtime files; exclude generated types, tests, credentials and caches.
mkdir -p "$stage_dir/.claude-plugin" "$stage_dir/hooks"
cp "$source_dir/.claude-plugin/plugin.json" "$stage_dir/.claude-plugin/"
for name in hooks.json register.js model_catalog.py; do
  cp "$source_dir/hooks/$name" "$stage_dir/hooks/"
done
cp "$source_dir/README.md" "$stage_dir/"
claude plugin validate "$stage_dir"

# Do not follow existing plugin symlinks when updating files.
for relative in '' '/.claude-plugin' '/hooks' '/.claude-plugin/plugin.json' \
  '/hooks/hooks.json' '/hooks/register.js' '/hooks/model_catalog.py' '/README.md'; do
  if [[ -L "$target_dir$relative" ]]; then
    echo "安装目标含符号链接，请先检查并移除该链接：$target_dir$relative" >&2
    exit 1
  fi
done
mkdir -p "$target_dir/.claude-plugin" "$target_dir/hooks"
cp "$stage_dir/.claude-plugin/plugin.json" "$target_dir/.claude-plugin/"
cp "$stage_dir/hooks/"* "$target_dir/hooks/"
cp "$stage_dir/README.md" "$target_dir/"

echo "已安装：$target_dir"
echo '重启 Claude，然后运行 /translate status。更新插件也运行同一脚本。'
if ! command -v codex >/dev/null 2>&1; then
  echo '提示：还需要安装 Codex CLI 并执行 codex login，翻译才能工作。'
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo '提示：模型列表查询需要 python3；普通翻译不受影响。'
fi
if [[ -n "${CLAUDE_CODE_PLUGIN_DIRS:-}" ]]; then
  echo '提示：如果 CLAUDE_CODE_PLUGIN_DIRS 也包含本插件，请移除对应路径，避免重复加载。'
fi
