import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
} from "./product-route-fixture.js";

/**
 * An archive whose Orb cannot be stopped answers 503 THREAD_ARCHIVE_UNAVAILABLE.
 * Before, the route dropped the cause, so staging's three 503s on 2026-11-04
 * (Orbs whose btrfs metadata was exhausted, which Cloudflare could not
 * snapshot) could not be told apart from a D1 outage. The 503 now logs
 * which failure it was, with the Thread and the provider's error.
 */

const logged: Array<string> = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ["warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
      logged.push(JSON.stringify(values));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("logs why an archive could not stop the Thread's Orb", async () => {
  const project = await createProjectViaApi("archive-stop-failure-log");
  const thread = await createThreadViaApi(project.data.id);

  const archive = await createProductApp().request(
    `/threads/${thread.data.id}/archive`,
    {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify({ archived: true }),
    },
    bindings,
  );

  expect(archive.status).toBe(503);
  await expect(archive.json()).resolves.toMatchObject({
    data: { code: "THREAD_ARCHIVE_UNAVAILABLE" },
  });
  const line = logged.find((entry) =>
    entry.includes("thread_archive_stop_failed"),
  );
  expect(line).toBeDefined();
  expect(line).toContain(thread.data.id);
  // Which failure it was: here no Execution provider is installed.
  expect(line).toContain('"errorName":"ExecutionProviderUnavailable"');
});
