import { Blocks } from "lucide-react";
import type * as React from "react";
import { type McpTemplate, mcpTemplateLogo } from "./mcp-catalog.js";

/** A brand mark on a light tile, or a generic mark when there is none. */
export function McpLogo({ template }: { readonly template?: McpTemplate }) {
  const logo =
    template === undefined ? undefined : mcpTemplateLogo(template.id);
  return logo === undefined ? (
    <Blocks />
  ) : (
    <img src={logo} alt="" loading="lazy" decoding="async" />
  );
}

/**
 * One integration or MCP server in the Integrations & MCP grid: its mark,
 * name, an optional MCP tag, one action, what it does, and a status line.
 */
export function IntegrationCard({
  label,
  icon,
  title,
  mcp = false,
  action,
  description,
  status,
  children,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly title: React.ReactNode;
  readonly mcp?: boolean;
  readonly action?: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly status?: {
    readonly tone: "ok" | "warn" | "muted";
    readonly text: React.ReactNode;
  };
  readonly children?: React.ReactNode;
}) {
  return (
    <section className="integration-tile" aria-label={label}>
      <header>
        <span className="integration-tile-icon" aria-hidden="true">
          {icon}
        </span>
        <h3>
          <span>{title}</span>
          {mcp ? <span className="integration-tile-tag">MCP</span> : null}
        </h3>
        {action === undefined ? null : (
          <div className="integration-tile-action">{action}</div>
        )}
      </header>
      {description === undefined ? null : <p>{description}</p>}
      {status === undefined ? null : (
        <p className="integration-tile-status" data-tone={status.tone}>
          <span aria-hidden="true" />
          {status.text}
        </p>
      )}
      {children}
    </section>
  );
}

/** A titled group of cards; renders nothing when it has none. */
export function IntegrationGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReadonlyArray<React.ReactNode>;
}) {
  const cards = children.filter(Boolean);
  if (cards.length === 0) return null;
  const id = `integration-group-${title.toLowerCase()}`;
  return (
    <section className="integration-group" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <div className="integration-grid">{cards}</div>
    </section>
  );
}
