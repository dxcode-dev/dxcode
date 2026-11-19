import { ProjectSettingsPage } from "./features/projects/project-settings-page.js";
import { ProjectEnvironmentVariablesSettings } from "./features/settings/environment-variables/environment-variables-settings.js";

export const ProjectSettingsRoute = () => (
  <ProjectSettingsPage
    renderEnvironmentSettings={(projectId, onDirtyChange, readOnly) => (
      <ProjectEnvironmentVariablesSettings
        projectId={projectId}
        readOnly={readOnly}
        onDirtyChange={onDirtyChange}
      />
    )}
  />
);
