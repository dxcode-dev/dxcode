# dx Orb open-file limit. Cloudflare Containers start every process at an
# open-file hard limit of 1024: dx-orb-init, and each command Core runs in
# the Orb, agent runs included. Chromium keeps a few hundred descriptors
# per page load until its next garbage collection, so a tab that reloads a
# large app hits the limit within a few loads, and its renderer crashes or
# stops loading and leaves the page blank (#1681). Raise this shell's hard
# limit to the usual Linux default; what it starts inherits it, and
# programs that need more than the 1024 soft limit, Chromium and Node among
# them, raise their own. dx-orb-init sources this file before it starts
# dxd, so the Terminal, services, and the Desktop get the same.
__dx_open_files=524288
__dx_open_files_hard=$(ulimit -Hn)
if [ "$__dx_open_files_hard" != unlimited ] &&
  [ "$__dx_open_files_hard" -lt "$__dx_open_files" ]; then
  # The runtime gives the image user CAP_SYS_RESOURCE, so the shell raises
  # its own limit; a host that withholds it goes through passwordless sudo,
  # which never prompts (-n) and gets two seconds, so a login never hangs.
  ulimit -H -n "$__dx_open_files" 2>/dev/null ||
    timeout 2 sudo -n prlimit --pid $$ \
      --nofile="$(ulimit -Sn):$__dx_open_files" >/dev/null 2>&1 </dev/null || :
fi
unset __dx_open_files __dx_open_files_hard
