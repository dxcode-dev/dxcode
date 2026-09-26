import type { ProjectData, ThreadDetailData } from "@dx/api";
import { DateTime } from "effect";
import type {
  TranscriptRow,
  TranscriptTurn,
  TranscriptViewModel,
} from "./transcript-view-model.js";

export const THREAD_EXPORT_FORMAT = "dx-thread-export";
export const THREAD_EXPORT_VERSION = 1;

export interface ThreadExportInput {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly model: TranscriptViewModel;
}

interface ExportRow {
  readonly type:
    | "user"
    | "assistant"
    | "final-answer"
    | "work"
    | "file"
    | "failure";
  readonly text?: string;
  readonly status?: string;
  readonly durationMs?: number;
  readonly file?: {
    readonly name?: string;
    readonly mediaType?: string;
    readonly sizeBytes?: number;
  };
}

const finiteDuration = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const exportRow = (row: TranscriptRow): ExportRow | undefined => {
  if (row.kind === "user-prompt") return { type: "user", text: row.text };
  if (row.kind === "assistant-prose")
    return { type: "assistant", text: row.text };
  if (row.kind === "final-answer")
    return { type: "final-answer", text: row.text };
  if (row.kind === "failure") return { type: "failure", status: row.outcome };
  if (row.kind === "attachment") {
    const { filename, mediaType, size } = row.attachment;
    return {
      type: "file",
      file: {
        ...(typeof filename === "string" && filename ? { name: filename } : {}),
        ...(typeof mediaType === "string" && mediaType ? { mediaType } : {}),
        ...(finiteDuration(size) !== undefined ? { sizeBytes: size } : {}),
      },
    };
  }
  if (row.kind === "active-work" || row.kind === "settled-work") {
    const durationMs =
      row.part.type === "dynamic-tool"
        ? finiteDuration(row.part.durationMs)
        : undefined;
    return {
      type: "work",
      status: row.kind === "active-work" ? "active" : "completed",
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return undefined;
};

const exportTurn = (
  turn: TranscriptTurn,
  rows: ReadonlyMap<string, TranscriptRow>,
) => ({
  status: turn.status,
  ...(finiteDuration(turn.durationMs) !== undefined
    ? { durationMs: turn.durationMs }
    : {}),
  entries: turn.rowIds.flatMap((id) => {
    const row = rows.get(id);
    const entry = row && exportRow(row);
    return entry ? [entry] : [];
  }),
});

export const serializeThreadJson = ({
  thread,
  project,
  model,
}: ThreadExportInput) => {
  const rows = new Map(model.rows.map((row) => [row.id, row]));
  return `${JSON.stringify(
    {
      format: THREAD_EXPORT_FORMAT,
      version: THREAD_EXPORT_VERSION,
      thread: {
        title: thread.title,
        project: project?.name ?? null,
        visibility: thread.visibility,
        createdAt: DateTime.formatIso(thread.createdAt),
        updatedAt: DateTime.formatIso(thread.updatedAt),
      },
      turns: model.turns.map((turn) => exportTurn(turn, rows)),
    },
    null,
    2,
  )}\n`;
};

const fileLabel = (file: NonNullable<ExportRow["file"]>) => {
  const details = [
    file.mediaType,
    file.sizeBytes === undefined ? undefined : `${file.sizeBytes} bytes`,
  ]
    .filter(Boolean)
    .join(", ");
  return `${file.name ?? "Unnamed file"}${details ? ` (${details})` : ""}`;
};

export const serializeThreadMarkdown = ({
  thread,
  project,
  model,
}: ThreadExportInput) => {
  const rows = new Map(model.rows.map((row) => [row.id, row]));
  const lines = [
    `# ${thread.title}`,
    "",
    `- Export format: ${THREAD_EXPORT_FORMAT} v${THREAD_EXPORT_VERSION}`,
    `- Project: ${project?.name ?? "None"}`,
    `- Visibility: ${thread.visibility}`,
    `- Created: ${DateTime.formatIso(thread.createdAt)}`,
    `- Updated: ${DateTime.formatIso(thread.updatedAt)}`,
  ];
  for (const [index, turn] of model.turns.entries()) {
    lines.push("", `## Turn ${index + 1}`, "", `Status: ${turn.status}`);
    if (finiteDuration(turn.durationMs) !== undefined)
      lines.push(`Duration: ${turn.durationMs} ms`);
    for (const id of turn.rowIds) {
      const row = rows.get(id);
      const entry = row && exportRow(row);
      if (!entry) continue;
      if (entry.type === "user")
        lines.push("", "### User", "", entry.text ?? "");
      else if (entry.type === "assistant" || entry.type === "final-answer")
        lines.push(
          "",
          entry.type === "final-answer" ? "### Final answer" : "### Assistant",
          "",
          entry.text ?? "",
        );
      else if (entry.type === "file")
        lines.push("", `- File: ${fileLabel(entry.file ?? {})}`);
      else if (entry.type === "work")
        lines.push(
          "",
          `- Work: ${entry.status}${entry.durationMs === undefined ? "" : ` (${entry.durationMs} ms)`}`,
        );
      else lines.push("", `- Turn ${entry.status}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

export const threadExportFilename = (
  title: string,
  extension: "md" | "json",
) => {
  const stem = title
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
  return `${stem || "thread"}.${extension}`;
};
