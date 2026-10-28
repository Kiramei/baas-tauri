import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";
import PluginResultView from "./PluginResultView";
import HoardMailboxResult from "./HoardMailboxResult";
import {
  hoardFormatters,
  hoardHistory,
  hoardRecord,
  hoardResultDetails,
  type HoardMailSnapshot,
} from "@/shared/HoardMailbox";
import type { JsonValue } from "@/shared/Plugins";

export default function HoardExecutionResult({
  value,
  snapshot,
}: {
  value: Record<string, JsonValue>;
  snapshot: HoardMailSnapshot;
}) {
  const { t, i18n } = useTranslation();
  const { number, time } = hoardFormatters(i18n.resolvedLanguage || i18n.language);
  const steps = Array.isArray(value.steps)
    ? value.steps.filter(hoardRecord).filter((step) => step.verified === true)
    : [];
  const history = hoardHistory(value, steps.length);
  const labels: Record<string, string> = {
    clear: t("plugins.hoardPlan.actions.clear"),
    spend: t("plugins.hoardPlan.actions.spend"),
    daily: t("plugins.hoardPlan.actions.daily"),
    free: t("plugins.hoardPlan.actions.free"),
    jjc: t("plugins.hoardPlan.actions.jjc"),
    club: t("plugins.hoardPlan.actions.club"),
    cafe: t("plugins.hoardPlan.actions.cafe"),
    mail: t("plugins.hoardPlan.actions.mail"),
    ready: t("plugins.hoardPlan.actions.ready"),
    scan_mail: t("plugins.hoardMail.title"),
  };
  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={t("plugins.hoardExecution.title")}
      data-hoard-execution
    >
      <div className="rounded-lg border border-border bg-card p-3">
        <h3 className="flex items-start gap-2 text-sm font-medium">
          <CheckCircle2
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {t("plugins.hoardExecution.title")}
        </h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {t("plugins.hoardExecution.actualOnly")}
        </p>
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        {[
          [t("plugins.hoardMail.character"), value.actual_ap],
          [t("plugins.hoardMail.mailAp"), value.actual_mail_ap],
          [t("plugins.hoardExecution.total"), value.actual_total_ap],
        ].map(([label, amount]) => (
          <div key={String(label)} className="min-w-0 rounded-lg border border-border p-3">
            <dt className="break-words text-xs text-muted-foreground">{String(label)}</dt>
            <dd className="mt-1 break-words font-medium tabular-nums">{number(amount)}</dd>
          </div>
        ))}
      </dl>
      <div
        className="max-h-96 min-w-0 max-w-full overflow-auto rounded-lg border border-border"
        role="region"
        aria-label={t("plugins.hoardExecution.steps")}
        tabIndex={0}
      >
        <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
          <caption className="sr-only">{t("plugins.hoardExecution.steps")}</caption>
          <thead className="sticky top-0 bg-card">
            <tr>
              {[
                t("plugins.hoardPlan.time"),
                t("plugins.hoardExecution.action"),
                t("plugins.hoardPlan.change"),
                t("plugins.hoardPlan.after"),
                t("plugins.hoardPlan.mailAfter"),
              ].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b border-border px-3 py-2 font-medium"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => (
              <tr key={index} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-3 py-2 align-top">{time(step.at)}</td>
                <td className="px-3 py-2 align-top">
                  {typeof step.action === "string" && Object.hasOwn(labels, step.action)
                    ? labels[step.action]
                    : t("plugins.hoardExecution.otherStep")}
                </td>
                <td className="px-3 py-2 align-top tabular-nums">
                  {step.action === "ready"
                    ? "—"
                    : step.delivery === "mail"
                      ? t("plugins.hoardExecution.mailDelivery", { amount: number(step.amount) })
                      : `${step.action === "clear" || step.action === "spend" ? "−" : "+"}${number(step.amount)}`}
                </td>
                <td className="px-3 py-2 align-top tabular-nums">
                  {number(step.ap_after ?? step.ap)}
                </td>
                <td className="px-3 py-2 align-top tabular-nums">{number(step.mail_ap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Array.isArray(value.steps) && steps.length !== value.steps.length && (
        <p className="text-xs text-muted-foreground">
          {t("plugins.hoardExecution.unverifiedHidden")}
        </p>
      )}
      {history.truncated && (
        <p className="text-xs text-muted-foreground" data-hoard-history-limit>
          {t("plugins.hoardExecution.history", history)}
        </p>
      )}
      <HoardMailboxResult snapshot={snapshot} raw={false} afterExecution />
      {value.plan !== undefined && (
        <details className="min-w-0 rounded-lg border border-border p-3" data-hoard-initial-plan>
          <summary className="cursor-pointer text-xs font-medium">
            {t("plugins.hoardExecution.initialPlan")}
          </summary>
          <p className="my-2 text-xs text-muted-foreground">
            {t("plugins.hoardPlan.estimateOnly")}
          </p>
          {hoardRecord(value.plan) && value.plan.steps_omitted === true && (
            <p className="mb-2 text-xs text-muted-foreground">
              {t("plugins.hoardExecution.initialOmitted")}
            </p>
          )}
          <PluginResultView value={hoardResultDetails(value.plan)} />
        </details>
      )}
      <details className="min-w-0 rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-xs font-medium">{t("plugins.rawResult")}</summary>
        <div className="mt-3 min-w-0">
          <PluginResultView value={hoardResultDetails(value)} />
        </div>
      </details>
    </section>
  );
}
