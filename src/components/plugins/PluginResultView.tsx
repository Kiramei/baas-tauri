import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { pluginText, type JsonValue, type PluginSchema } from "@/shared/Plugins";

const isRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const printCell = (value: JsonValue | undefined): string =>
  value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value);

function ResultNode({
  value,
  schema,
  depth = 0,
}: {
  value: JsonValue;
  schema?: PluginSchema;
  depth?: number;
}) {
  const { t, i18n } = useTranslation();
  const label = (key: string, child?: PluginSchema) =>
    pluginText(child?.title, i18n.language) ||
    key.replace(/[_-]+/g, " ").replace(/^./u, (character) => character.toLocaleUpperCase());
  if (depth > 4 || value === null || typeof value !== "object")
    return <span className="whitespace-pre-wrap break-words text-sm">{printCell(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length && value.every(isRecord)) {
      const rows = value.slice(0, 200);
      const allColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const columns = allColumns.slice(0, 12);
      return (
        <div className="min-w-0 space-y-2">
          <div
            className="max-h-96 overflow-auto rounded-lg border border-border"
            tabIndex={0}
            role="region"
            aria-label={pluginText(schema?.title, i18n.language) || t("plugins.resultTable")}
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-background">
                <tr>
                  {columns.map((key) => (
                    <th
                      key={key}
                      scope="col"
                      className="min-w-24 border-b border-border px-3 py-2 font-medium"
                    >
                      {label(key, schema?.items?.properties?.[key])}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    {columns.map((key) => (
                      <td
                        key={key}
                        className="max-w-96 whitespace-pre-wrap break-words px-3 py-2 align-top"
                      >
                        {printCell(row[key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(value.length > rows.length || allColumns.length > columns.length) && (
            <p className="text-xs text-muted-foreground">{t("plugins.resultTruncated")}</p>
          )}
        </div>
      );
    }
    return (
      <ul className="min-w-0 space-y-2">
        {value.slice(0, 200).map((item, index) => (
          <li key={index} className="rounded-md border border-border px-3 py-2">
            <ResultNode value={item} schema={schema?.items} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="min-w-0 space-y-4">
      {Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => (
          <div key={key} className="min-w-0">
            <dt className="mb-1 break-words text-xs font-medium text-muted-foreground">
              {label(key, schema?.properties?.[key])}
            </dt>
            <dd className="min-w-0">
              <ResultNode value={item} schema={schema?.properties?.[key]} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}

/** JSON is rendered by host components only, without plugin-supplied markup, scripts or URLs. */
export default function PluginResultView({
  value,
  schema,
}: {
  value: JsonValue;
  schema?: PluginSchema;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const raw = JSON.stringify(value, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <div className="min-w-0 space-y-3" data-plugin-result>
      <ResultNode value={value} schema={schema} />
      <details className="min-w-0 rounded-lg border border-border bg-background p-3">
        <summary className="cursor-pointer text-xs font-medium">{t("plugins.rawResult")}</summary>
        <div className="mt-3 space-y-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
            {copied ? t("plugins.copied") : t("plugins.copyResult")}
          </Button>
          {copyFailed && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("plugins.copyFailed")}
            </p>
          )}
          <pre
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
            tabIndex={0}
          >
            {raw}
          </pre>
        </div>
      </details>
    </div>
  );
}
