// Whether a failed D1 write broke a UNIQUE constraint that covers `column`,
// written as `table.column`, such as "projects.name".
//
// D1 reports the violation only in an error message that lists the
// constraint's columns, such as
// "D1_ERROR: UNIQUE constraint failed: projects.owner_user_id, projects.name: SQLITE_CONSTRAINT".
// A primary key collision lists its own columns ("projects.id"), so it never
// matches a name. `@effect/sql-d1` wraps the error twice (SqlError, then an
// UnknownError reason) under its own message, so the original message sits a
// few `cause` links down; raw `D1Database` calls throw it directly. Both
// shapes match.
const UNIQUE_FAILURE = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/;

export const violatesUniqueConstraint = (
  cause: unknown,
  column: string,
): boolean => {
  const seen = new Set<unknown>();
  let current = cause;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const { message } = current as { message?: unknown };
    const columns =
      typeof message === "string"
        ? UNIQUE_FAILURE.exec(message)?.[1]
        : undefined;
    if (columns?.split(", ").includes(column)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};
