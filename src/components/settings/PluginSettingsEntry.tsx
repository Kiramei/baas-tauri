import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SettingsGroup } from "./SettingsControls";
import { PLUGIN_OPEN_EVENT } from "@/shared/Plugins";
import { useAppTranslation } from "@/shared/useAppTranslation";

/** Keep the mobile launcher shared by the browser and native Android settings. */
export function PluginSettingsEntry() {
  const { t } = useAppTranslation();
  return (
    <div className={__WITH_ANDROID__ ? undefined : "lg:hidden"} data-mobile-plugin-entry>
      <SettingsGroup title={t("plugins.title")}>
        <div className="settings-block">
          <p className="settings-description">{t("plugins.description")}</p>
          <Button
            variant="outline"
            className="mt-3 max-w-full whitespace-normal text-left"
            onClick={() => window.dispatchEvent(new Event(PLUGIN_OPEN_EVENT))}
          >
            {t("plugins.open")}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}
