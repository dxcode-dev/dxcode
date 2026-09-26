import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ThreadId } from "@dx/domain";
import { afterEach, describe, expect, it } from "vitest";
import { makeThreadChangesRepository } from "./repository-d1.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const fixture = () => {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE project_repository (project_id TEXT PRIMARY KEY);
    CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
    CREATE TABLE thread_source_snapshot (
      thread_id TEXT PRIMARY KEY,
      initial_commit_sha TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      repository_full_name TEXT NOT NULL
    );
  `);
  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...parameters: SQLInputValue[]) => statement(sql, parameters),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
  });
  return {
    sqlite,
    repository: makeThreadChangesRepository({
      prepare: statement,
    } as unknown as D1Database),
  };
};

describe("Thread Changes source persistence", () => {
  it("uses the empty tree as the projectless Thread baseline", async () => {
    const { repository, sqlite } = fixture();
    const threadId = "thr_00000000-0000-4000-8000-000000000296" as ThreadId;
    sqlite
      .prepare("INSERT INTO projects VALUES (?, ?)")
      .run("project", "No Project");
    sqlite
      .prepare("INSERT INTO threads VALUES (?, ?)")
      .run(threadId, "project");

    await expect(repository.source(threadId)).resolves.toEqual({
      baseline: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      defaultBranch: "main",
      repositoryName: "No Project",
    });
  });

  it("uses the empty tree as a scratch Project baseline", async () => {
    const { repository, sqlite } = fixture();
    const threadId = "thr_00000000-0000-4000-8000-000000000297" as ThreadId;
    sqlite
      .prepare("INSERT INTO projects VALUES (?, ?)")
      .run("project", "Scratch");
    sqlite
      .prepare("INSERT INTO threads VALUES (?, ?)")
      .run(threadId, "project");

    await expect(repository.source(threadId)).resolves.toEqual({
      baseline: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      defaultBranch: "main",
      repositoryName: "Scratch",
    });
  });

  it("does not synthesize a Changes source for a bound repository", async () => {
    const { repository, sqlite } = fixture();
    const threadId = "thr_00000000-0000-4000-8000-000000000298" as ThreadId;
    sqlite
      .prepare("INSERT INTO projects VALUES (?, ?)")
      .run("project", "Repository");
    sqlite.prepare("INSERT INTO project_repository VALUES (?)").run("project");
    sqlite
      .prepare("INSERT INTO threads VALUES (?, ?)")
      .run(threadId, "project");

    await expect(repository.source(threadId)).resolves.toBeUndefined();
  });
});
