import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { resolveClientVersion } from "@/shared/ClientVersion";
import { useWebSocketStore } from "@/store/WebsocketStore";

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
  const authPhase = useWebSocketStore((state) => state._auth_phase);
  const connected = useWebSocketStore(
    (state) =>
      state._auth_phase === "authenticated" &&
      state.connections.provider?.readyState === 1 &&
      state.connections.sync?.readyState === 1
  );

  const clientVersion = resolveClientVersion(versions.tauri?.currentVersion);
  const commit =
    typeof versions.local === "string" && /^[0-9a-f]{7,64}$/i.test(versions.local)
      ? versions.local.slice(0, 12)
      : t("about.unavailable");
  const connectionStatus = connected
    ? t("heartbeat.connected")
    : authPhase === "idle" || authPhase === "revoked"
      ? t("about.disconnected")
      : t("heartbeat.connecting");
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
    { label: t("about.connectionStatus"), value: connectionStatus },
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
            { label: t("about.frontendProject"), url: frontendProjectUrl },
            { label: t("about.scriptProject"), url: scriptProjectUrl },
          ].map(({ label, url }) => (
            <button
              key={url}
              type="button"
              onClick={() => void openProject(url)}
              className="flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span>{label}</span>
              <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
