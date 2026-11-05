import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeFlueEvent } from "./flue.js";

/**
 * #1770: a Thread's turn failed with "A canonical conversation record
 * violates the conversation stream contract", and no log said which record
 * broke which rule, because Pi keeps only the error's message. The Flue
 * session reports the rejection as an error `log` observation (its emission
 * is tested in the fork's `session-invariant-observation.test.ts`), and dx
 * logs it as one structured Workers log line. The observation below is the
 * one the session emits. Ways it could go wrong:
 *  1. Nothing is logged, or the line lacks the record's identity or rule.
 *  2. The line cannot be tied to its Thread, submission, and turn.
 *  3. Anything beyond the listed fields reaches the log: record content,
 *     prompt text, or tool output can hold secrets.
 *  4. Other Flue log observations start reaching the log.
 */

const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
      logged.push(JSON.stringify(values));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const observation = (attributes: Record<string, unknown>) =>
  ({
    v: 3,
    eventIndex: 7,
    timestamp: new Date().toISOString(),
    type: "log",
    level: "error",
    message: "[flue] A canonical conversation record was rejected.",
    attributes,
    agentName: "dx-agent",
    instanceId: "thr_record_invariant_log",
    submissionId: "sub_record_invariant_log",
    turnId: "turn_record_invariant_log",
  }) as unknown as FlueObservation;

const context = { env: {} } as unknown as FlueEventContext;

it("logs which record broke the conversation stream contract, without its content", async () => {
  await observeFlueEvent(
    observation({
      errorType: "conversation_record_invariant",
      recordId: "record_tool_results_committed_ZW50cnk",
      recordType: "tool_results_committed",
      reason:
        "Committed tool results must reference every assistant tool call exactly once.",
      agentEvent: "turn_end",
      // Never logged: only the listed fields leave the observation.
      content: "secret tool output",
    }),
    context,
  );

  const lines = logged
    .filter((line) => line.includes('"event":"conversation_record_invariant"'))
    .map((line) => (JSON.parse(line) as Record<string, unknown>[])[0]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    level: "error",
    category: "dx.agent.model",
    message: "Canonical conversation record rejected.",
    event: "conversation_record_invariant",
    threadId: "thr_record_invariant_log",
    submissionId: "sub_record_invariant_log",
    turnId: "turn_record_invariant_log",
    recordId: "record_tool_results_committed_ZW50cnk",
    recordType: "tool_results_committed",
    reason:
      "Committed tool results must reference every assistant tool call exactly once.",
    agentEvent: "turn_end",
  });
  expect(JSON.stringify(lines)).not.toContain("secret");
});

it("does not log other Flue log observations", async () => {
  await observeFlueEvent(
    observation({ note: "a hook's own log line with secret detail" }),
    context,
  );

  expect(logged.filter((line) => line.includes("secret"))).toEqual([]);
});
