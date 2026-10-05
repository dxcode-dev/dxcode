# dx Orb host name in the prompt. dx-orb-init writes /etc/dx-orb-hostname
# only where the container runtime refused to set the short host name, so
# login shells show that name for \h instead of the runtime's long one.
if [ -n "${BASH_VERSION:-}" ] && [ -r /etc/dx-orb-hostname ]; then
  __dx_orb_host=$(cat /etc/dx-orb-hostname)
  __dx_orb_prompt() { PS1=${PS1//\\h/$__dx_orb_host}; }
  PROMPT_COMMAND="__dx_orb_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
