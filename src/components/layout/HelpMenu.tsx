import { toast } from "sonner";
import type { TitlebarMenuEntry } from "./TitlebarMenu";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { openDocumentation } from "@/shared/Documentation";
import { useAboutBaas } from "@/context/AboutBaasProvider";

/** Both titlebar layouts invoke these same Documentation and About actions. */
export function useHelpMenuEntries(): TitlebarMenuEntry[] {
  const { t } = useAppTranslation();
  const openAbout = useAboutBaas();
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
    { id: "about", label: t("about.title"), onSelect: openAbout },
  ];
}
