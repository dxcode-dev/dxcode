import { describe, expect, it, vi } from "vitest";
import {
  ExecutionEnvironmentUnavailable,
  resolveRevisionConsistentSnapshot,
} from "./execution.js";

describe("execution environment consistency", () => {
  it("discards a raced snapshot and returns only a revision-stable retry", async () => {
    const revisions = ["before", "after", "after", "after"];
    const readRevision = vi.fn(async () => revisions.shift() as string);
    const resolve = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("raced")
      .mockResolvedValueOnce("stable");

    await expect(
      resolveRevisionConsistentSnapshot(readRevision, resolve),
    ).resolves.toBe("stable");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(readRevision).toHaveBeenCalledTimes(4);
  });

  it("fails closed after three continuously racing attempts", async () => {
    let revision = 0;
    const resolve = vi.fn(async () => "never-stable");

    await expect(
      resolveRevisionConsistentSnapshot(async () => {
        revision += 1;
        return String(revision);
      }, resolve),
    ).rejects.toBeInstanceOf(ExecutionEnvironmentUnavailable);
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});
