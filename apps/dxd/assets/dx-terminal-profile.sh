# dxd-profile-v2
export HOME=/home/user USER=user LOGNAME=user SHELL=/bin/bash
export PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
export LANG=C.UTF-8
export GIT_CONFIG_GLOBAL=/home/user/.local/state/dx-terminal/gitconfig
__dx_environment=/home/user/.env
if [ -f "$__dx_environment" ] && [ ! -L "$__dx_environment" ] && [ "$(stat -c '%u:%a' "$__dx_environment" 2>/dev/null)" = "$(id -u):600" ]; then
  case $- in *a*) __dx_restore_allexport=0 ;; *) __dx_restore_allexport=1; set -a ;; esac
  . "$__dx_environment"
  if [ "$__dx_restore_allexport" = 1 ]; then set +a; fi
  unset __dx_restore_allexport
fi
unset __dx_environment
umask 077
export HISTFILE=/home/user/.local/state/dx-terminal/history
export HISTSIZE=1000 HISTFILESIZE=1000
shopt -s histappend
__dx_history_flush() { builtin history -w "$HISTFILE"; }
case ";${PROMPT_COMMAND-};" in
  *';__dx_history_flush;'*) ;;
  *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__dx_history_flush" ;;
esac
trap '__dx_history_flush' EXIT
