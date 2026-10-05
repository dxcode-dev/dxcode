import {
  configureSync,
  getConsoleSink,
  getLogger,
  type LogRecord,
} from "@logtape/logtape";

export const structuredConsoleFormatter = (record: LogRecord) => [
  {
    ...record.properties,
    timestamp: new Date(record.timestamp).toISOString(),
    level: record.level,
    category: record.category.join("."),
    message:
      typeof record.rawMessage === "string"
        ? record.rawMessage
        : record.message.join(""),
  },
];

configureSync({
  reset: true,
  sinks: {
    console: getConsoleSink({ formatter: structuredConsoleFormatter }),
  },
  loggers: [
    {
      category: ["dx"],
      lowestLevel: "info",
      sinks: ["console"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "error",
      sinks: ["console"],
    },
  ],
});

export const readinessLogger = getLogger(["dx", "readiness"]);
export const requestLogger = getLogger(["dx", "http", "request"]);
export const httpErrorLogger = getLogger(["dx", "http", "error"]);
export const authenticationLogger = getLogger(["dx", "auth", "authentication"]);
export const authorizationLogger = getLogger(["dx", "auth", "authorization"]);
export const applicationAuditLogger = getLogger([
  "dx",
  "applications",
  "audit",
]);
export const projectPersistenceLogger = getLogger([
  "dx",
  "persistence",
  "project",
]);
export const threadPersistenceLogger = getLogger([
  "dx",
  "persistence",
  "thread",
]);
export const settingsPersistenceLogger = getLogger([
  "dx",
  "persistence",
  "settings",
]);
export const settingsAuditLogger = getLogger(["dx", "settings", "audit"]);
export const executionWorkspaceLogger = getLogger(["dx", "execution", "e2b"]);
export const threadDaemonLogger = getLogger(["dx", "execution", "dxd"]);
export const orbContainerLogger = getLogger(["dx", "execution", "cloudflare"]);
export const orbProvidersLogger = getLogger(["dx", "execution", "providers"]);
export const workloadIdentityLogger = getLogger([
  "dx",
  "workload-identity",
  "audit",
]);
export const threadChangesLogger = getLogger(["dx", "thread-changes"]);
export const realtimeLogger = getLogger(["dx", "realtime"]);
export const agentLifecycleLogger = getLogger(["dx", "agent", "lifecycle"]);
export const agentModelLogger = getLogger(["dx", "agent", "model"]);
export const agentToolLogger = getLogger(["dx", "agent", "tool"]);
export const startupObservabilityLogger = getLogger([
  "dx",
  "observability",
  "startup",
]);
export const sourceControlLogger = getLogger(["dx", "source-control"]);
export const dictationLogger = getLogger(["dx", "dictation"]);
export const sourceControlAuditLogger = getLogger([
  "dx",
  "source-control",
  "audit",
]);
