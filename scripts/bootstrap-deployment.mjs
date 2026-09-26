import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const generatedPersonalAccountUsername = /^user-[a-f0-9]{24}$/;

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export const bootstrapDeployment = async ({
  credentials,
  database,
  repository,
  runnerProfileId = "a1.medium",
  resetPassword = false,
}) => {
  const now = new Date().toISOString();
  const displayName = credentials.displayName ?? "dx deployment reviewer";
  const bootstrapProject = credentials.bootstrapProject !== false;
  let user = await database.findUser(credentials.email);
  if (user === undefined) {
    const userWithExpectedId = await database.findUserById(credentials.userId);
    if (userWithExpectedId !== undefined)
      throw new Error("Deployment user identity does not match private state.");
    await database.insertUser({
      id: credentials.userId,
      name: displayName,
      email: credentials.email,
      now,
    });
    user = await database.findUser(credentials.email);
  }
  if (user === undefined)
    throw new Error("Deployment user bootstrap did not converge.");
  if (user.id !== credentials.userId)
    throw new Error("Deployment user identity does not match private state.");

  const username = await database.findUsername(user.id);
  if (
    username !== undefined &&
    username !== credentials.username &&
    !generatedPersonalAccountUsername.test(username)
  )
    throw new Error(
      "Deployment username identity does not match private state.",
    );

  const expectedCredential = {
    id: credentials.accountId,
    issuer: "local:credential",
    accountId: user.id,
    providerId: "credential",
    userId: user.id,
  };
  const validateCredential = async (credential) => {
    if (
      credential !== undefined &&
      Object.entries(expectedCredential).some(
        ([key, value]) => credential[key] !== value,
      )
    )
      throw new Error(
        "Deployment credential identity does not match private state.",
      );
    if (
      credential !== undefined &&
      !(await database.verifyCredential(credential, credentials.password))
    )
      throw new Error(
        "Deployment credential password does not match private state.",
      );
  };
  const existingCredential = await database.findCredential(user.id);
  if (resetPassword && existingCredential !== undefined) {
    await database.updateCredential({
      id: credentials.accountId,
      userId: user.id,
      password: credentials.password,
      now,
    });
  }
  await validateCredential(
    resetPassword ? await database.findCredential(user.id) : existingCredential,
  );
  if (existingCredential === undefined)
    await database.insertCredential({
      id: credentials.accountId,
      userId: user.id,
      password: credentials.password,
      now,
    });
  const credential = await database.findCredential(user.id);
  await validateCredential(credential);
  if (credential === undefined)
    throw new Error("Deployment credential bootstrap did not converge.");
  if (username !== credentials.username) {
    await database.updateUsername({
      userId: user.id,
      username: credentials.username,
      displayName,
      now,
    });
    if ((await database.findUsername(user.id)) !== credentials.username)
      throw new Error("Deployment username bootstrap did not converge.");
  }

  if (!bootstrapProject) return { userId: user.id };
  if (repository === null || typeof repository !== "object")
    throw new Error("Deployment bootstrap repository is required.");

  const project = await database.findProject(user.id, credentials.projectId);
  if (project !== undefined && project.id !== credentials.projectId)
    throw new Error(
      "Deployment Project identity does not match private state.",
    );
  const repositoryFields = Object.keys(repository);
  const repositoryMissing =
    project !== undefined &&
    repositoryFields.every((key) => project[key] === null);
  const repositoryMatches =
    project !== undefined &&
    Object.entries(repository).every(([key, value]) => project[key] === value);
  if (project !== undefined && !repositoryMissing && !repositoryMatches)
    throw new Error("Deployment Project source does not match the default.");
  if (
    project === undefined ||
    repositoryMissing ||
    project.runnerProfileId === "e2b-default"
  ) {
    await database.insertProject({
      id: credentials.projectId,
      userId: user.id,
      now,
      repository,
      runnerProfileId,
    });
  }
  const verified = await database.findProject(user.id, credentials.projectId);
  if (
    verified?.id !== credentials.projectId ||
    !Object.entries(repository).every(
      ([key, value]) => verified?.[key] === value,
    )
  )
    throw new Error("Deployment Project bootstrap did not converge.");
  await database.approveAuthenticationEmail?.({
    email: credentials.email,
    now,
  });
  return { userId: user.id, projectId: credentials.projectId };
};

export const approveBootstrapEmail = async ({ email, database }) => {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+$/.test(normalized))
    throw new Error("Bootstrap approval requires a valid email address.");
  const now = new Date().toISOString();
  await database.approveAuthenticationEmail({ email: normalized, now });
  return { email: normalized };
};

export const createCloudflareD1BootstrapDatabase = ({
  accountId,
  apiToken,
  databaseId,
  hashPassword,
  verifyPassword,
}) => {
  const query = async (sql, params = []) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = await response.json();
    if (!response.ok || body.success !== true)
      throw new Error(
        `Deployment bootstrap D1 query failed (${response.status}).`,
      );
    return body.result?.[0]?.results ?? [];
  };
  return {
    findUser: async (email) =>
      (
        await query('SELECT id, email FROM "user" WHERE email = ? LIMIT 1', [
          email,
        ])
      )[0],
    findUserById: async (userId) =>
      (
        await query('SELECT id, email FROM "user" WHERE id = ? LIMIT 1', [
          userId,
        ])
      )[0],
    findUsername: async (userId) =>
      (
        await query(
          "SELECT username FROM personal_account WHERE user_id = ? LIMIT 1",
          [userId],
        )
      )[0]?.username,
    findCredential: async (userId) =>
      (
        await query(
          "SELECT id, issuer, accountId, providerId, userId, password FROM account WHERE issuer = ? AND userId = ? LIMIT 1",
          ["local:credential", userId],
        )
      )[0],
    verifyCredential: async (credential, password) => {
      if (
        typeof verifyPassword !== "function" ||
        typeof credential?.password !== "string"
      )
        return false;
      try {
        return await verifyPassword({
          hash: credential.password,
          password,
        });
      } catch {
        return false;
      }
    },
    insertUser: ({ id, name, email, now }) =>
      query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(email) DO NOTHING',
        [id, name, email, now, now],
      ),
    insertCredential: async ({ id, userId, password, now }) => {
      const passwordHash = await hashPassword(password);
      await query(
        "INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(issuer, accountId) DO NOTHING",
        [
          id,
          "local:credential",
          userId,
          "credential",
          userId,
          passwordHash,
          now,
          now,
        ],
      );
    },
    updateCredential: async ({ id, userId, password, now }) => {
      const passwordHash = await hashPassword(password);
      await query(
        "UPDATE account SET password = ?, updatedAt = ? WHERE id = ? AND issuer = ? AND accountId = ? AND providerId = ? AND userId = ?",
        [
          passwordHash,
          now,
          id,
          "local:credential",
          userId,
          "credential",
          userId,
        ],
      );
    },
    updateUsername: ({ userId, username, displayName, now }) =>
      query(
        "UPDATE personal_account SET display_name = ?, username = ?, updated_at = ? WHERE user_id = ?",
        [displayName ?? "dx deployment reviewer", username, now, userId],
      ),
    approveAuthenticationEmail: ({ email, now }) =>
      query(
        `INSERT INTO auth_waitlist (email, status, created_at, updated_at, approved_at)
         VALUES (?, 'approved', ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           status = 'approved', updated_at = excluded.updated_at,
           approved_at = excluded.approved_at`,
        [email, now, now, now],
      ),
    findProject: async (userId, projectId) =>
      (
        await query(
          "SELECT projects.id, projects.runner_profile_id AS runnerProfileId, project_repository.provider, project_repository.binding_revision AS bindingRevision, project_repository.full_name AS fullName, project_repository.web_url AS webUrl, project_repository.clone_url AS cloneUrl FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id WHERE projects.owner_user_id = ? AND projects.id = ? LIMIT 1",
          [userId, projectId],
        )
      )[0],
    insertProject: async ({ id, userId, now, repository, runnerProfileId }) => {
      await query(
        "INSERT INTO projects (id, owner_user_id, name, runner_profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET runner_profile_id = excluded.runner_profile_id WHERE projects.owner_user_id = excluded.owner_user_id AND projects.runner_profile_id = 'e2b-default'",
        [
          id,
          userId,
          repository.fullName.split("/").at(-1),
          runnerProfileId,
          now,
          now,
        ],
      );
      await query(
        "INSERT INTO project_repository (project_id, provider, binding_revision, full_name, web_url, clone_url, created_at, updated_at) SELECT projects.id, ?, ?, ?, ?, ?, ?, ? FROM projects WHERE projects.id = ? AND projects.owner_user_id = ? ON CONFLICT(project_id) DO NOTHING",
        [
          repository.provider,
          repository.bindingRevision,
          repository.fullName,
          repository.webUrl,
          repository.cloneUrl,
          now,
          now,
          id,
          userId,
        ],
      );
    },
  };
};

const main = async () => {
  const selfhostStage = process.env.DX_BOOTSTRAP_STAGE?.trim();
  const hostedAuthentication =
    process.env.DX_BOOTSTRAP_HOSTED_AUTH?.trim() === "true";
  const credentials = selfhostStage
    ? (() => {
        const hash = createHash("sha256").update(selfhostStage).digest("hex");
        const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(
          16,
        );
        const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const email = required("DX_BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
        const local = email.slice(0, email.indexOf("@")).toLowerCase();
        const username = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(local)
          ? local
          : "dx-admin";
        return {
          version: 3,
          target: "selfhost",
          stage: selfhostStage,
          email,
          username,
          ...(hostedAuthentication
            ? {}
            : { password: required("DX_BOOTSTRAP_ADMIN_PASSWORD") }),
          userId: `usr_${hash.slice(0, 32)}`,
          accountId: `acc_${hash.slice(0, 32)}`,
          projectId: `prj_${uuid}`,
          bootstrapProject: false,
          displayName: "dx admin",
        };
      })()
    : JSON.parse(
        readFileSync(required("DX_BOOTSTRAP_CREDENTIALS_FILE"), "utf8"),
      );
  const requireFromCore = createRequire(
    new URL("../apps/core/package.json", import.meta.url),
  );
  const database = createCloudflareD1BootstrapDatabase({
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    databaseId: required("DX_BOOTSTRAP_DATABASE_ID"),
    ...(hostedAuthentication
      ? {}
      : await import(requireFromCore.resolve("better-auth/crypto")).then(
          ({ hashPassword, verifyPassword }) => ({
            hashPassword,
            verifyPassword,
          }),
        )),
  });
  if (hostedAuthentication)
    await approveBootstrapEmail({ email: credentials.email, database });
  else
    await bootstrapDeployment({
      credentials,
      repository: selfhostStage
        ? undefined
        : JSON.parse(required("DX_BOOTSTRAP_REPOSITORY")),
      resetPassword: process.env.DX_BOOTSTRAP_ADMIN_PASSWORD_RESET === "true",
      runnerProfileId: required("DX_BOOTSTRAP_RUNNER_PROFILE_ID"),
      database,
    });
  console.log("Deployment bootstrap is ready.");
};

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
)
  await main();
