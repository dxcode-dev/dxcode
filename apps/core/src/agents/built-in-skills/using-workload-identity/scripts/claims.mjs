#!/usr/bin/env node
// Prints this Thread's workload identity claims and the values cloud trust
// setup needs. Never prints the token itself.
import { createHash } from "node:crypto";
import { claimsOf, mintToken, parseArguments } from "./workload-token.mjs";

const { audience = "urn:dx:claims-probe" } = parseArguments(
  ["audience"],
  "usage: claims.mjs [--audience <audience>]",
);
const claims = claimsOf(mintToken(audience, 60));
const hash = (id) =>
  id === undefined
    ? undefined
    : createHash("sha256").update(id).digest("base64url");
const w = hash(claims.workspace_id);
const u = hash(claims.user_id);
const p = hash(claims.project_id);

const { jti: _jti, iat: _iat, ...shown } = claims;
console.log(
  JSON.stringify(
    {
      claims: shown,
      discovery: `${claims.iss}/.well-known/openid-configuration`,
      personalProject: claims.workspace_id === undefined,
      hashes: {
        workspace: w,
        user: u,
        project: p,
        thread: hash(claims.thread_id),
      },
      awsSubPatterns: {
        ...(w === undefined
          ? {
              user: `dx:wid:v1:u:${u}:*`,
              project: `dx:wid:v1:u:${u}:p:${p}:t:*`,
            }
          : {
              workspace: `dx:wid:v1:w:${w}:*`,
              workspaceUser: `dx:wid:v1:w:${w}:u:${u}:*`,
              project: `dx:wid:v1:w:${w}:u:*:p:${p}:t:*`,
            }),
        thread: claims.sub,
      },
      awsConditionKeys: {
        aud: `${claims.iss.replace(/^https:\/\//, "")}:aud`,
        sub: `${claims.iss.replace(/^https:\/\//, "")}:sub`,
      },
    },
    null,
    2,
  ),
);
