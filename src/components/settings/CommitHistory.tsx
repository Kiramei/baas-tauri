import { useEffect, useRef, useState } from "react";
import { History, Loader2, RefreshCw } from "lucide-react";
import CButton from "@/components/ui/CButton";
import { Modal } from "@/components/ui/Modal";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  parseCommitHistory,
  requestWebCommitHistory,
  type CommitHistoryEntry,
  type CommitHistoryReport,
} from "@/shared/CommitHistory";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { i18nKey } from "@/shared/I18nKeys";
import "./commit-history.css";

const sourceLabels = {
  github: i18nKey("commitHistory.source.github"),
  local: i18nKey("commitHistory.source.local"),
  bundle: i18nKey("commitHistory.source.bundle"),
  cache: i18nKey("commitHistory.source.cache"),
};
const issueLabels = {
  offline: i18nKey("commitHistory.issue.offline"),
  rate_limited: i18nKey("commitHistory.issue.rateLimited"),
  unavailable: i18nKey("commitHistory.issue.unavailable"),
};

function CommitHistoryDialog({
  channel,
  onClose,
}: {
  channel: "stable" | "dev";
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [report, setReport] = useState<CommitHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<CommitHistoryEntry | null>(null);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);

  const load = async (limit: number, refresh: boolean) => {
    if (pending.current !== null) return;
    const run = ++generation.current;
    pending.current = run;
    setLoading(true);
    setFailed(false);
    try {
      const request = { channel, limit, refresh };
      const next = __WITH_TAURI__
        ? parseCommitHistory(
            await (
              await import("@/shared/TauriInvoke")
            ).invoke("updater_get_commit_history", {
              request,
            })
          )
        : await requestWebCommitHistory(useWebSocketStore.getState, request);
      if (generation.current === run) setReport(next);
    } catch {
      if (generation.current === run) setFailed(true);
    } finally {
      if (pending.current === run) pending.current = null;
      if (generation.current === run) setLoading(false);
    }
  };

  useEffect(() => {
    void load(100, false);
    return () => {
      generation.current++;
      pending.current = null;
    };
    // A dialog instance belongs to one update channel and is recreated when it changes.
  }, []);

  return (
    <Modal isOpen onClose={onClose} title={t("commitHistory.title")} width={82}>
      <div className="commit-history" aria-busy={loading}>
        <p className="text-sm text-muted-foreground">{t("commitHistory.description")}</p>
        {report && (
          <div className="commit-history-provenance text-xs text-muted-foreground">
            <span>
              {report.repository} · {report.reference}
            </span>
            <span>{t(i18nKey(sourceLabels[report.source]))}</span>
          </div>
        )}
        <div role="status" className="text-xs text-muted-foreground space-y-1">
          {loading && <p>{t("commitHistory.loading")}</p>}
          {report?.stale && <p>{t("commitHistory.stale")}</p>}
          {report?.partial && <p>{t("commitHistory.partial")}</p>}
          {report?.issue && <p>{t(i18nKey(issueLabels[report.issue]))}</p>}
          {report?.hasMore && report.entries.length >= 500 && <p>{t("commitHistory.limit")}</p>}
          {failed && <p className="text-destructive">{t("commitHistory.failed")}</p>}
        </div>
        {report && report.entries.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">{t("commitHistory.mobileHint")}</p>
            <div
              className="commit-history-scroll"
              tabIndex={0}
              aria-label={t("commitHistory.title")}
            >
              <table className="commit-history-table">
                <caption className="sr-only">{t("commitHistory.title")}</caption>
                <colgroup>
                  <col className="commit-history-hash" />
                  <col className="commit-history-author" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Hash</th>
                    <th scope="col">{t("commitHistory.author")}</th>
                    <th scope="col">{t("commitHistory.message")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.entries.map((entry) => (
                    <tr key={entry.hash} data-current={entry.hash === report.current || undefined}>
                      <td className="font-mono" title={entry.hash}>
                        {entry.hash.slice(0, 6)}
                        {entry.hash === report.current && (
                          <span className="sr-only"> {t("commitHistory.current")}</span>
                        )}
                      </td>
                      <td title={entry.author}>{entry.author}</td>
                      <td>
                        <button
                          type="button"
                          className="commit-history-message"
                          title={entry.message}
                          onClick={() => setSelected(entry)}
                        >
                          {entry.message || t("commitHistory.emptyMessage")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected && (
              <div key={selected.hash} className="commit-history-detail" role="status">
                <p>{selected.message || t("commitHistory.emptyMessage")}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{selected.hash.slice(0, 6)}</span> · {selected.author}
                </p>
              </div>
            )}
          </>
        ) : report && !loading ? (
          <p className="text-sm text-muted-foreground">{t("commitHistory.empty")}</p>
        ) : null}
        <div className="commit-history-actions">
          <CButton
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => void load(report?.entries.length || 100, true)}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-4" aria-hidden />
            )}
            {t("commitHistory.refresh")}
          </CButton>
          {report?.hasMore && report.entries.length < 500 && (
            <CButton
              type="button"
              variant="secondary"
              disabled={loading}
              onClick={() => void load(Math.min(500, report.entries.length + 100), false)}
            >
              {t("commitHistory.more")}
            </CButton>
          )}
          <CButton type="button" onClick={onClose}>
            {t("common.close")}
          </CButton>
        </div>
      </div>
    </Modal>
  );
}

/** Shared by desktop, Android and authenticated WebUI settings. */
export function CommitHistorySettings({ channel }: { channel: string }) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const normalized = channel === "dev" ? "dev" : "stable";
  return (
    <SettingsGroup title={t("commitHistory.title")}>
      <SettingsRow label={t("commitHistory.title")} description={t("commitHistory.description")}>
        <CButton type="button" variant="secondary" onClick={() => setOpen(true)}>
          <History className="size-4" aria-hidden />
          {t("commitHistory.view")}
        </CButton>
      </SettingsRow>
      {open && (
        <CommitHistoryDialog key={normalized} channel={normalized} onClose={() => setOpen(false)} />
      )}
    </SettingsGroup>
  );
}
