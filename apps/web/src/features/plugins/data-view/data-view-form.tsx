import {
  type DataViewField,
  type DataViewPart,
  readStatePath,
} from "@dx/domain";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { Card } from "../../../shared/ui/card.js";
import { Field } from "../../../shared/ui/field.js";
import { Input } from "../../../shared/ui/input.js";
import { Select } from "../../../shared/ui/select.js";
import { Switch } from "../../../shared/ui/switch.js";
import { Textarea } from "../../../shared/ui/textarea.js";

import { type PartContext, text } from "./data-view-values.js";

/** A view's form: its fields start from state, and its submit runs an action. */

export function FormPart({
  id,
  part,
  context,
}: {
  readonly id: string;
  readonly part: DataViewPart & { readonly type: "form" };
  readonly context: PartContext;
}) {
  // The fields start from state the first time the form shows; after that
  // they are the person's own until they send it.
  const [values, setValues] = React.useState<Readonly<Record<string, unknown>>>(
    () =>
      Object.fromEntries(
        part.fields.map((field) => [
          field.name,
          initialValue(field, context.state),
        ]),
      ),
  );
  const set = (name: string, value: unknown) =>
    setValues((current) => ({ ...current, [name]: value }));
  const disabled = context.disabledReason !== undefined;
  return (
    <Card padding="md" className="data-view-card">
      <form
        className="data-view-form"
        aria-label={part.submit.label}
        onSubmit={(event) => {
          event.preventDefault();
          void context.run(id, part.submit.action, {
            state: context.state,
            form: values,
          });
        }}
      >
        {part.fields.map((field) => (
          <FieldPart
            key={field.name}
            id={`${id}.${field.name}`}
            field={field}
            value={values[field.name]}
            onChange={(value) => set(field.name, value)}
            disabled={disabled}
          />
        ))}
        <div className="data-view-buttons">
          <Button
            type="submit"
            size="sm"
            busy={context.busy === id}
            aria-disabled={disabled || undefined}
            title={context.disabledReason}
          >
            {part.submit.label}
          </Button>
        </div>
      </form>
    </Card>
  );
}

const initialValue = (field: DataViewField, state: unknown): unknown => {
  const bound =
    field.bind === undefined ? undefined : readStatePath(state, field.bind);
  if (field.type === "switch") return bound === true;
  if (bound !== undefined && bound !== null) return text(bound);
  return field.type === "select" ? (field.options?.[0]?.value ?? "") : "";
};

function FieldPart({
  id,
  field,
  value,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly field: DataViewField;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly disabled: boolean;
}) {
  if (field.type === "switch")
    return (
      <Switch
        id={id}
        label={field.label}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    );
  return (
    <Field id={id} label={field.label}>
      {field.type === "select" ? (
        <Select
          id={id}
          value={text(value)}
          disabled={disabled}
          options={(field.options ?? []).map(
            (option) => [option.value, option.label] as const,
          )}
          onValueChange={onChange}
        />
      ) : field.type === "textarea" ? (
        <Textarea
          id={id}
          value={text(value)}
          placeholder={field.placeholder}
          required={field.required}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={text(value)}
          placeholder={field.placeholder}
          required={field.required}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
