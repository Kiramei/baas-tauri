import { useTranslation } from "react-i18next";
import { ExternalLink, History } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { resolveClientVersion } from "@/shared/ClientVersion";
import { openDocumentation } from "@/shared/Documentation";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { formatBackendConnectionStatus } from "@/shared/BackendConnectionStatus";
import { useBackendConnectionStatus } from "@/shared/useBackendConnectionStatus";
import { useClientHistory } from "@/context/AboutBaasProvider";

const frontendProjectUrl = "https://github.com/Kiramei/baas-tauri";
const scriptProjectUrl = "https://github.com/pur1fying/blue_archive_auto_script";

interface AboutBaasModalProps {
  open: boolean;
  onClose: () => void;
}

export default function AboutBaasModal({ open, onClose }: AboutBaasModalProps) {
  const { t } = useTranslation();
  const versions = useWebSocketStore((state) => state.versionStore);
  const transportMode = useWebSocketStore((state) => state.transportMode);
  const backendStatus = useBackendConnectionStatus();
  const openHistory = useClientHistory();

  const clientVersion = resolveClientVersion(versions.tauri?.currentVersion);
  const commit =
    typeof versions.local === "string" && /^[0-9a-f]{7,64}$/i.test(versions.local)
      ? versions.local.slice(0, 12)
      : t("about.unavailable");
  const connectionStatus = formatBackendConnectionStatus(backendStatus, t);
  const transportName = {
    websocket: t("transport.websocket"),
    pipe: t("transport.pipe"),
    shm: t("transport.shm"),
  }[transportMode];

  const openProject = async (url: string) => {
    try {
      if (__WITH_TAURI__) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.warn("[about] failed to open project link", error);
      toast.error(t("about.openLinkFailed"));
    }
  };

  const details = [
    { label: t("about.clientVersion"), value: clientVersion },
    { label: t("about.backendCommit"), value: commit },
    { label: t("about.connectionMethod"), value: transportName },
    { label: t("about.license"), value: "GPL-3.0-only" },
  ];

  return (
    <Modal isOpen={open} onClose={onClose} title={t("about.title")}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <img
            src="/images/logo.png"
            alt=""
            draggable={false}
            className="size-12 shrink-0 object-contain"
          />
          <div className="min-w-0">
            <div className="text-xl font-semibold text-foreground">BAAS</div>
            <div className="mt-0.5 text-sm text-muted-foreground">Blue Archive Auto Script</div>
          </div>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{t("about.description")}</p>
        <div className="flex items-center justify-between gap-6 rounded-xl bg-secondary px-3.5 py-3 text-sm">
          <span className="text-muted-foreground">{t("about.connectionStatus")}</span>
          <span className="flex min-w-0 items-center gap-2 text-foreground">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  backendStatus === "connected" ? "#30a46c" : "var(--muted-foreground)",
              }}
            />
            {connectionStatus}
          </span>
        </div>
        <dl className="space-y-3 text-sm">
          {details.map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-6">
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 text-right text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="space-y-1 border-t border-border pt-3">
          {[
            {
              id: "client-history",
              label: t("clientHistory.title"),
              onOpen: openHistory,
            },
            {
              id: "documentation",
              label: t("help.documentation"),
              onOpen: () => {
                void openDocumentation().catch((error: unknown) => {
                  console.error("[about] failed to open documentation:", error);
                  toast.error(t("help.openFailed"));
                });
              },
            },
            {
              id: frontendProjectUrl,
              label: t("about.frontendProject"),
              onOpen: () => void openProject(frontendProjectUrl),
            },
            {
              id: scriptProjectUrl,
              label: t("about.scriptProject"),
              onOpen: () => void openProject(scriptProjectUrl),
            },
          ].map(({ id, label, onOpen }) => (
            <button
              key={id}
              type="button"
              onClick={onOpen}
              className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span>{label}</span>
              {id === "client-history" ? (
                <History className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ExternalLink
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
