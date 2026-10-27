import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
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
  onInvalid: (path: string, invalid: boolean) => void;
}

function ArrayField({ schema, value, onChange, path, label, disabled, onInvalid }: FieldProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? [], null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Textarea
        id={id}
        value={raw}
        disabled={disabled}
        rows={4}
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        className="font-mono text-xs"
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (!Array.isArray(parsed)) throw new Error();
            setInvalid(false);
            onInvalid(path, false);
            onChange(parsed as JsonValue[]);
          } catch {
            setInvalid(true);
            onInvalid(path, true);
          }
        }}
      />
      <p className="text-xs text-muted-foreground">
        {pluginText(schema.description, i18n.language) || t("plugins.arrayHint")}
      </p>
      {invalid && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {t("plugins.invalidJson")}
        </p>
      )}
    </div>
  );
}

function SchemaField(props: FieldProps) {
  const { schema, value, onChange, path, label, required, disabled, onInvalid } = props;
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
              {typeof item === "string" ? item : JSON.stringify(item)}
            </option>
          ))}
        </select>
      ) : schema.type === "null" ? (
        <p className="text-sm text-muted-foreground">null</p>
      ) : (
        <Input
          id={id}
          type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          disabled={disabled}
          min={schema.minimum}
          max={schema.maximum}
          step={schema.type === "integer" ? 1 : "any"}
          aria-describedby={hintId}
          onChange={(event) =>
            onChange(
              schema.type === "number" || schema.type === "integer"
                ? event.target.value === ""
                  ? undefined
                  : Number(event.target.value)
                : event.target.value
            )
          }
        />
      )}
      {schema.description && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {pluginText(schema.description, i18n.language)}
        </p>
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
}: {
  schema: PluginSchema;
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  disabled?: boolean;
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
      onInvalid={onInvalid}
    />
  );
}
