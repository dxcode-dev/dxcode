import {
  type ErrorComponentProps,
  Link,
  type NotFoundRouteProps,
  useRouter,
} from "@tanstack/react-router";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";

const projectsTitle = (
  <div className="projects-title project-detail-title">
    <Link to="/projects" search={{ owner: undefined }}>
      Projects
    </Link>
  </div>
);

const unknownSettingsSection = (
  data: unknown,
): { readonly projectId: string } | undefined =>
  typeof data === "object" &&
  data !== null &&
  "code" in data &&
  data.code === "PROJECT_SETTINGS_SECTION_NOT_FOUND" &&
  "projectId" in data &&
  typeof data.projectId === "string"
    ? { projectId: data.projectId }
    : undefined;

/** A project route whose project or settings section does not exist. */
export function ProjectRouteNotFound({ data }: NotFoundRouteProps) {
  const section = unknownSettingsSection(data);
  return (
    <PageShell title={projectsTitle} contentClassName="project-detail-content">
      {section === undefined ? (
        <EmptyState
          tone="error"
          title="Project not found"
          description="This project is unavailable or no longer exists."
          action={
            <Link to="/projects" search={{ owner: undefined }}>
              Back to Projects
            </Link>
          }
        />
      ) : (
        <EmptyState
          tone="error"
          title="Settings section not found"
          description="This URL does not match a project settings section."
          action={
            <Link
              to="/projects/$projectId/settings/$section"
              params={{ projectId: section.projectId, section: "general" }}
            >
              Open General settings
            </Link>
          }
        />
      )}
    </PageShell>
  );
}

/** A project route whose data failed to load for a reason other than 404. */
export function ProjectRouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <PageShell title={projectsTitle} contentClassName="project-detail-content">
      <EmptyState
        tone="error"
        title="Project could not load"
        description={error.message || "The project could not load."}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void router.invalidate()}
          >
            Retry
          </Button>
        }
      />
    </PageShell>
  );
}
