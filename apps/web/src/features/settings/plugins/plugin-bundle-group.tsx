import type * as React from "react";

interface Item {
  readonly key: string;
  readonly name: string;
  readonly detail?: string;
  /** A short status after the detail, such as "Needs review". */
  readonly status?: string;
}

/** One kind of item in a bundle, as a titled list. */
export function PluginBundleGroup({
  icon,
  title,
  items,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly items: ReadonlyArray<Item>;
}) {
  if (items.length === 0) return null;
  return (
    <section className="plugin-bundle-group" aria-label={title}>
      <h3>
        {icon}
        <span>{title}</span>
        <span className="plugin-bundle-count">{items.length}</span>
      </h3>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <code>{item.name}</code>
            {item.detail === undefined || item.detail === "" ? null : (
              <span title={item.detail}>{item.detail}</span>
            )}
            {item.status === undefined ? null : (
              <em className="plugin-bundle-status-pill">{item.status}</em>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
