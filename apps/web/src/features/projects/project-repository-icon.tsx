export function ProjectRepositoryIcon({
  provider,
}: {
  readonly provider: "git" | "github" | "bitbucket" | "gitlab" | "forgejo";
}) {
  return (
    <span className="project-provider-icon" aria-hidden="true">
      {provider === "git" ? (
        <svg viewBox="0 0 24 24" fill="none">
          <title>Git</title>
          <circle cx="7" cy="6" r="2" fill="currentColor" />
          <circle cx="17" cy="6" r="2" fill="currentColor" />
          <circle cx="12" cy="18" r="2" fill="currentColor" />
          <path
            d="M7 8v2a4 4 0 0 0 4 4h1m5-6v2a4 4 0 0 1-4 4h-1v2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      ) : provider === "github" ? (
        <svg viewBox="0 0 24 24">
          <title>GitHub</title>
          <path
            fill="currentColor"
            d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"
          />
        </svg>
      ) : provider === "bitbucket" ? (
        <svg viewBox="0 0 24 24">
          <title>Bitbucket</title>
          <path fill="currentColor" d="M3 3h18l-3 18H6L3 3Zm6 6 1 6h4l1-6H9Z" />
        </svg>
      ) : provider === "gitlab" ? (
        <svg viewBox="0 0 24 24">
          <title>GitLab</title>
          <path
            fill="currentColor"
            d="m23.96 13.59-1.35-4.14-2.66-8.2a.46.46 0 0 0-.87 0l-2.66 8.2H7.58l-2.66-8.2a.46.46 0 0 0-.87 0l-2.66 8.2-1.35 4.14a.91.91 0 0 0 .33 1.01L12 23.04l11.63-8.44a.91.91 0 0 0 .33-1.01Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none">
          <title>Forgejo</title>
          <circle cx="6" cy="5" r="2.25" fill="currentColor" />
          <circle cx="18" cy="5" r="2.25" fill="currentColor" />
          <circle cx="12" cy="19" r="2.25" fill="currentColor" />
          <path
            d="M6 7.25v2.25a4 4 0 0 0 4 4h2m6-6.25v2.25a4 4 0 0 1-4 4h-2V17"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}
