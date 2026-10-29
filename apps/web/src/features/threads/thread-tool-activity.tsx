import { Link } from "@tanstack/react-router";
import type { ToolPart } from "./transcript-activity-projection.js";
import {
  record,
  stringField,
  threadsFor,
} from "./transcript-activity-summary.js";

const threadLink = (threadId: string, label: string) => (
  <Link
    className="transcript-thread-link"
    to="/threads/$threadId"
    params={{ threadId }}
    // Opening the Thread must not also toggle the row's details.
    onClick={(event) => event.stopPropagation()}
  >
    {label}
  </Link>
);

/** The last segment of a path input: `src/a.ts` shows as `a.ts`. */
const fileName = (input: unknown, field: string) =>
  stringField(input, field)?.split("/").filter(Boolean).at(-1) ?? "file";

/** What a Thread tool did, as one line: "Sent thread message". */
export function ThreadToolLabel({ part }: { readonly part: ToolPart }) {
  const threads = threadsFor(part);
  const only = threads.length === 1 ? threads[0] : undefined;
  switch (part.toolName) {
    case "create_thread": {
      const title = stringField(part.input, "title") ?? "thread";
      const created = stringField(part.output, "threadId");
      return (
        <>
          Started{" "}
          {created === undefined ? (
            <strong>{title}</strong>
          ) : (
            threadLink(created, title)
          )}
        </>
      );
    }
    case "send_thread_message":
      return (
        <>
          Sent{" "}
          {only === undefined
            ? "thread message"
            : threadLink(only, "thread message")}
        </>
      );
    case "wait_for_threads":
      return (
        <>
          Waited for{" "}
          {only === undefined
            ? `${threads.length} threads`
            : threadLink(only, "thread")}
        </>
      );
    case "get_thread_status":
      return (
        <>
          Checked on{" "}
          {only === undefined ? "thread" : threadLink(only, "thread")}
        </>
      );
    case "update_thread":
      return (
        <>
          Updated{" "}
          {only === undefined ? "this thread" : threadLink(only, "thread")}
        </>
      );
    case "find_thread":
      return (
        <>
          Searched threads for{" "}
          <strong>{stringField(part.input, "query") ?? "threads"}</strong>
        </>
      );
    case "read_thread":
      return (
        <>Read {only === undefined ? "thread" : threadLink(only, "thread")}</>
      );
    case "download_thread_file":
      return (
        <>
          Downloaded <strong>{fileName(part.input, "path")}</strong> from{" "}
          {only === undefined ? "thread" : threadLink(only, "thread")}
        </>
      );
    case "upload_thread_file":
      return (
        <>
          Uploaded <strong>{fileName(part.input, "path")}</strong> to{" "}
          {only === undefined ? "thread" : threadLink(only, "thread")}
        </>
      );
    case "download_thread_changes":
      return (
        <>
          Downloaded changes from{" "}
          {only === undefined ? "thread" : threadLink(only, "thread")}
        </>
      );
    case "thread_file_url": {
      const paths = record(part.input)?.paths;
      const count = Array.isArray(paths) ? paths.length : 1;
      return <>Shared {count === 1 ? "a file link" : `${count} file links`}</>;
    }
    case "list_orbs":
      return <>Listed Orbs</>;
    case "list_agent_modes":
      return <>Listed agent modes</>;
    default:
      return <>{part.toolName}</>;
  }
}

const parameterValue = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * A Thread tool call's parameters, one per line as the agent passed them,
 * then its result. A long prompt or message stays readable.
 */
export function ThreadToolDetail({
  part,
  output,
}: {
  readonly part: ToolPart;
  readonly output: string;
}) {
  const parameters = Object.entries(record(part.input) ?? {});
  return (
    <div className="transcript-thread-tool">
      {parameters.length === 0 ? null : (
        <dl>
          {parameters.map(([name, value]) => (
            <div key={name}>
              <dt>{name}:</dt>
              <dd>{parameterValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre className="transcript-read-output">{output}</pre>
    </div>
  );
}
