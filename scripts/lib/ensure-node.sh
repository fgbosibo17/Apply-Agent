# shellcheck shell=bash
# Source this before calling node. Safe under `set -u`; never exits the caller.
#
# Cron starts jobs with PATH=/usr/bin:/bin, so a Node installed with nvm, volta,
# fnm or under /usr/local/bin is invisible to it and a scheduled night dies on its
# first `node` call. This finds the newest such Node and puts it on PATH. It does
# not source nvm.sh (which is unsafe under `set -u`); it reads nvm's install
# directory directly.
#
# A crontab PATH= line is still the explicit fix — see README, Part 2, step 4.
# ENSURE_NODE_DIRS overrides the fixed folders searched first (tests set it empty).
if ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC2086
  for _ensure_node_dir in ${ENSURE_NODE_DIRS-/usr/local/bin /opt/homebrew/bin $HOME/.volta/bin $HOME/.local/bin $HOME/.fnm/aliases/default/bin}; do
    if [ -x "$_ensure_node_dir/node" ]; then PATH="$_ensure_node_dir:$PATH"; break; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  _ensure_node_dir="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$_ensure_node_dir" ] && [ -x "$_ensure_node_dir/node" ]; then PATH="$_ensure_node_dir:$PATH"; fi
fi
unset _ensure_node_dir
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH ($PATH). Under cron, add a PATH= line to the crontab with the folder from \`dirname \$(which node)\` — see README, Part 2, step 4." >&2
fi
