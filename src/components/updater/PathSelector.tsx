import React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/Button";
import { FolderOpen } from "lucide-react";
import { FormInput } from "@/components/ui/FormInput.tsx";
import { useTranslation } from "react-i18next";

interface PathSelectorProps {
  path: string;
  setPath: (path: string) => void;
}

const PathSelector: React.FC<PathSelectorProps> = ({ path, setPath }) => {
  const { t } = useTranslation();
  const handleBrowse = async () => {
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
          label={t("label.install_dir")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Select installation directory..."
          className="w-full flex-col"
          childClassName="text-sm bg-background/30"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={handleBrowse}
          title="Browse"
          className="bg-background/30"
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default PathSelector;
