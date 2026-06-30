import React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { FolderOpen } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { useTranslation } from "react-i18next";

interface PathSelectorProps {
  path: string;
  setPath: (path: string) => void;
  disabled?: boolean;
}

/** Renders the path selector component. */
const PathSelector: React.FC<PathSelectorProps> = ({ path, setPath, disabled = false }) => {
  const { t } = useTranslation();
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
        <FormInput
          label={t("label.installDir")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Select installation directory..."
          className="w-full flex-col"
          childClassName="text-sm bg-background/30"
          disabled={disabled}
        />
        <Button
          variant="outline"
          size="icon"
          onClick={handleBrowse}
          title="Browse"
          className="bg-background/30"
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default PathSelector;
