import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import PluginResultView from "./PluginResultView";
import { hoardFormatters, hoardResultDetails, type HoardMailSnapshot } from "@/shared/HoardMailbox";

export default function HoardMailboxResult({
  snapshot,
  raw = true,
  afterExecution = false,
}: {
  snapshot: HoardMailSnapshot;
  raw?: boolean;
  afterExecution?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { number, time } = hoardFormatters(i18n.resolvedLanguage || i18n.language);
  const counts = [
    [t("plugins.hoardMail.character"), snapshot.character_ap],
    [t("plugins.hoardMail.mailboxCount"), snapshot.mailbox_count],
    [t("plugins.hoardMail.apLetters"), snapshot.parcels.length],
    [t("plugins.hoardMail.mailAp"), snapshot.total_ap],
  ] as const;
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={t("plugins.hoardMail.title")}
      data-hoard-mail
    >
      <div className="min-w-0 rounded-lg border border-border bg-card p-3">
        <h3 className="flex items-start gap-2 text-sm font-medium">
          <ShieldCheck
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {t("plugins.hoardMail.title")}
        </h3>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {t("plugins.hoardMail.observed", { time: time(snapshot.observed_at) })}
        </p>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {afterExecution
            ? t("plugins.hoardExecution.finalMailbox")
            : t("plugins.hoardMail.complete")}
        </p>
      </div>
      <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
        {counts.map(([label, amount]) => (
          <div key={label} className="min-w-0 rounded-lg border border-border p-3">
            <dt className="break-words text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-medium tabular-nums">{number(amount)}</dd>
          </div>
        ))}
      </dl>
      {snapshot.parcels.some(
        (parcel) => Date.parse(parcel.expires_at) <= Date.parse(snapshot.observed_at)
      ) && (
        <p
          role="status"
          className="break-words rounded-lg border border-border p-3 text-xs font-medium text-amber-600 dark:text-amber-400"
        >
          {t("plugins.hoardMail.urgent")}
        </p>
      )}
      {snapshot.parcels.length ? (
        <div
          className="max-h-96 min-w-0 max-w-full overflow-auto rounded-lg border border-border"
          role="region"
          aria-label={t("plugins.hoardMail.letters")}
          tabIndex={0}
        >
          <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
            <caption className="sr-only">{t("plugins.hoardMail.letters")}</caption>
            <thead className="sticky top-0 bg-card">
              <tr>
                {[
                  t("plugins.hoardMail.letter"),
                  t("plugins.hoardMail.received"),
                  t("plugins.hoardMail.mailAp"),
                  t("plugins.hoardMail.expiry"),
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
              {snapshot.parcels.map((parcel, index) => {
                const urgent = Date.parse(parcel.expires_at) <= Date.parse(snapshot.observed_at);
                return (
                  <tr key={parcel.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 align-top tabular-nums">{number(index + 1)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">{parcel.received_at}</td>
                    <td className="px-3 py-2 align-top tabular-nums">{number(parcel.amount)}</td>
                    <td className="min-w-56 px-3 py-2 align-top">
                      {urgent && (
                        <p className="mb-1 font-medium text-amber-600 dark:text-amber-400">
                          {t("plugins.hoardMail.urgent")}
                        </p>
                      )}
                      <p>
                        {t("plugins.hoardMail.expiryRange", {
                          earliest: time(parcel.expires_at),
                          latest: time(parcel.expires_before),
                        })}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("plugins.hoardMail.empty")}</p>
      )}
      <p className="break-words text-xs text-muted-foreground">
        {t("plugins.hoardMail.expiryHint")}
      </p>
      {raw && (
        <details className="min-w-0 rounded-lg border border-border p-3">
          <summary className="cursor-pointer text-xs font-medium">{t("plugins.rawResult")}</summary>
          <div className="mt-3 min-w-0">
            <PluginResultView value={hoardResultDetails(snapshot)} />
          </div>
        </details>
      )}
    </section>
  );
}
