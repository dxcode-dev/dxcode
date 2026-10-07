import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import type { GitHubGrantData, SettingsContextData } from "@dx/api";
import {
  isValidProjectName,
  MAX_PROJECT_ADDITIONAL_REPOSITORIES,
  normalizeProjectName,
} from "@dx/domain";
import {
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  FolderGit,
  FolderGit2,
  GitBranch,
  Globe,
  Plus,
  UserRound,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import type { BitbucketRepository } from "../settings/integrations/bitbucket-queries.js";
import {
  connectedRepositoryOptions,
  matchesQuery,
  optionsWithTypedUrl,
  type ProjectSource,
  type RepositoryOption,
  sameRepository,
  sourceFor,
} from "./repository-options.js";

export type { ProjectSource, RepositoryOption } from "./repository-options.js";

export type ProjectOwner = "workspace" | "personal";
export interface NewProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly owner: ProjectOwner;
  readonly source: ProjectSource;
  readonly additionalRepositories?: ReadonlyArray<string>;
}

function RepositoryPicker({
  options,
  value,
  loading,
  onValueChange,
}: {
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly value?: RepositoryOption;
  readonly loading?: string;
  readonly onValueChange: (value: RepositoryOption | undefined) => void;
}) {
  const [query, setQuery] = React.useState(value?.label ?? "");
  const items = optionsWithTypedUrl(options, query);
  return (
    <Combobox.Root
      items={items}
      value={value ?? null}
      inputValue={query}
      onInputValueChange={(next) => {
        setQuery(next);
        if (value !== undefined && next !== value.label)
          onValueChange(undefined);
      }}
      onValueChange={(option) => onValueChange(option ?? undefined)}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      filter={matchesQuery}
      autoHighlight
    >
      <Combobox.InputGroup className="repository-combobox-control">
        <Combobox.Input
          id="project-repository"
          placeholder="Search repositories or paste a URL"
          autoComplete="off"
          autoFocus
          aria-busy={loading !== undefined}
        />
        <Combobox.Trigger aria-label="Open repository list">
          <ChevronDown aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          className="repository-combobox-positioner"
          sideOffset={4}
          align="start"
        >
          <Combobox.Popup className="repository-combobox-popup">
            <Combobox.Empty className="repository-combobox-empty">
              {loading ?? "No repositories found. Paste a Git URL."}
            </Combobox.Empty>
            <Combobox.List className="repository-combobox-list">
              {(option: RepositoryOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="repository-combobox-item repository-option"
                >
                  <GitBranch aria-hidden="true" />
                  <span>{option.label}</span>
                  <Combobox.ItemIndicator className="repository-combobox-indicator">
                    <Check aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

/**
 * Multi-select of repositories to clone beside the primary checkout. A pasted
 * canonical URL appears as a selectable option; selections stay listed.
 */
export function AdditionalRepositoriesPicker({
  options,
  value,
  loading,
  disabled,
  onValueChange,
}: {
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly value: ReadonlyArray<RepositoryOption>;
  readonly loading?: string;
  readonly disabled?: boolean;
  readonly onValueChange: (value: ReadonlyArray<RepositoryOption>) => void;
}) {
  const [query, setQuery] = React.useState("");
  const listed = [
    ...value,
    ...options.filter(
      (option) => !value.some((selected) => sameRepository(selected, option)),
    ),
  ];
  const items = optionsWithTypedUrl(listed, query);
  const full = value.length >= MAX_PROJECT_ADDITIONAL_REPOSITORIES;
  return (
    <Combobox.Root
      items={items}
      multiple
      value={[...value]}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(next) =>
        onValueChange(next.slice(0, MAX_PROJECT_ADDITIONAL_REPOSITORIES))
      }
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      filter={matchesQuery}
      autoHighlight
      disabled={disabled}
    >
      <Combobox.Trigger
        id="project-additional-repositories"
        className="additional-repositories-trigger"
      >
        <span>
          {value.length === 0
            ? "None selected"
            : value.length === 1
              ? "1 repository"
              : `${value.length} repositories`}
        </span>
        <ChevronsUpDown aria-hidden="true" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          className="repository-combobox-positioner"
          sideOffset={4}
          align="end"
        >
          <Combobox.Popup
            className="repository-combobox-popup additional-repositories-popup"
            aria-label="Additional repositories"
          >
            <Combobox.Input
              className="additional-repositories-search"
              placeholder="Search repositories or paste a URL"
              autoComplete="off"
              aria-busy={loading !== undefined}
            />
            <Combobox.Empty className="repository-combobox-empty">
              {loading ?? "No other repositories available."}
            </Combobox.Empty>
            <Combobox.List className="repository-combobox-list">
              {(option: RepositoryOption) => {
                const selected = value.some(
                  (current) => current.value === option.value,
                );
                return (
                  <Combobox.Item
                    key={option.value}
                    value={option}
                    disabled={full && !selected}
                    className="repository-combobox-item additional-repository-option"
                    title={option.webUrl}
                  >
                    <span
                      className="repository-checkbox"
                      data-checked={selected ? "" : undefined}
                      aria-hidden="true"
                    >
                      {selected ? <Check /> : null}
                    </span>
                    <span>
                      {option.connected === undefined
                        ? option.webUrl
                        : option.fullName}
                    </span>
                    {option.visibility === "public" ? (
                      <Globe aria-label="Public" />
                    ) : (
                      <span aria-hidden="true" />
                    )}
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function NewProjectDialog({
  actionError,
  creating,
  open,
  initialOwner,
  grants,
  bitbucketConnectionId,
  bitbucketRepositories = [],
  grantsError,
  repositoriesLoading,
  personalName,
  workspace,
  onReloadIntegrations,
  onOpenChange,
  onCreate,
}: {
  readonly actionError?: string;
  readonly creating: boolean;
  readonly open: boolean;
  readonly initialOwner: ProjectOwner;
  readonly grants: ReadonlyArray<GitHubGrantData>;
  readonly bitbucketConnectionId?: string;
  readonly bitbucketRepositories?: ReadonlyArray<BitbucketRepository>;
  readonly grantsError?: string;
  readonly repositoriesLoading?: string;
  readonly personalName: string;
  readonly workspace?: SettingsContextData["workspace"];
  readonly onReloadIntegrations: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: NewProjectInput) => void;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger
        className={`${buttonVariants({ size: "xs" })} projects-new-project-trigger`}
      >
        <Plus /> New Project
      </Dialog.Trigger>
      {open ? (
        <NewProjectForm
          key={`${initialOwner}:${open}`}
          actionError={actionError}
          creating={creating}
          initialOwner={initialOwner}
          options={connectedRepositoryOptions(
            grants,
            bitbucketConnectionId,
            bitbucketRepositories,
          )}
          grantsError={grantsError}
          repositoriesLoading={repositoriesLoading}
          personalName={personalName}
          workspace={workspace}
          onReloadIntegrations={onReloadIntegrations}
          onCreate={onCreate}
        />
      ) : null}
    </DialogRoot>
  );
}

function ProjectSourceChoices({
  onScratch,
  onRepository,
}: {
  readonly onScratch: () => void;
  readonly onRepository: () => void;
}) {
  return (
    <div className="project-source-choices">
      <button
        className="project-source-choice"
        type="button"
        onClick={onScratch}
      >
        <FolderGit aria-hidden="true" />
        <span>
          <strong>Start From Scratch</strong>
          <small>A blank repository managed by dx</small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
      <button
        className="project-source-choice"
        type="button"
        onClick={onRepository}
      >
        <FolderGit2 aria-hidden="true" />
        <span>
          <strong>Use an Existing Repository</strong>
          <small>Connect code from GitHub or another remote</small>
        </span>
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );
}

function RepositoryStepFields({
  options,
  repository,
  repositoriesLoading,
  grantsError,
  onRepositoryChange,
  onReloadIntegrations,
}: {
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly repository?: RepositoryOption;
  readonly repositoriesLoading?: string;
  readonly grantsError?: string;
  readonly onRepositoryChange: (value: RepositoryOption | undefined) => void;
  readonly onReloadIntegrations: () => void;
}) {
  return (
    <div className="new-project-fields">
      <label className="project-field" htmlFor="project-repository">
        <span>Repository</span>
        <RepositoryPicker
          options={options}
          value={repository}
          loading={repositoriesLoading}
          onValueChange={onRepositoryChange}
        />
      </label>
      {grantsError === undefined ? (
        <small className="new-project-hint">
          Missing a repository?{" "}
          <a href="/settings/integrations" target="_blank" rel="noreferrer">
            Manage repository access
            <ArrowUpRight aria-hidden="true" />
          </a>
        </small>
      ) : (
        <small className="form-error">
          {grantsError}{" "}
          <button type="button" onClick={onReloadIntegrations}>
            Retry
          </button>
        </small>
      )}
    </div>
  );
}

function ProjectDetailsFields({
  name,
  owner,
  description,
  showDescription,
  showAdditional,
  additional,
  additionalOptions,
  repositoriesLoading,
  personalName,
  workspace,
  onNameChange,
  onOwnerChange,
  onDescriptionChange,
  onShowDescription,
  onShowAdditional,
  onAdditionalChange,
}: {
  readonly name: string;
  readonly owner: ProjectOwner;
  readonly description: string;
  readonly showDescription: boolean;
  readonly showAdditional: boolean;
  readonly additional: ReadonlyArray<RepositoryOption>;
  readonly additionalOptions: ReadonlyArray<RepositoryOption>;
  readonly repositoriesLoading?: string;
  readonly personalName: string;
  readonly workspace?: SettingsContextData["workspace"];
  readonly onNameChange: (value: string) => void;
  readonly onOwnerChange: (value: ProjectOwner) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onShowDescription: () => void;
  readonly onShowAdditional: () => void;
  readonly onAdditionalChange: (value: ReadonlyArray<RepositoryOption>) => void;
}) {
  return (
    <div className="new-project-fields">
      <label className="project-field" htmlFor="project-name">
        <span>Project Name</span>
        <Input
          id="project-name"
          autoFocus
          value={name}
          maxLength={64}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <fieldset className="project-owner-fieldset">
        <legend>Owner</legend>
        <div className="project-owner-options">
          {workspace !== undefined ? (
            <label className={owner === "workspace" ? "selected" : ""}>
              <span className="owner-mark">
                <Building2 />
              </span>
              <span className="project-owner-copy">
                <strong>Workspace</strong>
                <small>{workspace.displayName}</small>
              </span>
              <input
                type="radio"
                name="project-owner"
                checked={owner === "workspace"}
                onChange={() => onOwnerChange("workspace")}
              />
            </label>
          ) : null}
          <label className={owner === "personal" ? "selected" : ""}>
            <span className="owner-mark personal">
              <UserRound />
            </span>
            <span className="project-owner-copy">
              <strong>Private</strong>
              <small>{personalName}</small>
            </span>
            <input
              type="radio"
              name="project-owner"
              checked={owner === "personal"}
              onChange={() => onOwnerChange("personal")}
            />
          </label>
        </div>
      </fieldset>
      {showDescription ? (
        <label className="project-field" htmlFor="project-description">
          <span>Description</span>
          <Input
            id="project-description"
            autoFocus
            maxLength={500}
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </label>
      ) : null}
      {showAdditional ? (
        <div className="project-field">
          <label htmlFor="project-additional-repositories">
            Additional Repositories
          </label>
          <AdditionalRepositoriesPicker
            options={additionalOptions}
            value={additional}
            loading={repositoriesLoading}
            onValueChange={onAdditionalChange}
          />
          <small className="new-project-hint">
            Clone other project repositories in this project's Orbs.
          </small>
        </div>
      ) : null}
      {showDescription && showAdditional ? null : (
        <div className="new-project-toggles">
          {showDescription ? null : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onShowDescription}
            >
              Add Description
            </Button>
          )}
          {showAdditional ? null : (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={onShowAdditional}
            >
              Add Additional Repositories
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type Step = "source" | "repository" | "details";

function NewProjectForm({
  actionError,
  creating,
  initialOwner,
  options,
  grantsError,
  repositoriesLoading,
  personalName,
  workspace,
  onReloadIntegrations,
  onCreate,
}: {
  readonly actionError?: string;
  readonly creating: boolean;
  readonly initialOwner: ProjectOwner;
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly grantsError?: string;
  readonly repositoriesLoading?: string;
  readonly personalName: string;
  readonly workspace?: SettingsContextData["workspace"];
  readonly onReloadIntegrations: () => void;
  readonly onCreate: (input: NewProjectInput) => void;
}) {
  const [step, setStep] = React.useState<Step>("source");
  const [repository, setRepository] = React.useState<RepositoryOption>();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [showDescription, setShowDescription] = React.useState(false);
  const [showAdditional, setShowAdditional] = React.useState(false);
  const [additional, setAdditional] = React.useState<
    ReadonlyArray<RepositoryOption>
  >([]);
  const [owner, setOwner] = React.useState<ProjectOwner>(
    workspace === undefined ? "personal" : initialOwner,
  );
  const validName = isValidProjectName(name);
  const additionalOptions = options.filter(
    (option) => repository === undefined || !sameRepository(option, repository),
  );

  const chooseScratch = () => {
    setRepository(undefined);
    setStep("details");
  };
  const continueWithRepository = () => {
    if (repository === undefined) return;
    if (name === "")
      setName(repository.fullName.split("/").at(-1) ?? repository.fullName);
    setAdditional((current) =>
      current.filter((option) => !sameRepository(option, repository)),
    );
    setStep("details");
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (step === "repository") return continueWithRepository();
    if (step !== "details") return;
    const normalizedName = normalizeProjectName(name);
    if (!isValidProjectName(normalizedName)) return;
    onCreate({
      name: normalizedName,
      ...(description.trim() === "" ? {} : { description: description.trim() }),
      owner,
      source:
        repository === undefined ? { kind: "scratch" } : sourceFor(repository),
      ...(additional.length === 0
        ? {}
        : { additionalRepositories: additional.map(({ webUrl }) => webUrl) }),
    });
  };

  const heading =
    step === "source"
      ? {
          title: "New Project",
          description:
            "Choose where the code for this project comes from. You can add more repositories to it later.",
        }
      : step === "repository"
        ? {
            title: "Choose a Repository",
            description:
              "Search the repositories your connections can access, or paste the URL of any Git repository.",
          }
        : {
            title: "Name Your Project",
            description:
              repository === undefined
                ? "Every Orb for this project starts with an empty repository."
                : `Every Orb for this project starts with a clone of ${repository.fullName}.`,
          };

  return (
    <DialogContent className="new-project-dialog">
      <header className="new-project-header">
        <DialogTitle>{heading.title}</DialogTitle>
        <DialogDescription>{heading.description}</DialogDescription>
      </header>
      <form onSubmit={submit} className="dialog-form">
        {step === "source" ? (
          <ProjectSourceChoices
            onScratch={chooseScratch}
            onRepository={() => setStep("repository")}
          />
        ) : null}
        {step === "repository" ? (
          <RepositoryStepFields
            options={options}
            repository={repository}
            repositoriesLoading={repositoriesLoading}
            grantsError={grantsError}
            onRepositoryChange={setRepository}
            onReloadIntegrations={onReloadIntegrations}
          />
        ) : null}
        {step === "details" ? (
          <ProjectDetailsFields
            name={name}
            owner={owner}
            description={description}
            showDescription={showDescription}
            showAdditional={showAdditional}
            additional={additional}
            additionalOptions={additionalOptions}
            repositoriesLoading={repositoriesLoading}
            personalName={personalName}
            workspace={workspace}
            onNameChange={setName}
            onOwnerChange={setOwner}
            onDescriptionChange={setDescription}
            onShowDescription={() => setShowDescription(true)}
            onShowAdditional={() => setShowAdditional(true)}
            onAdditionalChange={setAdditional}
          />
        ) : null}
        {actionError === undefined ? null : (
          <div className="notice error-notice">{actionError}</div>
        )}
        <div className="dialog-actions">
          <Dialog.Close
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Cancel
          </Dialog.Close>
          {step === "source" ? null : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setStep(
                  step === "details" && repository !== undefined
                    ? "repository"
                    : "source",
                )
              }
            >
              Back
            </Button>
          )}
          {step === "repository" ? (
            <Button type="submit" size="sm" disabled={repository === undefined}>
              Continue
            </Button>
          ) : null}
          {step === "details" ? (
            <Button type="submit" size="sm" disabled={creating || !validName}>
              {creating ? "Creating…" : "Create Project"}
            </Button>
          ) : null}
        </div>
      </form>
    </DialogContent>
  );
}
