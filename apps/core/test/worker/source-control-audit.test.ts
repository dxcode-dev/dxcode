import { env } from "cloudflare:test";
import { SourceOperation } from "@dx/domain";
import { Effect, SchemaAST } from "effect";
import { describe, expect, it } from "vitest";
import {
  purgeSourceAuditBefore,
  SourceAudit,
  SourceAuditD1,
} from "../../src/source-control/audit.js";

const collectLiterals = (ast: SchemaAST.AST): unknown[] =>
  SchemaAST.isLiteral(ast)
    ? [ast.literal]
    : SchemaAST.isUnion(ast)
      ? ast.types.flatMap(collectLiterals)
      : [];

const sourceOperationLiterals = Array.from(
  new Set(collectLiterals(SourceOperation.ast)),
) as string[];

const record = {
  operationId: "sco_115",
  occurredAt: "2026-08-25T12:00:00.000Z",
  actorUserId: "actor-115",
  projectId: "project-115",
  threadId: "thread-115",
  provider: "github" as const,
  providerRepositoryId: "7115",
  requestedCapabilities: ["fetch"],
  credentialClass: "github-app-installation" as const,
  invocationSource: "agent-command" as const,
  outcome: "success" as const,
  durationMs: 15,
};

describe("source-control operation audit", () => {
  it("stores only bounded content-free fields and is application-immutable", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SourceAudit).record(record);
      }).pipe(Effect.provide(SourceAuditD1(env.DB))),
    );
    const stored = await env.DB.prepare(
      "SELECT * FROM source_control_operation_audit WHERE operation_id = ?",
    )
      .bind(record.operationId)
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      operation_id: "sco_115",
      actor_user_id: "actor-115",
      provider_repository_id: "7115",
      requested_capabilities_json: '["fetch"]',
      outcome: "success",
    });
    const columns = Object.keys(stored).join(",");
    for (const forbidden of [
      "token",
      "command",
      "output",
      "repository_name",
      "provider_payload",
      "ref",
    ])
      expect(columns).not.toContain(forbidden);
    await expect(
      env.DB.prepare(
        "UPDATE source_control_operation_audit SET reason = 'changed' WHERE operation_id = ?",
      )
        .bind(record.operationId)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      env.DB.prepare(
        "DELETE FROM source_control_operation_audit WHERE operation_id = ?",
      )
        .bind(record.operationId)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      env.DB.prepare(`
        INSERT INTO source_control_operation_audit (
          operation_id, occurred_at, actor_user_id, requested_capabilities_json,
          credential_class, invocation_source, outcome, duration_ms
        ) VALUES ('sco_content', ?, 'actor-115', '["secret-content"]',
          'none', 'system', 'denied', 1)
      `)
        .bind(record.occurredAt)
        .run(),
    ).rejects.toThrow("invalid source-control audit capability");
  });

  it("allows only the explicit short-lived retention seam to delete old rows", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SourceAudit).record({
          ...record,
          operationId: "sco_115_retention",
          occurredAt: "2026-01-01T00:00:00.000Z",
        });
      }).pipe(Effect.provide(SourceAuditD1(env.DB))),
    );
    await Effect.runPromise(
      purgeSourceAuditBefore(
        env.DB,
        "2026-02-01T00:00:00.000Z",
        "2999-01-01T00:00:00.000Z",
      ),
    );
    expect(
      await env.DB.prepare(
        "SELECT operation_id FROM source_control_operation_audit WHERE operation_id = 'sco_115_retention'",
      ).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT id FROM source_control_audit_retention_gate WHERE id = 1",
      ).first(),
    ).toBeNull();
  });

  it("admits every SourceOperation capability defined by the domain schema", async () => {
    expect(sourceOperationLiterals).toContain("provider-auth-read");
    expect(sourceOperationLiterals.length).toBeGreaterThanOrEqual(13);
    const audit = SourceAuditD1(env.DB);
    for (const operation of sourceOperationLiterals) {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* SourceAudit).record({
            ...record,
            operationId: `sco_parity_${operation}`,
            requestedCapabilities: [operation],
          });
        }).pipe(Effect.provide(audit)),
      );
    }
    for (const operation of sourceOperationLiterals) {
      const row = await env.DB.prepare(
        "SELECT requested_capabilities_json FROM source_control_operation_audit WHERE operation_id = ?",
      )
        .bind(`sco_parity_${operation}`)
        .first<Record<string, unknown>>();
      expect(row?.requested_capabilities_json).toBe(
        JSON.stringify([operation]),
      );
    }
  });
});
