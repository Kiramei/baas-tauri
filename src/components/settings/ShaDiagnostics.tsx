import { useId } from "react";
import { CheckCircle2, ChevronDown, Loader2, Minus, TestTube, XCircle } from "lucide-react";
import CButton from "@/components/ui/CButton";
import { EllipsisWithTooltip } from "@/components/ui/ETooltip";
import { FormSelect } from "@/components/ui/FormSelect";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { i18nKey } from "@/shared/I18nKeys";
import type { TranslationKey } from "@/types/i18n";
import "./sha-diagnostics.css";

export type ShaDiagnosticResult = {
  method: TranslationKey;
  status: "pending" | "success" | "error" | "testing";
  time?: string;
  sha?: string;
};

type ShaDiagnosticsProps = {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  loading: boolean;
  onTest: () => void;
  results: readonly ShaDiagnosticResult[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

/** Presents SHA diagnostics without changing the owning page's test lifecycle. */
export function ShaDiagnostics({
  value,
  options,
  onChange,
  loading,
  onTest,
  results,
  expanded,
  onExpandedChange,
}: ShaDiagnosticsProps) {
  const { t } = useAppTranslation();
  const resultsId = useId();
  const resultsLabelId = useId();
  const completed = results.filter(
    ({ status }) => status === "success" || status === "error"
  ).length;

  return (
    <div className="sha-diagnostics">
      <div className="sha-diagnostics-toolbar">
        <FormSelect
          value={value}
          options={options}
          onChange={onChange}
          ariaLabel={t("update.shaConnectivityTest")}
          className="sha-diagnostics-method"
        />
        <CButton
          type="button"
          variant="secondary"
          className="sha-diagnostics-test"
          onClick={onTest}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="sha-diagnostics-icon animate-spin" aria-hidden="true" />
          ) : (
            <TestTube className="sha-diagnostics-icon" aria-hidden="true" />
          )}
          {loading ? t("shaTest.testing") : t("shaTest.testAll")}
        </CButton>
      </div>

      <button
        type="button"
        className="sha-diagnostics-results-toggle"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls={resultsId}
      >
        <span id={resultsLabelId}>{t("shaTest.results")}</span>
        <span className="sha-diagnostics-count">
          {completed}/{results.length}
        </span>
        <ChevronDown
          className={`sha-diagnostics-chevron ${expanded ? "sha-diagnostics-chevron-expanded" : ""}`}
          aria-hidden="true"
        />
      </button>

      <div
        id={resultsId}
        className="sha-diagnostics-table-scroll"
        hidden={!expanded}
        role="region"
        aria-labelledby={resultsLabelId}
        tabIndex={expanded ? 0 : undefined}
      >
        <table className="sha-diagnostics-table" aria-labelledby={resultsLabelId}>
          <colgroup>
            <col />
            <col className="sha-diagnostics-status-column" />
            <col className="sha-diagnostics-time-column" />
            <col className="sha-diagnostics-sha-column" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">{t("shaTest.method")}</th>
              <th scope="col">{t("shaTest.status")}</th>
              <th scope="col">{t("shaTest.time")}</th>
              <th scope="col">{t("shaTest.sha")}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => (
              <tr key={result.method}>
                <td>
                  <EllipsisWithTooltip text={t(i18nKey(result.method))} />
                </td>
                <td className="sha-diagnostics-status" data-status={result.status}>
                  {result.status === "success" && <CheckCircle2 aria-hidden="true" />}
                  {result.status === "error" && <XCircle aria-hidden="true" />}
                  {result.status === "testing" && (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  )}
                  {result.status === "pending" && <Minus aria-hidden="true" />}
                  <span className="sr-only">
                    {result.status === "success"
                      ? "✓"
                      : result.status === "error"
                        ? "×"
                        : result.status === "testing"
                          ? t("shaTest.testing")
                          : "—"}
                  </span>
                </td>
                <td className="sha-diagnostics-numeric font-mono">{result.time ?? "—"}</td>
                <td className="sha-diagnostics-numeric font-mono">
                  {result.sha ? (
                    <EllipsisWithTooltip text={result.sha.substring(0, 6)} tooltip={result.sha} />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
