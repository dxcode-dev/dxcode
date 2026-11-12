import {
  BUG_REPORT_AUDIO_MAX_BYTES,
  BUG_REPORT_IMAGE_MAX_BYTES,
  BUG_REPORT_JSON_MAX_BYTES,
  BUG_REPORT_MAX_IMAGES,
  type BugReportDiagnosticKind,
  BugReportIntakeRequestSchema,
  BugReportIntakeResponseSchema,
  BugReportSenderSchema,
} from "@dx/api";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  RequestBodyTooLarge,
  readBoundedFormData,
} from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { bugReportLogger } from "../logging.js";
import { redactBugReportText, redactBugReportValue } from "./redaction.js";
import {
  BUG_REPORT_FILE_NAME,
  bugReportFileKey,
  countReceivedSince,
  insertReceivedBugReport,
  newBugReportId,
} from "./repository.js";

/**
 * The central deployment's intake: reports other deployments forward
 * (#1661). It is open only on a deployment whose deploy sets
 * `DX_BUG_REPORT_INTAKE_SECRET`; elsewhere it answers 404.
 *
 * Each sender holds a key the secret derives for its name, so the intake
 * keeps no list of senders: `dxbr_<sender>.<HMAC-SHA256(secret, sender)>`,
 * issued by `internal/bug-reports/issue-intake-key.mjs`. The sender's name
 * is what All Bug Reports shows, beside the origin it states. Rotating the
 * secret revokes every key.
 */

/** Reports one sender may forward in an hour. */
export const INTAKE_REPORTS_PER_HOUR = 60;

const KEY = /^dxbr_([a-z0-9-]{1,40})\.([A-Za-z0-9_-]{43})$/;
const KEY_CONTEXT = "dx-bug-report-sender:";

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );

/** The intake key the secret derives for a sender. */
export const issueIntakeKey = async (secret: string, sender: string) => {
  const name = Schema.decodeUnknownSync(BugReportSenderSchema)(sender);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    new TextEncoder().encode(`${KEY_CONTEXT}${name}`),
  );
  return `dxbr_${name}.${base64Url(new Uint8Array(mac))}`;
};

/** The sender a key names, when the secret derived it. */
export const intakeSender = async (secret: string, key: string) => {
  const match = KEY.exec(key);
  const sender = match?.[1];
  const mac = match?.[2];
  if (sender === undefined || mac === undefined) return undefined;
  if (Option.isNone(Schema.decodeUnknownOption(BugReportSenderSchema)(sender)))
    return undefined;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    fromBase64Url(mac),
    new TextEncoder().encode(`${KEY_CONTEXT}${sender}`),
  );
  return valid ? sender : undefined;
};

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const refuse = (
  context: Context<AppEnv>,
  status: 400 | 401 | 404 | 413 | 429 | 503,
  code: string,
) =>
  context.json(
    {
      status: "error",
      data: { code, requestId: context.get("requestId") },
    },
    status,
  );

const MAX_BYTES =
  BUG_REPORT_JSON_MAX_BYTES +
  BUG_REPORT_MAX_IMAGES * BUG_REPORT_IMAGE_MAX_BYTES +
  BUG_REPORT_AUDIO_MAX_BYTES +
  64 * 1024;

/** Mounted at `/api/bug-reports`, before session authentication. */
export const bugReportIntakeRoutes = new Hono<AppEnv>().post(
  "/intake",
  async (context) => {
    const secret = context.env.DX_BUG_REPORT_INTAKE_SECRET?.trim();
    if (!secret) return refuse(context, 404, "NOT_FOUND");
    const db = context.env.DB;
    const bucket = context.env.DX_STORAGE;
    if (db === undefined || bucket === undefined)
      return refuse(context, 503, "PERSISTENCE_UNAVAILABLE");
    const authorization = context.req.header("authorization") ?? "";
    const sender = authorization.startsWith("Bearer ")
      ? await intakeSender(secret, authorization.slice(7).trim())
      : undefined;
    if (sender === undefined) return refuse(context, 401, "UNAUTHORIZED");
    const length = Number(context.req.header("content-length") ?? "0");
    if (!Number.isFinite(length) || length > MAX_BYTES)
      return refuse(context, 413, "TOO_LARGE");
    const now = new Date();
    if (
      (await countReceivedSince(
        db,
        sender,
        new Date(now.getTime() - 60 * 60 * 1000),
      )) >= INTAKE_REPORTS_PER_HOUR
    )
      return refuse(context, 429, "RATE_LIMITED");
    const form = await readBoundedFormData(context.req.raw, MAX_BYTES).catch(
      (error: unknown) =>
        error instanceof RequestBodyTooLarge
          ? ("TOO_LARGE" as const)
          : undefined,
    );
    if (form === "TOO_LARGE") return refuse(context, 413, "TOO_LARGE");
    const raw = form?.get("report");
    if (form === undefined || typeof raw !== "string")
      return refuse(context, 400, "INVALID_REQUEST");
    if (new TextEncoder().encode(raw).length > BUG_REPORT_JSON_MAX_BYTES)
      return refuse(context, 413, "TOO_LARGE");
    const report = Option.getOrUndefined(
      Schema.decodeUnknownOption(BugReportIntakeRequestSchema)(
        (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return undefined;
          }
        })(),
      ),
    );
    if (report === undefined || report.message.trim() === "")
      return refuse(context, 400, "INVALID_REQUEST");
    // Only the files a report keeps, once each and within its limits.
    const files: Array<{ name: string; bytes: Uint8Array; type: string }> = [];
    let total = 0;
    for (const part of form.getAll("file")) {
      if (typeof part === "string")
        return refuse(context, 400, "INVALID_REQUEST");
      const name = part.name;
      if (
        !BUG_REPORT_FILE_NAME.test(name) ||
        files.some((file) => file.name === name)
      )
        return refuse(context, 400, "INVALID_REQUEST");
      const limit =
        name === "diagnostics.json"
          ? BUG_REPORT_JSON_MAX_BYTES * 2
          : name === "dictation.wav"
            ? BUG_REPORT_AUDIO_MAX_BYTES
            : BUG_REPORT_IMAGE_MAX_BYTES;
      if (part.size > limit) return refuse(context, 413, "TOO_LARGE");
      total += part.size;
      const bytes = new Uint8Array(await part.arrayBuffer());
      if (name === "diagnostics.json") {
        // Redacted again: this deployment does not trust the sender's pass.
        const parsed = (() => {
          try {
            return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          } catch {
            return undefined;
          }
        })();
        if (parsed === undefined)
          return refuse(context, 400, "INVALID_REQUEST");
        files.push({
          name,
          bytes: new TextEncoder().encode(
            `${JSON.stringify(redactBugReportValue(parsed), null, 2)}\n`,
          ),
          type: "application/json",
        });
      } else {
        const extension = name.split(".").at(-1) ?? "";
        files.push({
          name,
          bytes,
          type:
            name === "dictation.wav"
              ? "audio/wav"
              : (IMAGE_TYPES[extension] ?? "application/octet-stream"),
        });
      }
    }
    if (total > MAX_BYTES) return refuse(context, 413, "TOO_LARGE");
    const imageCount = files.filter(({ name }) =>
      name.startsWith("image-"),
    ).length;
    const diagnostics = [
      ...new Set(report.diagnostics),
    ] as Array<BugReportDiagnosticKind>;
    try {
      const kept = await insertReceivedBugReport(
        db,
        {
          id: newBugReportId(),
          sender,
          origin: report.source.origin,
          sourceReportId: report.source.reportId,
          ...(report.source.threadId === undefined
            ? {}
            : { sourceThreadId: report.source.threadId }),
          message: redactBugReportText(report.message.trim()),
          imageCount,
          diagnostics,
        },
        now,
      );
      // A report whose files were not all kept is dropped again, so the
      // sender's retry keeps it whole instead of finding it half kept.
      if (kept.created)
        await Promise.all(
          files.map((file) =>
            bucket.put(bugReportFileKey(kept.id, file.name), file.bytes, {
              httpMetadata: { contentType: file.type },
            }),
          ),
        ).catch(async (cause: unknown) => {
          await db
            .prepare("DELETE FROM bug_report WHERE id = ?1")
            .bind(kept.id)
            .run();
          throw cause;
        });
      bugReportLogger.info("Forwarded bug report received.", {
        event: kept.created
          ? "bug_report_intake_received"
          : "bug_report_intake_repeated",
        reportId: kept.id,
        sender,
        origin: report.source.origin,
        imageCount,
        diagnostics,
      });
      return context.json(
        Schema.encodeUnknownSync(BugReportIntakeResponseSchema)({
          status: "success",
          data: { id: kept.id },
        }),
        kept.created ? 201 : 200,
      );
    } catch {
      bugReportLogger.error("Forwarded bug report could not be kept.", {
        event: "bug_report_intake_failed",
        sender,
        requestId: context.get("requestId"),
      });
      return refuse(context, 503, "PERSISTENCE_UNAVAILABLE");
    }
  },
);
