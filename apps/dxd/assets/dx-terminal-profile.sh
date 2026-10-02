# dxd-profile-v4: written by dxd; login shells reach it through /etc/profile.d/dx-terminal.sh.
__dx_home='/home/user' __dx_user='user' __dx_state='/home/user/.local/state/dx-terminal'
export HOME="$__dx_home" USER="$__dx_user" LOGNAME="$__dx_user" SHELL=/bin/bash
export PATH="$__dx_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
export LANG=C.UTF-8
export GIT_CONFIG_GLOBAL="$__dx_state/gitconfig"
if [ -f "$__dx_home/.env" ] && [ ! -L "$__dx_home/.env" ] && [ "$(stat -c '%u:%a' "$__dx_home/.env" 2>/dev/null)" = "$(id -u):600" ]; then
  case $- in *a*) __dx_restore_allexport=0 ;; *) __dx_restore_allexport=1; set -a ;; esac
  . "$__dx_home/.env"
  if [ "$__dx_restore_allexport" = 1 ]; then set +a; fi
  unset __dx_restore_allexport
fi
umask 077
export HISTFILE="$__dx_state/history"
export HISTSIZE=1000 HISTFILESIZE=1000
unset __dx_home __dx_user __dx_state
# History belongs to interactive shells. A non-interactive login shell (an
# agent or provider command) must exit with its own status, so the flush can
# never fail it, even before the state directory exists.
case $- in
  *i*)
    shopt -s histappend
    __dx_history_flush() { builtin history -w "$HISTFILE" 2>/dev/null || :; }
    case ";${PROMPT_COMMAND-};" in
      *';__dx_history_flush;'*) ;;
      *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__dx_history_flush" ;;
    esac
    trap '__dx_history_flush' EXIT
    ;;
esac
