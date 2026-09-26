import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  canonicalPublicGitRepositoryLocator,
  PublicGitRepositoryUrl,
} from "./public-git-repository-locator.js";

describe("canonical public Git repository locator", () => {
  it.each([
    ["https://gitlab.com/team/repository", "team/repository"],
    ["https://codeberg.org/team/repository.git", "team/repository"],
    ["https://git.example.test/group/team/repository", "group/team/repository"],
  ])("normalizes %s", (value, fullName) => {
    expect(Schema.decodeUnknownSync(PublicGitRepositoryUrl)(value)).toBe(value);
    expect(canonicalPublicGitRepositoryLocator(value)).toEqual({
      fullName,
      webUrl: `https://${new URL(value).hostname}/${fullName}`,
      cloneUrl: `https://${new URL(value).hostname}/${fullName}.git`,
    });
  });

  it.each([
    "http://git.example.test/team/repository",
    "ssh://git@git.example.test/team/repository",
    "https://user@git.example.test/team/repository",
    "https://git.example.test:8443/team/repository",
    "https://git.example.test/team/repository?ref=main",
    "https://git.example.test/team/repository#readme",
    "https://git.example.test/team/repository/",
    "https://git.example.test/team/%2e%2e",
    "https://git.example.test/team/repo%2fother",
    "https://git.example.test/repository",
  ])("rejects unsafe or ambiguous locator %s", (value) => {
    expect(canonicalPublicGitRepositoryLocator(value)).toBeUndefined();
    expect(() =>
      Schema.decodeUnknownSync(PublicGitRepositoryUrl)(value),
    ).toThrow();
  });
});
