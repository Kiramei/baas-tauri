import React, { useMemo } from "react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  ConfigurationGroup,
  ConfigurationInput,
  ConfigurationRow,
  ConfigurationSelect,
} from "@/components/configuration/ConfigurationControls";
import { FormInput } from "@/components/ui/FormInput";
import ADBSeekModal from "@/components/ADBSeekModal";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { buildServerOptions, isPcServer, supportsPcServers } from "@/shared/serverOptions";
import { serverMap } from "@/shared/GlobalUtilities";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";

interface ServerConfigProps {
  profileId: string;
  onClose: () => void;
}
interface Draft {
  server: string;
  adbIP: string;
  adbPort: string;
}

const ServerConfig: React.FC<ServerConfigProps> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const processNames = useWebSocketStore(
    (state) => state.staticStore.PC_app_process_name?.[serverMap[settings.server]]
  );
  const pcProfile = isPcServer(settings.server);
  const initial = useMemo<Draft>(
    () => ({
      server: settings.server,
      adbIP: settings.adbIP,
      adbPort: String(settings.adbPort ?? ""),
    }),
    [settings]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "server", initial, {
    serialize: (value) => {
      if (isPcServer(value.server)) return { server: value.server };
      const address = value.adbIP.trim();
      const portText = value.adbPort.trim();
      if (!address && !portText) return null;
      // One populated field is an ADB/USB device serial; both fields form host:port.
      if (address && portText) {
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
        return { server: value.server, adbIP: address, adbPort: String(port) };
      }
      return { server: value.server, adbIP: address, adbPort: portText };
    },
  });

  return (
    <ConfigurationGroup title={t("server")}>
      <ConfigurationSelect
        label={t("server.server")}
        description={t("configurationHelp.server")}
        value={draft.server}
        disabled
        onChange={() => {}}
        options={buildServerOptions(t, {
          includePc: supportsPcServers(),
          selected: settings.server,
        })}
      />
      {pcProfile ? (
        <ConfigurationRow
          label={t("server.pcGameWindow")}
          description={supportsPcServers() ? t("server.pcWindowHelp") : t("server.pcWindowsOnly")}
        >
          <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
            {Array.isArray(processNames)
              ? processNames.join(" / ")
              : typeof processNames === "string"
                ? processNames
                : t("server.pcAutomaticWindow")}
          </span>
        </ConfigurationRow>
      ) : (
        <>
          <ConfigurationInput
            label={t("server.adbIP")}
            description={t("configurationHelp.adbAddress")}
            value={draft.adbIP}
            onChange={(event) => setDraft((value) => ({ ...value, adbIP: event.target.value }))}
            placeholder="127.0.0.1"
          />
          <ConfigurationRow
            label={t("server.adbPort")}
            description={t("configurationHelp.adbPort")}
          >
            <div className="flex min-w-0 items-center gap-2">
              <FormInput
                type={draft.adbIP.trim() ? "number" : "text"}
                aria-label={t("server.adbPort")}
                value={draft.adbPort}
                onChange={(event) =>
                  setDraft((value) => ({ ...value, adbPort: event.target.value }))
                }
                min={0}
                max={65535}
                className="min-w-0 flex-1"
              />
              <ADBSeekModal
                onSelect={(address) => {
                  const separator = address.lastIndexOf(":");
                  if (separator < 0) {
                    setDraft((value) => ({ ...value, adbIP: address, adbPort: "" }));
                    return;
                  }
                  setDraft((value) => ({
                    ...value,
                    adbIP: address.slice(0, separator),
                    adbPort: address.slice(separator + 1),
                  }));
                }}
              />
            </div>
          </ConfigurationRow>
        </>
      )}
    </ConfigurationGroup>
  );
};
export default ServerConfig;
