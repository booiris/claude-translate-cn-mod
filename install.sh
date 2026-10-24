#!/usr/bin/env bash
# Install/update the native plugin without changing Claude or Codex settings.
set -euo pipefail

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  echo '用法：bash install.sh（本地）或通过 curl 管道执行（远程）'
  echo '安装到 ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/codex-translate'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo '不支持的参数；运行 bash install.sh --help 查看用法。' >&2
  exit 2
fi
command -v claude >/dev/null 2>&1 || { echo '未找到 claude，请先安装 Claude Code。' >&2; exit 1; }

config_dir="${CLAUDE_CONFIG_DIR:-${HOME:?HOME 未设置}/.claude}"
target_dir="$config_dir/skills/codex-translate"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/codex-translate-install.XXXXXX")"
trap 'rm -rf -- "$stage_dir"' EXIT

source_dir=''
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [[ -z "$source_dir" || ! -f "$source_dir/.claude-plugin/plugin.json" ]]; then
  command -v curl >/dev/null 2>&1 || { echo '远程安装需要 curl。' >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo '远程安装需要 tar。' >&2; exit 1; }
  github_token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [[ -z "$github_token" ]] && command -v gh >/dev/null 2>&1; then
    github_token="$(gh auth token --hostname github.com 2>/dev/null || true)"
  fi
  if [[ -z "$github_token" ]]; then
    echo '这是私有仓库：请先 gh auth login，或设置有仓库读取权限的 GH_TOKEN。' >&2
    exit 1
  fi
  # Keep the archive request's token out of argv and remove it with the temp dir.
  printf 'Authorization: Bearer %s\n' "$github_token" > "$stage_dir/auth.headers"
  chmod 600 "$stage_dir/auth.headers"
  unset github_token
  curl --fail --silent --show-error --location --retry 2 \
    --header "@$stage_dir/auth.headers" \
    --output "$stage_dir/source.tar.gz" \
    'https://api.github.com/repos/booiris/claude-translate-mode/tarball/main'
  mkdir "$stage_dir/source"
  tar -xzf "$stage_dir/source.tar.gz" -C "$stage_dir/source" --strip-components=1
  source_dir="$stage_dir/source"
fi

# Copy only runtime files; exclude generated types, tests, credentials and caches.
runtime_dir="$stage_dir/runtime"
mkdir -p "$runtime_dir/.claude-plugin" "$runtime_dir/hooks"
cp "$source_dir/.claude-plugin/plugin.json" "$runtime_dir/.claude-plugin/"
for name in hooks.json register.js model_catalog.py; do
  cp "$source_dir/hooks/$name" "$runtime_dir/hooks/"
done
cp "$source_dir/README.md" "$runtime_dir/"
claude plugin validate "$runtime_dir" </dev/null

# Do not follow existing plugin symlinks when updating files.
for relative in '' '/.claude-plugin' '/hooks' '/.claude-plugin/plugin.json' \
  '/hooks/hooks.json' '/hooks/register.js' '/hooks/model_catalog.py' '/README.md'; do
  if [[ -L "$target_dir$relative" ]]; then
    echo "安装目标含符号链接，请先检查并移除该链接：$target_dir$relative" >&2
    exit 1
  fi
done
mkdir -p "$target_dir/.claude-plugin" "$target_dir/hooks"
cp "$runtime_dir/.claude-plugin/plugin.json" "$target_dir/.claude-plugin/"
cp "$runtime_dir/hooks/"* "$target_dir/hooks/"
cp "$runtime_dir/README.md" "$target_dir/"

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
