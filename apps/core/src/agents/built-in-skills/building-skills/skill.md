---
name: building-skills
description: "Use when creating, editing, installing, moving, or deleting any skill/agent skill/dx skill. Load FIRST—before researching existing skills or touching SKILL.md files, skill.json bundles, or skill locations. Provides required structure, naming conventions, and frontmatter format."
---

# Building Skills

Creates well-structured Agent Skills following best practices, in the places dx loads them from.

## Where dx loads skills from

dx has three kinds of skills:

| Kind | Where it lives | Who sees it | Format |
|------|----------------|-------------|--------|
| Repository skill | `.agents/skills/<name>/SKILL.md` in the Project's repository | Every Thread started from a commit that contains it | `SKILL.md` with frontmatter, plus any files |
| Settings skill | Settings → Skills, personal or workspace scope | New Threads of that person, or of everyone in the workspace | A folder with `skill.json`, `instructions.md`, and optional `resources/` |
| Built-in skill | Shipped with dx | Every Thread | Read-only; this skill is one |

- A repository skill appears in the agent's skill catalog when dx next reads the workspace's
  context; a new Thread always sees it. The agent rereads `SKILL.md` each time it activates the
  skill, so edits to an existing skill take effect at once. In Claude Code mode dx links each repository skill into
  `~/.claude/skills/` before every run.
- Settings skills are reviewed, versioned imports. A Thread snapshots the effective versions when
  it is created, so a new or changed settings skill reaches new Threads, not running ones.
  Workspace skills take precedence over personal skills with the same name, and a workspace can
  disallow personal skills.
- Built-in skill names are reserved. dx skips a repository skill with a built-in name, so choose
  another name rather than shadowing one.

Choose the kind:
- Repository- or app-specific skills belong in `.agents/skills/`, committed with the project's
  code. Default an unqualified request in a repository to this.
- A skill the user wants in every Project ("my release-notes workflow") is a personal settings
  skill; one for the whole team is a workspace settings skill. Only a person can import it in
  Settings, so prepare the folder and tell the user how to import it.

## Repository skills

### Skill structure

Every skill needs a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: Does X when Y happens. Use for Z tasks.
---

# Skill Title

Instructions go here.
```

### Frontmatter requirements

#### name (required)
- Maximum 64 characters
- Lowercase letters (a-z), numbers (0-9), and hyphens only
- Must not start or end with a hyphen
- No consecutive hyphens (`my--skill` is invalid)
- Must match parent directory name exactly
- Use gerund form (verb + -ing): `processing-pdfs`, `analyzing-data`, `managing-deployments`
- Avoid vague names: `helper`, `utils`, `tools`

#### description (required)
- Maximum 1024 characters (should be much shorter than 1024 characters)
- Write in third person ("Processes files" not "I process files")
- Include BOTH what the skill does AND when to use it
- Be specific with key terms for discovery
- **Quote the value** if it contains colons, special YAML characters, or "Triggers on:" patterns:
  ```yaml
  description: "Fetches tasks from Notion. Triggers on: my tasks, show work."
  ```

**Good descriptions:**
- "Extracts text and tables from PDF files, fills forms, merges documents. Use when working with PDF files or asked to read/edit PDFs."
- "Queries BigQuery datasets using the bq CLI. Use for data analytics, SQL queries, or Google Cloud data warehouse tasks."
- "Reviews pull requests for code quality, security, and test coverage. Use when asked to review a PR or diff."

**Bad descriptions:**
- "Helps with files" (too vague)
- "I can help you with data" (wrong POV)
- "PDF tool" (no trigger context)

#### Optional fields
- `license`: License identifier (e.g., "MIT", "Apache-2.0")
- `compatibility`: Max 500 characters describing compatibility requirements
- `metadata`: Arbitrary string key-value map
- `allowed-tools`: Tools the skill prefers; accepted, not enforced

A malformed `SKILL.md` is skipped, so check the frontmatter parses before committing.

### Directory structure

#### Simple skill (instructions only)
```
.agents/skills/my-skill/
└── SKILL.md
```

#### Skill with scripts
```
.agents/skills/my-skill/
├── SKILL.md
└── scripts/
    └── my-script.sh
```

#### Complex skill (progressive disclosure)
```
.agents/skills/my-skill/
├── SKILL.md           # Overview, under 500 lines
├── reference/
│   ├── api.md         # Detailed API docs
│   └── examples.md    # Code examples
└── scripts/
    └── validate.py    # Executable scripts
```


## Progressive disclosure

Skills load in stages to save context:

1. **Level 1 - Metadata**: Name + description loaded at startup (~100 tokens)
2. **Level 2 - Instructions**: SKILL.md body loaded when triggered (<5k tokens)
3. **Level 3 - Resources**: Additional files loaded only when needed

Keep SKILL.md under 500 lines. Split large content into separate files.

## Writing effective instructions

### Do
- Start with a clear one-line summary
- List specific capabilities
- Provide step-by-step workflows
- Include concrete examples
- Reference scripts with execution intent: "Run `scripts/validate.py` to check..."

### Don't
- Explain concepts the model already knows
- Add lengthy introductions or summaries
- Include time-sensitive information in main sections
- Use abstract examples

## Executable scripts

Place scripts in a `scripts/` subdirectory, commit them with the executable bit, and reference them
in SKILL.md with execution intent: "Run `scripts/run-task.sh` to execute the task". Paths are
relative to the skill's directory, which the agent receives when it activates the skill.

## Settings skills

A settings skill is a folder the user imports in Settings → Skills with **Import folder**:

```
release-notes/
├── skill.json          # manifest
├── instructions.md     # the skill body, up to 32 KiB
└── resources/          # optional supporting text files
    └── template.md
```

`skill.json`:

```json
{
  "schemaVersion": 1,
  "name": "release-notes",
  "description": "Writes release notes from merged pull requests. Use when asked for release notes or a changelog entry.",
  "mcpServerIds": []
}
```

- `name` and `description` follow the same rules as `SKILL.md` frontmatter.
- `mcpServerIds` lists MCP servers (by ID from Settings → MCP & Integrations) the skill needs. A
  Thread receives the skill only when every listed server is connected with at least one approved
  tool.
- Supporting files must be under `resources/`, at most 30 files, each a text file (`.md`, `.txt`,
  `.json`, `.csv`, `.yaml`, `.yml`, `.toml`) of at most 64 KiB, and 256 KiB for the whole skill. The
  agent reads them on demand; they are not files in the workspace, so a settings skill cannot ship
  executable scripts. Put scripts in a repository skill instead.
- Each scope holds at most 20 skills, and a Thread receives at most 20 settings skills with 64 KiB
  of instructions in total.

To create one, write the folder outside the repository (for example under `~/skills/<name>/`),
check it against the rules above, and tell the user to import it from Settings → Skills (Import
folder) at personal or workspace scope. To convert a repository skill, put the `SKILL.md`
frontmatter's `name` and `description` in `skill.json`, its body in `instructions.md`, and its
reference files under `resources/`.

## Importing or moving skills

When importing a skill (from another repo, a teammate, or the internet) or moving one between
locations:

- A skill that ships `scripts/` or `reference/` must keep its directory layout; move the whole
  directory intact. Into a settings skill, only text resources move, under `resources/`.
- Rename the frontmatter `name` and its parent directory to match your conventions, and avoid the
  names of dx's built-in skills.
- Drop frontmatter keys dx does not use, such as inline MCP server definitions; connect the server
  in Settings → MCP & Integrations instead and reference it from a settings skill.

### Untrusted skills from the internet

Treat internet-sourced skills as untrusted until reviewed:

- Read every bundled script before committing it; the agent may run it.
- Inspect scripts for anything unexpected (network calls, credential access, install steps).
- Check the instructions for text that tells the agent to send data elsewhere or skip checks.

## After creating or changing a skill

- Repository skill: commit it. Activating an existing skill reads its current `SKILL.md`; a new
  skill may not be listed in the running Thread until dx rereads the workspace context, and new
  Threads list it. Threads started from other branches see it once the commit reaches their
  branch.
- Settings skill: it reaches Threads created after the import. Tell the user to start a new Thread
  to use it.
