import type { ProjectOrbFilesData } from "@dx/api";
import type { ProjectId, ProjectRepositoryOrbFile, UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { useNewThreadSurface } from "../../shared/new-thread-surface.js";
import { Button } from "../../shared/ui/button.js";
import { SettingsCard } from "../../shared/ui/settings.js";
import { projectOrbFilesQueryOptions } from "./project-orb-scripts-queries.js";

const FILES: ReadonlyArray<{
  readonly path: ProjectRepositoryOrbFile;
  readonly description: React.ReactNode;
}> = [
  {
    path: ".agents/setup",
    description: (
      <>
        Runs once from the repository root when dx prepares a fresh Orb, right
        after the Pre-setup Script. Install tools and dependencies here.
      </>
    ),
  },
  {
    path: ".agents/resume",
    description: (
      <>
        Runs each time the Orb starts or wakes. Keep it fast and safe to repeat:
        authenticate, reconnect, or restart local services.
      </>
    ),
  },
  {
    path: ".agents/desktop/resume",
    description: (
      <>
        Runs each time the Desktop starts. When the repository has it, it
        replaces the project's Desktop Resume Script.
      </>
    ),
  },
  {
    path: ".dx/services.yaml",
    description: (
      <>
        Declares the repository's dev servers, so opening a Portal starts the
        one it needs.
      </>
    ),
  },
];

type CheckedFiles = Extract<ProjectOrbFilesData, { state: "checked" }>;

const setupPrompt = (checked: CheckedFiles, missing: ReadonlyArray<string>) =>
  `Prepare ${checked.repository.fullName} for dx Orbs with the orb-setup skill. ` +
  `Its ${checked.repository.defaultBranch ?? "default"} branch has no ${missing.join(", ")}. ` +
  "Add the ones this repository needs, check that they run, and open a pull request.";

/**
 * The files the repository commits to prepare its own Orbs, as its default
 * branch has them. Read-only: they change in the repository, and a missing
 * one can be added by a Thread.
 */
export function ProjectOrbFilesCard({
  projectId,
  userId,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
}) {
  const files = useQuery(projectOrbFilesQueryOptions(userId, projectId));
  const { openNewThread } = useNewThreadSurface();
  const checked = files.data?.state === "checked" ? files.data : undefined;
  const found = (path: ProjectRepositoryOrbFile) =>
    checked?.files.find((file) => file.path === path);
  const missing = FILES.flatMap(({ path }) =>
    checked !== undefined && found(path)?.present !== true ? [path] : [],
  );
  return (
    <SettingsCard
      className="project-orb-files-card"
      title="Repository Files"
      description={
        checked === undefined ? (
          "Files the repository commits to prepare its own Orbs. They run after the Orb Scripts above."
        ) : (
          <>
            Files the repository commits to prepare its own Orbs, as{" "}
            <strong>{checked.repository.fullName}</strong> has them on{" "}
            {checked.repository.defaultBranch === undefined ? (
              "its default branch"
            ) : (
              <code>{checked.repository.defaultBranch}</code>
            )}
            . They run after the Orb Scripts above.
          </>
        )
      }
      variant="outline"
    >
      <ul className="project-orb-files">
        {FILES.map(({ path, description }) => {
          const file = found(path);
          return (
            <li key={path} className="project-orb-file">
              <div className="project-orb-file-body">
                <h4>
                  {file?.url === undefined ? (
                    <code>{path}</code>
                  ) : (
                    <a href={file.url} target="_blank" rel="noreferrer">
                      <code>{path}</code>
                    </a>
                  )}
                </h4>
                <p>{description}</p>
              </div>
              {file === undefined ? null : (
                <span
                  className="project-orb-file-status"
                  data-present={file.present}
                >
                  {file.present ? "Found" : "Missing"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {files.isPending ? (
        <p className="project-orb-files-note">Checking the default branch…</p>
      ) : files.isError ? (
        <p className="project-orb-files-note" role="alert">
          Repository files could not be checked.
        </p>
      ) : files.data.state === "not-connected" ? (
        <p className="project-orb-files-note">
          Connect this project to GitHub or Bitbucket, or use a public GitHub
          repository, to have dx check these files on the default branch.
        </p>
      ) : files.data.state === "unreadable" ? (
        <p className="project-orb-files-note" role="alert">
          dx could not read the repository just now. Try again later, or check
          its connection in General.
        </p>
      ) : missing.length === 0 || checked === undefined ? null : (
        <div className="project-orb-files-setup">
          <p className="project-orb-files-note">
            A Thread can add the missing files and open a pull request.
          </p>
          <Button
            size="xs"
            type="button"
            onClick={() =>
              openNewThread(projectId, setupPrompt(checked, missing))
            }
          >
            Set up with dx
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}
