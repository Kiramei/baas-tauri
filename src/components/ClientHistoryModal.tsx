import { useEffect, useId, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import ReleaseNotesContent from "@/components/ReleaseNotesContent";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { i18nKey } from "@/shared/I18nKeys";
import { Button } from "@/components/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import {
  currentClientRelease,
  loadClientReleaseHistory,
  type ClientReleaseResult,
} from "@/shared/ClientReleaseHistory";
import releaseNotes from "../../UPDATE.md?raw";

interface ClientHistoryModalProps {
  open: boolean;
  onClose: () => void;
}

const sourceLabels = {
  github: "clientHistory.source.github",
  cache: "clientHistory.source.cache",
  bundled: "clientHistory.source.bundled",
  current: "clientHistory.source.current",
} as const;

/** Published releases and an offline fallback share one surface on every platform. */
export default function ClientHistoryModal({ open, onClose }: ClientHistoryModalProps) {
  const { t, language } = useAppTranslation();
  const versionId = useId();
  const [history, setHistory] = useState<ClientReleaseResult>(() => ({
    snapshot: currentClientRelease(releaseNotes),
    source: "current",
  }));
  const [selectedTag, setSelectedTag] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    void loadClientReleaseHistory({
      currentMarkdown: releaseNotes,
      bundledUrl: `${import.meta.env.BASE_URL}client-release-history.json`,
      signal: controller.signal,
      onAvailable: (value) => {
        if (active) setHistory(value);
      },
    })
      .then((value) => {
        if (active) setHistory(value);
      })
      .catch(() => {
        // Closing the dialog aborts the in-flight request without a spurious toast.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, refresh]);
  const releases = history.snapshot.releases;
  const selected = releases.find(({ tag }) => tag === selectedTag) ?? releases[0];
  return (
    <Modal isOpen={open} onClose={onClose} title={t("clientHistory.title")} width={80}>
      <div className="flex min-h-0 flex-col gap-4">
        <p className="text-sm text-muted-foreground">{t("clientHistory.description")}</p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={versionId} className="block text-sm text-muted-foreground">
              {t("clientHistory.version")}
            </label>
            <Select value={selected?.tag ?? ""} onValueChange={setSelectedTag}>
              <SelectTrigger id={versionId} className="min-w-40 max-w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {releases.map((release) => (
                  <SelectItem key={release.tag} value={release.tag}>
                    {release.tag}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} />
            {loading ? t("clientHistory.refreshing") : t("clientHistory.refresh")}
          </Button>
        </div>
        <div role="status" className="space-y-1 text-xs text-muted-foreground">
          <p data-client-history-source={history.source}>
            {t(i18nKey(sourceLabels[history.source]))}
          </p>
          {history.unavailable && <p>{t("clientHistory.unavailable")}</p>}
          {!history.snapshot.complete && <p>{t("clientHistory.partial")}</p>}
        </div>
        <div
          data-client-history=""
          className="min-h-0 overflow-y-auto overscroll-contain pr-2"
          style={{
            maxHeight:
              "max(96px, min(58dvh, calc(var(--android-viewport-height, 100dvh) - var(--window-titlebar-height, 0px) - 340px)))",
          }}
        >
          {selected && (
            <div className="mb-4 space-y-1">
              <h3 className="text-lg font-semibold text-foreground [overflow-wrap:anywhere]">
                {selected.name}
              </h3>
              {selected.publishedAt && (
                <p className="text-xs text-muted-foreground">
                  {new Date(selected.publishedAt).toLocaleDateString(language)}
                </p>
              )}
            </div>
          )}
          {selected?.body ? (
            <ReleaseNotesContent markdown={selected.body} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("clientHistory.emptyNotes")}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
