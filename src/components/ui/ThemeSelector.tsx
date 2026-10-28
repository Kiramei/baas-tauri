import { useAppTranslation } from "@/shared/useAppTranslation";
import { themeKey } from "@/shared/I18nKeys";
import { cn } from "@/shared/cn";
import type { Theme } from "@/types/app";
import "./segmented-control.css";

export function ThemeSelector({
  value,
  onChange,
  compact = false,
  fullWidth = false,
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
  compact?: boolean;
  fullWidth?: boolean;
}) {
  const { t } = useAppTranslation();
  return (
    <div
      role="group"
      aria-label={t("common.theme")}
      className={cn(
        "segmented-control theme-selector inline-flex",
        compact && "theme-selector-compact",
        fullWidth && "theme-selector-wide"
      )}
    >
      {(["light", "dark", "system"] as const).map((theme) => (
        <button
          key={theme}
          type="button"
          aria-pressed={value === theme}
          onClick={() => onChange(theme)}
        >
          {t(themeKey(theme))}
        </button>
      ))}
    </div>
  );
}
