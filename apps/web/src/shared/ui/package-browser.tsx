import { ArrowLeft, Search } from "lucide-react";
import * as React from "react";
import { cn } from "../utils.js";
import { Button } from "./button.js";
import { Card } from "./card.js";
import { FileTree } from "./file-tree.js";
import { Input } from "./input.js";
import "./package-browser.css";

/** One package in the list: a skill, a plugin, or anything made of files. */
export interface PackageBrowserItem {
  readonly id: string;
  readonly name: string;
  /** A small mark before the name, such as the plugin's icon. */
  readonly icon?: React.ReactNode;
  /** A muted word after the name, only when it is not working as shown. */
  readonly hint?: string;
}

/** The chosen package's files, drawn as a tree under its name. */
export interface PackageBrowserFiles {
  /** Names the tree for assistive tech, such as "pdf files". */
  readonly label: string;
  readonly paths: ReadonlyArray<string>;
  readonly selectedPath: string;
  readonly onSelect: (path: string) => void;
  /** Changes when the files change, so the tree reads them again. */
  readonly version: string;
}

/**
 * Packages as a file browser, the layout of the Skills and Plugins pages:
 * the packages by name on the left, the chosen one's files below its name,
 * and on the right its header, the open file (`children`), and, when given,
 * details beside the file (`aside`). On a phone the list and the package
 * are one screen each, and the package's screen shows its files above the
 * open file.
 */
export function PackageBrowser({
  noun,
  items,
  selectedId,
  onSelect,
  files,
  filesNote,
  header,
  aside,
  empty,
  className,
  children,
}: {
  /** What the packages are, plural and lowercase: "skills", "plugins". */
  readonly noun: string;
  readonly items: ReadonlyArray<PackageBrowserItem>;
  /** The chosen package; the first one when it is not in the list. */
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
  /** The chosen package's files; undefined while they load. */
  readonly files: PackageBrowserFiles | undefined;
  /** Shown in place of the tree while `files` is undefined. */
  readonly filesNote?: React.ReactNode;
  /** The chosen package's name, actions, and description. */
  readonly header: React.ReactNode;
  /** Details beside the open file. */
  readonly aside?: React.ReactNode;
  /** What the card shows when there are no packages. */
  readonly empty: React.ReactNode;
  readonly className?: string;
  /** The open file. */
  readonly children: React.ReactNode;
}) {
  const [filter, setFilter] = React.useState("");
  /** On a phone, whether the chosen package's screen is showing. */
  const [opened, setOpened] = React.useState(false);
  if (items.length === 0)
    return (
      <Card className={cn("package-browser-empty", className)} padding="md">
        {empty}
      </Card>
    );
  const query = filter.trim().toLowerCase();
  const shown = items.filter(({ name }) => name.toLowerCase().includes(query));
  const chosen = items.find(({ id }) => id === selectedId) ?? items[0];
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);
  const tree = (where: string) =>
    files === undefined ? (
      filesNote === undefined ? null : (
        <div className={cn("package-browser-files-note", where)}>
          {filesNote}
        </div>
      )
    ) : (
      <FileTree
        key={files.version}
        className={where}
        label={files.label}
        paths={files.paths}
        selectedPath={files.selectedPath}
        onSelect={files.onSelect}
      />
    );
  return (
    <Card
      className={cn("package-browser", className)}
      data-opened={opened || undefined}
      data-aside={aside === undefined ? undefined : true}
    >
      <div className="package-browser-list">
        <label className="package-browser-search">
          <Search aria-hidden="true" />
          <Input
            variant="bare"
            placeholder={`Filter ${noun}`}
            aria-label={`Filter ${noun}`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        {shown.map((item) => (
          <div key={item.id}>
            <button
              type="button"
              className="package-browser-item"
              aria-current={item.id === chosen?.id ? "true" : undefined}
              onClick={() => {
                onSelect(item.id);
                setOpened(true);
              }}
            >
              {item.icon}
              <span className="package-browser-item-name">{item.name}</span>
              {item.hint === undefined ? null : (
                <span className="package-browser-item-hint">{item.hint}</span>
              )}
            </button>
            {item.id === chosen?.id ? tree("package-browser-tree") : null}
          </div>
        ))}
        {shown.length === 0 ? (
          <p className="package-browser-none">
            Nothing matches “{filter.trim()}”.
          </p>
        ) : null}
      </div>
      <section className="package-browser-detail" aria-label={chosen?.name}>
        <Button
          className="package-browser-back"
          variant="ghost"
          size="sm"
          onClick={() => setOpened(false)}
        >
          <ArrowLeft aria-hidden="true" /> {title}
        </Button>
        {header}
        <div className="package-browser-body">
          {aside === undefined ? null : (
            <aside className="package-browser-aside">{aside}</aside>
          )}
          {tree("package-browser-phone-tree")}
          <div className="package-browser-file">{children}</div>
        </div>
      </section>
    </Card>
  );
}

/**
 * The chosen package's header: its mark and name, the actions on the
 * right (an On/Off switch, a menu), then its description and facts.
 */
export function PackageBrowserHeader({
  icon,
  title,
  actions,
  description,
  meta,
}: {
  readonly icon?: React.ReactNode;
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly description?: React.ReactNode;
  /** Facts under the description: where it came from, its version. */
  readonly meta?: React.ReactNode;
}) {
  return (
    <header className="package-browser-header">
      <h2>
        {icon}
        <span>{title}</span>
      </h2>
      {actions === undefined ? null : (
        <div className="package-browser-actions">{actions}</div>
      )}
      {description === undefined || description === "" ? null : (
        <p className="package-browser-description">{description}</p>
      )}
      {meta === undefined ? null : (
        <div className="package-browser-meta">{meta}</div>
      )}
    </header>
  );
}

/** A titled group of details in the aside, such as "What it can do". */
export function PackageBrowserSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="package-browser-section">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
