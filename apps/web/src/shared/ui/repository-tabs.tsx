import { FolderGit2, GitBranch } from "lucide-react";
import type * as React from "react";
import { cn } from "../utils.js";
import { Tab, Tabs, TabsList, TabsPanel } from "./tabs.js";
import "./repository-tabs.css";

/** One checkout in a Thread's workspace. */
export interface RepositoryTab {
  readonly id: string;
  /** The Project's name for the main checkout, else its folder's name. */
  readonly name: string;
  /**
   * The Thread's own checkout, a repository of its own, or a linked
   * worktree; a worktree shows a branch icon.
   */
  readonly kind?: "primary" | "repository" | "worktree";
  /** Its branch; null when detached. Shown in the tab's tooltip. */
  readonly branch?: string | null;
  /** A number after the name, such as its changed files; 0 hides it. */
  readonly count?: number;
}

/**
 * One tab per checkout in a Thread's workspace: the Project's repository,
 * then each repository and worktree under ~/workspace/repos. Only the
 * chosen tab's content renders, so a tab's files load when it is opened.
 * With one checkout there is no strip, just the content. The strip scrolls
 * sideways when the tabs do not fit; long names are cut short.
 */
export function RepositoryTabs({
  tabs,
  value,
  onValueChange,
  label,
  className,
  children,
}: {
  readonly tabs: ReadonlyArray<RepositoryTab>;
  /** The chosen tab's id. */
  readonly value: string;
  readonly onValueChange: (id: string) => void;
  /** Names the strip for assistive technology, such as "Repositories". */
  readonly label: string;
  readonly className?: string;
  /** The chosen tab's content. */
  readonly children: React.ReactNode;
}) {
  if (tabs.length <= 1) return children;
  return (
    <Tabs
      className={cn("dx-repository-tabs", className)}
      value={value}
      onValueChange={(next) => onValueChange(String(next))}
    >
      <TabsList aria-label={label} className="dx-repository-tabs-list">
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            value={tab.id}
            className="dx-repository-tab"
            title={
              tab.branch === undefined
                ? tab.name
                : `${tab.name} · ${tab.branch ?? "detached"}`
            }
          >
            {tab.kind === "worktree" ? (
              <GitBranch aria-hidden="true" />
            ) : (
              <FolderGit2 aria-hidden="true" />
            )}
            <span className="dx-repository-tab-name">{tab.name}</span>
            {tab.count === undefined || tab.count === 0 ? null : (
              <span className="dx-repository-tab-count">
                {tab.count}
                <span className="sr-only"> changed</span>
              </span>
            )}
          </Tab>
        ))}
      </TabsList>
      <TabsPanel value={value} className="dx-repository-tabs-panel">
        {children}
      </TabsPanel>
    </Tabs>
  );
}
