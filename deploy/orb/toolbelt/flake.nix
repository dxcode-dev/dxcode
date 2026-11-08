{
  # The dx toolbelt (deploy/orb/toolbelt/README.md): everything dx adds to
  # an Orb that it ships prebuilt, built once and installed unchanged on
  # every Orb provider. It is the /opt/dx tree below plus the Nix store
  # paths it refers to. Every program in it carries its own glibc and
  # libraries, so the toolbelt runs on any x86-64 Linux, whatever the
  # provider's base image: Debian, Ubuntu, Fedora, and others.
  #
  #   nix build ./deploy/orb/toolbelt#toolbelt
  #
  # pack.sh turns the result into the published tarball.
  description = "dx toolbelt: the Orb's prebuilt tooling, the same on every provider";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  # voxl, Tembo's X11 desktop streamer (MIT; the binary links x264, GPL):
  # its own Nix build and its patched Xvfb, whose XTEST pointer has scroll
  # axes for smooth scrolling.
  inputs.voxl = {
    url = "github:tembo/voxl/176f8befef4c4420e7bc6df5f143886a0f023b8a";
    flake = false;
  };

  outputs =
    {
      self,
      nixpkgs,
      voxl,
    }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      lib = pkgs.lib;

      # Its build type-checks voxl's own web client first, which nixpkgs'
      # newer TypeScript rejects in code dx does not use (the microphone);
      # dx's viewer is its own port (apps/web/src/features/desktop), and the
      # build still bundles the client with esbuild.
      voxlServer = (pkgs.callPackage "${voxl}/default.nix" { }).overrideAttrs {
        preBuild = "";
      };
      xvfb = pkgs.callPackage "${voxl}/xvfb.nix" { };

      # tmux's own static (musl) build, as the Terminal has used it.
      tmux = pkgs.stdenvNoCC.mkDerivation {
        pname = "tmux-static";
        version = "3.7c";
        srcs = [
          (pkgs.fetchurl {
            url = "https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-linux-x86_64.tar.gz";
            sha256 = "cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa";
          })
        ];
        licenses = pkgs.fetchurl {
          url = "https://github.com/tmux/tmux-builds/releases/download/v3.7c/LICENSES.tar.gz";
          sha256 = "094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1";
        };
        sourceRoot = ".";
        dontFixup = true;
        installPhase = ''
          mkdir -p $out/bin $out/share/licenses/tmux
          install -m 0755 tmux $out/bin/tmux
          tar -xzf $licenses -C $out/share/licenses/tmux --no-same-owner
        '';
      };

      # Every program the Desktop and its scripts run. The scripts call
      # them from here, never from the host's PATH.
      desktopEnv = pkgs.buildEnv {
        name = "dx-desktop-env";
        paths = with pkgs; [
          xvfb
          openbox
          xterm
          chromium
          dbus
          voxlServer
          xorg.fontmiscmisc
          xorg.fontcursormisc
          bash
          coreutils
          util-linux
          procps
          gawk
          gnugrep
          findutils
          curl
          glibcLocalesUtf8
        ];
        pathsToLink = [
          "/bin"
          "/lib/locale"
          "/lib/X11/fonts"
          "/share/dbus-1"
          "/share/themes"
        ];
      };

      # The Desktop's fonts, and the host's when it has any. fontconfig's own
      # rules (generic families such as sans-serif, hinting) come from the
      # toolbelt, so text renders the same on a host without fontconfig.
      fontsConf = pkgs.writeText "dx-fonts.conf" ''
        <?xml version="1.0"?>
        <!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
        <fontconfig>
          <include ignore_missing="yes">${pkgs.fontconfig.out}/etc/fonts/conf.d</include>
          <include ignore_missing="yes">${pkgs.makeFontsConf {
            fontDirectories = [
              pkgs.dejavu_fonts
              pkgs.liberation_ttf
            ];
          }}</include>
          <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
        </fontconfig>
      '';

      # What dx-warm reads when an Orb starts: the closure a Desktop start
      # runs, then the rest of Chromium's.
      startPrograms = with pkgs; [
        xvfb
        openbox
        xterm
        voxlServer
        dbus
        bash
        coreutils
        util-linux
        procps
        gawk
        gnugrep
        curl
      ];
      # Files, not whole packages: every executable in the programs' bin
      # directories and each shared library it loads, then Chromium's binary,
      # its libraries, and the resources it opens at start.
      warmLists = pkgs.runCommand "dx-warm-lists" { nativeBuildInputs = [ pkgs.glibc.bin ]; } ''
        files() {
          for f in "$@"; do
            [ -f "$f" ] || continue
            readlink -f "$f"
            if head -c 4 "$f" | grep -q ELF; then
              ldd "$f" 2>/dev/null | awk '/=> \// { print $3 } /^\t\// { print $1 }' | xargs -r readlink -f
            fi
          done
        }
        mkdir $out
        for package in ${lib.concatStringsSep " " (map toString startPrograms)}; do
          files "$package"/bin/* "$package"/bin/.*-wrapped
        done | sort -u >$out/start
        chromium=$(dirname "$(readlink -f ${pkgs.chromium}/bin/chromium)")
        unwrapped=$(grep -o '/nix/store/[^"]*-chromium-unwrapped-[^/]*' ${pkgs.chromium}/bin/chromium | head -n 1)
        {
          files "$unwrapped"/libexec/chromium/chromium "$unwrapped"/libexec/chromium/*.so
          ls -1 "$unwrapped"/libexec/chromium/*.pak "$unwrapped"/libexec/chromium/*.bin \
            "$unwrapped"/libexec/chromium/*.dat "$unwrapped"/libexec/chromium/locales/en-US.pak 2>/dev/null
        } | sort -u | comm -23 - $out/start >$out/chromium
      '';
      warmStart = "${warmLists}/start";
      warmChromium = "${warmLists}/chromium";

      desktop = ../desktop;

      toolbelt = pkgs.runCommand "dx-toolbelt" { } ''
        root=$out/opt/dx
        mkdir -p $root/bin $root/share/licenses $root/desktop
        ln -s ${tmux}/bin/tmux $root/bin/tmux
        cp -r ${tmux}/share/licenses/tmux $root/share/licenses/tmux
        install -m 0755 ${./dx-orb-check} $root/bin/dx-orb-check
        install -m 0755 ${./dx-warm} $root/bin/dx-warm
        install -m 0644 ${warmStart} $root/share/warm-start.paths
        install -m 0644 ${warmChromium} $root/share/warm-chromium.paths
        install -m 0644 ${./dx-orb-check.mjs} $root/share/dx-orb-check.mjs

        ln -s ${desktopEnv} $root/desktop/env
        install -m 0644 ${fontsConf} $root/desktop/fonts.conf
        for script in env.sh start stop session resume chromium; do
          install -m 0755 ${desktop}/$script $root/desktop/$script
        done
        chmod 0644 $root/desktop/env.sh
        install -m 0644 ${desktop}/dbus-session.conf $root/desktop/dbus-session.conf
        mkdir -p $root/desktop/openbox
        for file in rc.xml menu.xml; do
          install -m 0644 ${desktop}/openbox/$file $root/desktop/openbox/$file
        done
        patchShebangs --host $root/desktop $root/bin/dx-orb-check $root/bin/dx-warm
      '';
    in
    {
      packages.${system} = {
        inherit toolbelt desktopEnv voxlServer xvfb;
        default = toolbelt;
        # pack.sh's tar and zstd, pinned here so every host packs the same
        # bytes.
        packTools = pkgs.buildEnv {
          name = "dx-toolbelt-pack-tools";
          paths = [
            pkgs.gnutar
            pkgs.zstd
            pkgs.coreutils
          ];
        };
      };
    };
}
