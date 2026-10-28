import { useCallback, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { dateTimeInput, dateTimeIso } from "@/shared/PluginTools";
import {
  pluginDefaults,
  pluginJsonEqual,
  pluginText,
  type JsonValue,
  type PluginSchema,
} from "@/shared/Plugins";

interface FieldProps {
  schema: PluginSchema;
  value: JsonValue | undefined;
  onChange: (value: JsonValue | undefined) => void;
  path: string;
  label: string;
  required?: boolean;
  disabled?: boolean;
  formatEnum?: (value: JsonValue) => string | undefined;
  onInvalid: (path: string, invalid: boolean) => void;
}

/** Fresh values for repeatable rows, including the minimum rows of nested lists. */
export function pluginArrayEntryDefault(schema: PluginSchema): JsonValue {
  if (schema.default !== undefined || schema.enum?.length) return pluginDefaults(schema);
  if (schema.type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, () =>
      pluginArrayEntryDefault(schema.items ?? { type: "string" })
    );
  const value = pluginDefaults(schema);
  if (schema.type === "object" && value && !Array.isArray(value) && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, pluginArrayEntryDefault(schema.properties![key])])
    );
  return value;
}

function ArrayField({
  schema,
  value,
  onChange,
  path,
  label,
  disabled,
  onInvalid,
  formatEnum,
}: FieldProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const values = Array.isArray(value) ? value : [];
  const itemSchema = schema.items ?? { type: "string" };
  const invalidPaths = useRef(new Set<string>());
  const clearInvalid = useCallback(() => {
    for (const invalidPath of invalidPaths.current) onInvalid(invalidPath, false);
    invalidPaths.current.clear();
  }, [onInvalid]);
  const trackInvalid = useCallback(
    (childPath: string, invalid: boolean) => {
      if (invalid) invalidPaths.current.add(childPath);
      else invalidPaths.current.delete(childPath);
      onInvalid(childPath, invalid);
    },
    [onInvalid]
  );
  useEffect(() => clearInvalid, [clearInvalid]);
  const minimum = schema.minItems ?? 0;
  const maximum = schema.maxItems ?? 256;
  return (
    <fieldset
      disabled={disabled}
      aria-describedby={schema.description ? `${id}-hint` : undefined}
      className="min-w-0 space-y-3"
    >
      <legend className="text-sm font-medium">{label}</legend>
      {schema.description && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {pluginText(schema.description, i18n.language)}
        </p>
      )}
      {!values.length && <p className="text-xs text-muted-foreground">{t("plugins.emptyArray")}</p>}
      <div className="min-w-0 space-y-3">
        {values.map((entry, index) => (
          <div
            key={index}
            className="min-w-0 space-y-2 rounded-lg border border-border bg-background/40 p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t("plugins.entryLabel", { index: index + 1 })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || values.length <= minimum}
                aria-label={t("plugins.removeEntry", { index: index + 1 })}
                onClick={() => {
                  // Indices become new field paths after deletion. Clear old
                  // draft validation before changing the list's structure.
                  clearInvalid();
                  onChange(values.filter((_, row) => row !== index));
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
            <SchemaField
              schema={itemSchema}
              value={entry}
              path={`${path}[${index}]`}
              label={t("plugins.entryLabel", { index: index + 1 })}
              required
              disabled={disabled}
              formatEnum={formatEnum}
              onInvalid={trackInvalid}
              onChange={(next) =>
                onChange(values.map((item, row) => (row === index ? (next ?? null) : item)))
              }
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || values.length >= maximum}
          onClick={() => onChange([...values, pluginArrayEntryDefault(itemSchema)])}
        >
          {t("plugins.addEntry")}
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t("plugins.arrayLimit", { count: values.length, maximum })}
        </span>
      </div>
    </fieldset>
  );
}

function SchemaField(props: FieldProps) {
  const { schema, value, onChange, path, label, required, disabled, onInvalid, formatEnum } = props;
  const { t, i18n } = useTranslation();
  const id = useId();
  const fieldLabel = `${pluginText(schema.title, i18n.language) || label}${required ? " *" : ""}`;
  if (schema.type === "object") {
    const values = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
      <fieldset
        disabled={disabled}
        className="min-w-0 space-y-4 rounded-lg border border-border p-3"
      >
        <legend className="px-1 text-sm font-medium">{fieldLabel}</legend>
        {schema.description && (
          <p className="text-xs text-muted-foreground">
            {pluginText(schema.description, i18n.language)}
          </p>
        )}
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <SchemaField
            key={key}
            schema={child}
            value={values[key]}
            path={`${path}.${key}`}
            label={key}
            required={schema.required?.includes(key)}
            disabled={disabled}
            formatEnum={formatEnum}
            onInvalid={onInvalid}
            onChange={(next) => {
              const object = { ...values };
              if (next === undefined) delete object[key];
              else object[key] = next;
              onChange(object);
            }}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === "array") return <ArrayField {...props} label={fieldLabel} />;
  if (schema.type === "boolean")
    return (
      <label htmlFor={id} className="flex items-start gap-3 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <span className="min-w-0">
          <span className="font-medium">{fieldLabel}</span>
          {schema.description && (
            <span className="mt-1 block text-xs text-muted-foreground">
              {pluginText(schema.description, i18n.language)}
            </span>
          )}
        </span>
      </label>
    );
  const hintId = schema.description ? `${id}-hint` : undefined;
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {fieldLabel}
      </label>
      {schema.enum ? (
        <select
          id={id}
          disabled={disabled}
          value={
            value === undefined
              ? ""
              : String(schema.enum.findIndex((item) => pluginJsonEqual(item, value)))
          }
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : structuredClone(schema.enum![Number(event.target.value)])
            )
          }
          aria-describedby={hintId}
          className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
        >
          <option value="" disabled={required}>
            {t("common.choose")}
          </option>
          {schema.enum.map((item, index) => (
            <option key={index} value={index}>
              {formatEnum?.(item) ?? (typeof item === "string" ? item : JSON.stringify(item))}
            </option>
          ))}
        </select>
      ) : schema.type === "null" ? (
        <p className="text-sm text-muted-foreground">null</p>
      ) : (
        <Input
          id={id}
          type={
            schema.format === "date-time"
              ? "datetime-local"
              : schema.type === "number" || schema.type === "integer"
                ? "number"
                : "text"
          }
          value={
            schema.format === "date-time"
              ? dateTimeInput(value)
              : typeof value === "string" || typeof value === "number"
                ? value
                : ""
          }
          disabled={disabled}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.format === "date-time" ? 60 : schema.type === "integer" ? 1 : "any"}
          aria-describedby={hintId}
          onChange={(event) => {
            const text = event.target.value;
            if (schema.format === "date-time") {
              const iso = text ? dateTimeIso(text) : "";
              onInvalid(path, iso === undefined);
              if (iso !== undefined) onChange(iso);
            } else
              onChange(
                schema.type === "number" || schema.type === "integer"
                  ? text === ""
                    ? undefined
                    : Number(text)
                  : text
              );
          }}
        />
      )}
      {schema.description && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {pluginText(schema.description, i18n.language)}
        </p>
      )}
      {schema.format === "date-time" && (
        <p className="text-xs text-muted-foreground">{t("plugins.dateTimeHint")}</p>
      )}
    </div>
  );
}

/** Host-rendered controls only: plugin metadata can never provide HTML or executable UI. */
export default function PluginSchemaForm({
  schema,
  value,
  onChange,
  disabled,
  onInvalid,
  formatEnum,
}: {
  schema: PluginSchema;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  disabled?: boolean;
  formatEnum?: (value: JsonValue) => string | undefined;
  onInvalid: (path: string, invalid: boolean) => void;
}) {
  const { t } = useTranslation();
  if (schema.type === "object" && !Object.keys(schema.properties ?? {}).length)
    return <p className="text-sm text-muted-foreground">{t("plugins.noFields")}</p>;
  return (
    <SchemaField
      schema={schema}
      value={value}
      path="$"
      label={t("plugins.values")}
      disabled={disabled}
      onChange={(next) => onChange(next ?? pluginDefaults(schema))}
      formatEnum={formatEnum}
      onInvalid={onInvalid}
    />
  );
}
