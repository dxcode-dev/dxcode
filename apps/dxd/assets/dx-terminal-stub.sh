# dx login hook. Static and root-owned: dxd releases never change it. dxd
# writes and versions the real hook in the user's own state directory; only
# that user's login shells read it, and a missing hook is skipped.
__dx_profile=/home/user/.local/state/dx-terminal/profile
if [ -f "$__dx_profile" ] && [ ! -L "$__dx_profile" ] && [ -O "$__dx_profile" ]; then
  . "$__dx_profile" || :
fi
unset __dx_profile
