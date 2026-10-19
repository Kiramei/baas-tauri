import React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { Folder, FolderOpen } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { IconTooltip } from "@/components/ui/Tooltip";
import { cn } from "@/shared/cn";

interface PathSelectorProps {
  path: string;
  displayPath?: string;
  setPath: (path: string) => void;
  disabled?: boolean;
}

/** Renders the path selector component. */
const PathSelector: React.FC<PathSelectorProps> = ({
  path,
  displayPath,
  setPath,
  disabled = false,
}) => {
  const { t } = useAppTranslation();
  /** Handles the handle browse interaction. */
  const handleBrowse = async () => {
    if (disabled) return;
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: path,
    });

    if (selected) {
      setPath(selected as string);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-end">
        <div className="relative min-w-0 flex-1">
          <FormInput
            label={t("label.installDir")}
            aria-label={t("label.installDir")}
            value={disabled ? displayPath || path : path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("label.installDir")}
            childClassName={cn("h-11 bg-card text-sm text-foreground", disabled && "pl-10")}
            readOnly={disabled}
          />
          {disabled && (
            <Folder
              className="pointer-events-none absolute bottom-3.5 left-3 size-4 text-muted-foreground"
              aria-hidden="true"
              strokeWidth={1.5}
            />
          )}
        </div>
        {!disabled && (
          <IconTooltip content={t("common.choose")}>
            <Button
              variant="outline"
              size="icon"
              onClick={handleBrowse}
              aria-label={t("common.choose")}
              className="size-11 shrink-0 bg-card"
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </IconTooltip>
        )}
      </div>
    </div>
  );
};

export default PathSelector;
