import { useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { SettingsToggle } from "@/components/settings/SettingsControls";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { homeLayout, jsonRecord, moveHomeSection, type HomeSection } from "@/shared/PluginTools";
import type { JsonValue } from "@/shared/Plugins";

export default function HomeLayoutEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: JsonValue;
  onChange: (value: JsonValue) => void;
  disabled?: boolean;
}) {
  const { t } = useAppTranslation();
  const layout = homeLayout(value);
  const [dragged, setDragged] = useState<HomeSection | null>(null);
  const labels: Record<HomeSection, string> = {
    shortcuts: t("plugins.homeEditor.shortcuts"),
    assets: t("plugins.homeEditor.assets"),
    tasks: t("plugins.homeEditor.tasks"),
    logs: t("plugins.homeEditor.logs"),
  };
  const update = (patch: Record<string, JsonValue>) => {
    if (!disabled) onChange({ ...jsonRecord(value), ...layout, ...patch });
  };
  const move = (from: number, to: number) =>
    update({ section_order: moveHomeSection(layout.section_order, from, to) });

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-4"
      aria-label={t("plugins.homeEditor.title")}
    >
      <p className="text-sm leading-6 text-muted-foreground">
        {t("plugins.homeEditor.description")}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">{t("plugins.homeEditor.orderHint")}</p>
      <ol className="min-w-0 space-y-2" aria-label={t("plugins.homeEditor.title")}>
        {layout.section_order.map((section, index) => (
          <li
            key={section}
            draggable={!disabled}
            onDragStart={(event) => {
              setDragged(section);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", section);
            }}
            onDragEnd={() => setDragged(null)}
            onDragOver={(event) => {
              if (!disabled && dragged) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!disabled && dragged) move(layout.section_order.indexOf(dragged), index);
              setDragged(null);
            }}
            className={`min-w-0 rounded-lg border border-border px-3 py-2 ${dragged === section ? "bg-secondary" : "bg-card"}`}
            data-home-layout-section={section}
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <GripVertical
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words">{labels[section]}</span>
              </span>
              <div className="flex shrink-0 items-center">
                {([-1, 1] as const).map((direction) => {
                  const label =
                    direction < 0
                      ? t("plugins.homeEditor.moveUp", { section: labels[section] })
                      : t("plugins.homeEditor.moveDown", { section: labels[section] });
                  const Icon = direction < 0 ? ArrowUp : ArrowDown;
                  return (
                    <button
                      key={direction}
                      type="button"
                      aria-label={label}
                      title={label}
                      disabled={
                        disabled ||
                        index + direction < 0 ||
                        index + direction >= layout.section_order.length
                      }
                      onClick={() => move(index, index + direction)}
                      className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-30"
                    >
                      <Icon className="size-4" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
            {section === "logs" ? (
              <p className="pb-1 text-xs text-muted-foreground">
                {t("plugins.homeEditor.logsAlwaysVisible")}
              </p>
            ) : (
              <SettingsToggle
                label={t("plugins.homeEditor.showSection", { section: labels[section] })}
                checked={layout[`${section}_visible`]}
                onChange={(visible) => update({ [`${section}_visible`]: visible })}
              />
            )}
          </li>
        ))}
      </ol>
      <div className="rounded-lg border border-border px-3">
        <SettingsToggle
          label={t("plugins.homeEditor.showEditEntry")}
          checked={layout.show_edit_entry}
          onChange={(show_edit_entry) => update({ show_edit_entry })}
        />
      </div>
    </fieldset>
  );
}
