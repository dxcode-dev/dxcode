# Sourced by every Desktop script. The Desktop's programs come from the dx
# toolbelt (deploy/orb/toolbelt), never from the host: `env/bin` holds Xvfb,
# openbox, xterm, Chromium, the voxl streamer, dbus, and the tools these
# scripts use, each with its own glibc and libraries. The scripts put it
# first on PATH for themselves, and start what the person and the agent use
# on the desktop (openbox, the terminal, Chromium, resume scripts) with the
# host's PATH, kept in DX_HOST_PATH.
desktop=/opt/dx/desktop
bin="$desktop/env/bin"
export DX_HOST_PATH="${DX_HOST_PATH:-$PATH}"
export PATH="$bin:$DX_HOST_PATH"
# The Desktop's fonts and then the host's (fonts.conf), and UTF-8 locales
# for the toolbelt's glibc. Other glibc builds ignore LOCALE_ARCHIVE.
export FONTCONFIG_FILE="$desktop/fonts.conf"
export LOCALE_ARCHIVE="$desktop/env/lib/locale/locale-archive"
