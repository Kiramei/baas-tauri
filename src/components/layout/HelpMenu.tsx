import { toast } from "sonner";
import type { TitlebarMenuEntry } from "./TitlebarMenu";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { openDocumentation } from "@/shared/Documentation";
import { useAboutBaas, useClientHistory } from "@/context/AboutBaasProvider";

/** Both titlebar layouts invoke the same help actions and shared dialogs. */
export function useHelpMenuEntries(): TitlebarMenuEntry[] {
  const { t } = useAppTranslation();
  const openAbout = useAboutBaas();
  const openHistory = useClientHistory();
  return [
    {
      id: "documentation",
      label: t("help.documentation"),
      onSelect: () => {
        void openDocumentation().catch((error: unknown) => {
          console.error("[help] failed to open documentation:", error);
          toast.error(t("help.openFailed"));
        });
      },
    },
    { id: "client-history", label: t("clientHistory.title"), onSelect: openHistory },
    { id: "about", label: t("about.title"), onSelect: openAbout },
  ];
}
