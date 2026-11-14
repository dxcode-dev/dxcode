import type { PluginIconSetData } from "@dx/api";
import "./plugin-icon.css";

/**
 * A plugin's icon, or one of its items', drawn the same
 * way on every surface at 16, 20, 32, or 64 px:
 *
 * - `item` first: `lucide:<name>` from dx's icon set (served by URL like
 *   every file, drawn in the text color), or an icon file hash.
 * - Then the plugin's icon set: `src` on light; on dark `dark`, else
 *   `monochrome` in the text color, else `src` on its `background` tile.
 *   Both themes render and CSS shows one, so a theme switch costs nothing.
 * - Then `legacySrc` (a `data:` URL from older servers).
 * - Else a rounded tile with the plugin's first letter, colored from its name.
 *
 * Files load from `/v1/plugins/icons/<hash>`, cached for a year.
 */

export type PluginIconSize = 16 | 20 | 32 | 64;

const HASH = /^[0-9a-f]{64}$/;

/** A stable hue from the plugin's name, for its letter tile. */
const hueOf = (name: string) => {
  let hash = 0;
  for (const character of name)
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
};

const letterOf = (name: string) =>
  (/[\p{L}\p{N}]/u.exec(name)?.[0] ?? "?").toLocaleUpperCase();

function LetterTile({ name }: { readonly name: string }) {
  return (
    <span
      className="plugin-icon-letter"
      style={{ "--plugin-icon-hue": hueOf(name) } as React.CSSProperties}
    >
      {letterOf(name)}
    </span>
  );
}

type Resolve = (hash: string) => string;

/** Where an icon file is served (`pluginIconPath` in @dx/api, inlined). */
const pluginIconUrl: Resolve = (hash) => `/v1/plugins/icons/${hash}`;

const lucidePath: Resolve = (name) => `/v1/plugins/icons/lucide/${name}`;

const served = pluginIconUrl;

function IconImage({
  hash,
  className,
  resolve = served,
}: {
  readonly hash: string;
  readonly className?: string;
  readonly resolve?: Resolve;
}) {
  return (
    <img
      className={className}
      src={resolve(hash)}
      alt=""
      decoding="async"
      loading="lazy"
      draggable={false}
    />
  );
}

/** A monochrome SVG drawn in the current text color. */
function Monochrome({
  hash,
  className,
  resolve,
}: {
  readonly hash: string;
  readonly className?: string;
  readonly resolve: Resolve;
}) {
  return (
    <span
      className={`plugin-icon-mono ${className ?? ""}`}
      style={
        {
          "--plugin-icon-mask": `url("${resolve(hash)}")`,
        } as React.CSSProperties
      }
    />
  );
}

function PluginSetIcon({
  name,
  icon,
  legacySrc,
  resolve,
}: {
  readonly name: string;
  readonly icon: PluginIconSetData | undefined;
  readonly legacySrc: string | undefined;
  readonly resolve: Resolve;
}) {
  const src = icon?.src;
  const mono = icon?.monochrome;
  if (src === undefined && mono === undefined) {
    if (legacySrc !== undefined)
      return <img src={legacySrc} alt="" draggable={false} />;
    return <LetterTile name={name} />;
  }
  const light =
    src !== undefined ? (
      <IconImage hash={src} className="plugin-icon-light" resolve={resolve} />
    ) : (
      <Monochrome
        hash={mono as string}
        className="plugin-icon-light"
        resolve={resolve}
      />
    );
  const dark =
    icon?.dark !== undefined ? (
      <IconImage
        hash={icon.dark}
        className="plugin-icon-dark"
        resolve={resolve}
      />
    ) : mono !== undefined ? (
      <Monochrome hash={mono} className="plugin-icon-dark" resolve={resolve} />
    ) : (
      <span
        className="plugin-icon-dark plugin-icon-tile"
        style={
          icon?.background === undefined
            ? undefined
            : ({ "--plugin-icon-tile": icon.background } as React.CSSProperties)
        }
      >
        <IconImage hash={src as string} resolve={resolve} />
      </span>
    );
  return (
    <>
      {light}
      {dark}
    </>
  );
}

export function PluginIcon({
  name,
  icon,
  item,
  size,
  legacySrc,
  className,
  label,
  files,
}: {
  /** The plugin's display name: the letter tile and its color come from it. */
  readonly name: string;
  readonly icon?: PluginIconSetData | undefined;
  /** The item's own icon: `lucide:<name>` or an icon file hash. */
  readonly item?: string | undefined;
  readonly size: PluginIconSize;
  /** A `data:` URL older servers send instead of `icon`. */
  readonly legacySrc?: string | undefined;
  readonly className?: string;
  /** Names the icon for assistive technology; decorative when absent. */
  readonly label?: string;
  /** Files not stored yet (an install review), as `data:` URLs by hash. */
  readonly files?: Readonly<Record<string, string>> | undefined;
}) {
  const resolve: Resolve = (hash) => files?.[hash] ?? pluginIconUrl(hash);
  const plugin = (
    <PluginSetIcon
      name={name}
      icon={icon}
      legacySrc={legacySrc}
      resolve={resolve}
    />
  );
  const body =
    item?.startsWith("lucide:") === true ? (
      // dx's copy of Lucide, served by URL and drawn in the text color.
      <Monochrome
        hash={item.slice("lucide:".length)}
        className="plugin-icon-lucide"
        resolve={lucidePath}
      />
    ) : item !== undefined && HASH.test(item) ? (
      <IconImage hash={item} resolve={resolve} />
    ) : (
      plugin
    );
  return (
    <span
      className={`plugin-icon ${className ?? ""}`}
      data-size={size}
      {...(label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": label })}
    >
      {body}
    </span>
  );
}
