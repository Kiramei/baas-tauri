import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import PluginResultView from "@/components/plugins/PluginResultView";
import type { JsonValue } from "@/shared/Plugins";

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Estimates only: a successful plan job has not performed any game action. */
export default function HoardToolResult({ value }: { value: JsonValue }) {
  const { t, i18n } = useTranslation();
  if (!isRecord(value) || typeof value.executable !== "boolean" || !Array.isArray(value.steps)) {
    return <PluginResultView value={value} />;
  }

  const locale = i18n.resolvedLanguage || i18n.language;
  const numberFormatter = new Intl.NumberFormat(locale);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const number = (input: JsonValue | undefined) =>
    typeof input === "number" && Number.isFinite(input) && input >= 0
      ? numberFormatter.format(input)
      : "—";
  const localTime = (input: JsonValue | undefined) => {
    if (typeof input !== "string") return "—";
    const date = new Date(input);
    return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "—";
  };
  const actionLabels: Record<string, string> = {
    clear: t("plugins.hoardPlan.actions.clear"),
    manual_purchase: t("plugins.hoardPlan.actions.manualPurchase"),
    free: t("plugins.hoardPlan.actions.free"),
    daily: t("plugins.hoardPlan.actions.daily"),
    club: t("plugins.hoardPlan.actions.club"),
    jjc: t("plugins.hoardPlan.actions.jjc"),
    cafe: t("plugins.hoardPlan.actions.cafe"),
    mail: t("plugins.hoardPlan.actions.mail"),
    ready: t("plugins.hoardPlan.actions.ready"),
    spend: t("plugins.hoardPlan.actions.spend"),
    manual_mail: t("plugins.hoardPlan.actions.manualMail"),
  };
  const warningLabels: Record<string, string> = {
    CLUB_REWARD_REQUIRES_MAIL_VERIFICATION: t("plugins.hoardPlan.warnings.clubMail"),
    PREMIUM_PURCHASES_ARE_MANUAL: t("plugins.hoardPlan.warnings.premium"),
    OVERFLOW_REQUIRES_MAIL_VERIFICATION: t("plugins.hoardPlan.warnings.overflow"),
    MAIL_REQUIRES_SELECTIVE_COLLECTION: t("plugins.hoardPlan.warnings.selective"),
    CAFE_CAPACITY_LOSS: t("plugins.hoardPlan.warnings.cafeCapacity"),
    MAIL_IS_COLLECTED_AS_A_WHOLE: t("plugins.hoardPlan.warnings.wholeMailbox"),
  };
  const warnings = Array.isArray(value.warnings)
    ? [...new Set(value.warnings.filter((item): item is string => typeof item === "string"))]
    : [];
  const assets = isRecord(value.available_at_target) ? value.available_at_target : undefined;
  const assetLabels = [
    ["character_ap", t("plugins.hoardPlan.character")],
    ["cafe_ap", t("plugins.hoardPlan.cafe")],
    ["mail_ap", t("plugins.hoardPlan.mail")],
    ["total_ap", t("plugins.hoardPlan.total")],
  ];
  const steps = value.steps.filter(isRecord).slice(0, 200);
  const StatusIcon = value.executable ? CheckCircle2 : AlertCircle;

  return (
    <section
      className="min-w-0 space-y-4"
      aria-label={t("plugins.hoardPlan.title")}
      data-hoard-plan
    >
      <div className="min-w-0 rounded-lg border border-border bg-card p-3">
        <div className="flex items-start gap-2">
          <StatusIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="break-words text-sm font-medium">
              {value.executable ? t("plugins.hoardPlan.executable") : t("plugins.hoardPlan.manual")}
            </h3>
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {t("plugins.hoardPlan.estimateOnly")}
            </p>
          </div>
        </div>
      </div>

      <div className="min-w-0 space-y-2">
        <h4 className="break-words text-sm font-medium">
          {t("plugins.hoardPlan.available", { time: localTime(value.target_at) })}
        </h4>
        {assets ? (
          <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {assetLabels.map(([key, label]) => (
              <div key={key} className="min-w-0 rounded-lg border border-border bg-card p-3">
                <dt className="break-words text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words text-base font-medium tabular-nums">
                  {number(assets[key])}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="break-words text-xs text-muted-foreground">
            {t("plugins.hoardPlan.targetIncomplete")}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("plugins.hoardPlan.localTime")}</p>
      </div>

      {warnings.length > 0 && (
        <ul className="list-inside list-disc space-y-1 rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed">
          {warnings.map((warning) => (
            <li key={warning} className="break-words">
              {Object.hasOwn(warningLabels, warning)
                ? warningLabels[warning]
                : t("plugins.hoardPlan.unknownWarning")}
            </li>
          ))}
        </ul>
      )}

      {steps.length > 0 ? (
        <div
          className="max-h-96 min-w-0 max-w-full overflow-auto rounded-lg border border-border"
          role="region"
          aria-label={t("plugins.hoardPlan.timeline")}
          tabIndex={0}
        >
          <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
            <caption className="sr-only">{t("plugins.hoardPlan.timeline")}</caption>
            <thead className="sticky top-0 bg-card">
              <tr>
                {[
                  t("plugins.hoardPlan.time"),
                  t("plugins.hoardPlan.action"),
                  t("plugins.hoardPlan.change"),
                  t("plugins.hoardPlan.after"),
                  t("plugins.hoardPlan.mailAfter"),
                ].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="border-b border-border px-3 py-2 font-medium"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {steps.map((step, index) => {
                const action = typeof step.action === "string" ? step.action : "";
                const sign = action === "clear" || action === "spend" ? "−" : "+";
                const amount = number(step.amount);
                return (
                  <tr key={index} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 align-top">{localTime(step.at)}</td>
                    <td className="max-w-56 break-words px-3 py-2 align-top">
                      {Object.hasOwn(actionLabels, action)
                        ? actionLabels[action]
                        : t("plugins.hoardPlan.unknownAction")}
                    </td>
                    <td className="px-3 py-2 align-top tabular-nums">
                      {action === "ready" || amount === "—"
                        ? "—"
                        : step.delivery === "mail" || action === "club"
                          ? t("plugins.hoardPlan.mailDelivery", { amount })
                          : `${sign}${amount}`}
                    </td>
                    <td className="px-3 py-2 align-top tabular-nums">{number(step.ap_after)}</td>
                    <td className="px-3 py-2 align-top tabular-nums">{number(step.mail_ap)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("plugins.hoardPlan.noSteps")}</p>
      )}
      {value.steps.length > steps.length && (
        <p className="text-xs text-muted-foreground">{t("plugins.hoardPlan.truncated")}</p>
      )}

      <details className="min-w-0 rounded-lg border border-border p-3" data-hoard-details>
        <summary className="cursor-pointer text-xs font-medium">
          {t("plugins.hoardPlan.fullData")}
        </summary>
        <div className="mt-3 min-w-0">
          <PluginResultView value={value} />
        </div>
      </details>
    </section>
  );
}
