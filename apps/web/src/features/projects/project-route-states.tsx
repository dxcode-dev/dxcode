import {
  type ErrorComponentProps,
  Link,
  type NotFoundRouteProps,
  useRouter,
} from "@tanstack/react-router";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";

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
        <div className="project-detail-state" role="alert">
          <strong>Project not found</strong>
          <span>This project is unavailable or no longer exists.</span>
          <Link to="/projects" search={{ owner: undefined }}>
            Back to Projects
          </Link>
        </div>
      ) : (
        <div className="project-detail-state" role="alert">
          <strong>Settings section not found</strong>
          <span>This URL does not match a project settings section.</span>
          <Link
            to="/projects/$projectId/settings/$section"
            params={{ projectId: section.projectId, section: "general" }}
          >
            Open General settings
          </Link>
        </div>
      )}
    </PageShell>
  );
}

/** A project route whose data failed to load for a reason other than 404. */
export function ProjectRouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <PageShell title={projectsTitle} contentClassName="project-detail-content">
      <div className="project-detail-state" role="alert">
        <strong>Project could not load</strong>
        <span>{error.message || "The project could not load."}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void router.invalidate()}
        >
          Retry
        </Button>
      </div>
    </PageShell>
  );
}
