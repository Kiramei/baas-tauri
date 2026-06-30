import React from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useApp } from "@/context/AppContext";
import { getTimestampMs } from "@/shared/GlobalUtilities";
import { useWebSocketStore, waitForNormal } from "@/store/WebsocketStore";

type DropState = "zip" | "invalid" | null;
type PendingArchive = {
  name: string;
  bytes: ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>;
};

/** Returns the is zip name result. */
const isZipName = (name: string) => name.toLowerCase().endsWith(".zip");

/** Returns the has file drag result. */
const hasFileDrag = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** Handles the files from drop workflow. */
const filesFromDrop = (event: DragEvent): File[] =>
  Array.from(event.dataTransfer?.files ?? []).filter((file) => isZipName(file.name));

/** Handles the archive name from path workflow. */
const archiveNameFromPath = (path: string) => path.split(/[\\/]/).pop() || path;

/** Handles the wait for imported config workflow. */
const waitForImportedConfig = async (serial: string) => {
  await waitForNormal(() => useWebSocketStore.getState().configStore?.[serial], Boolean, 8000);
  return useWebSocketStore.getState().configStore?.[serial];
};

/** Renders the config archive drop overlay component. */
const ConfigArchiveDropOverlay: React.FC = () => {
  const { t } = useTranslation();
  const { setActiveProfile } = useApp();
  const [dropState, setDropState] = React.useState<DropState>(null);
  const dragDepthRef = React.useRef(0);
  const importingRef = React.useRef(false);

  /** Performs the reset drag operation. */
  const resetDrag = React.useCallback(() => {
    dragDepthRef.current = 0;
    setDropState(null);
  }, []);

  /** Handles the import archive workflow. */
  const importArchive = React.useCallback(
    async (name: string, bytes: ArrayBuffer | Uint8Array) => {
      const state = useWebSocketStore.getState();
      if (state._auth_phase !== "authenticated" || !state.connections.trigger) {
        throw new Error(
          t("profile.dropAuthRequired", {
            defaultValue: "Connect and authenticate before importing a profile archive.",
          })
        );
      }

      const result = await new Promise<any>((resolve, reject) => {
        state.triggerBinary(
          {
            timestamp: getTimestampMs() + Math.random() * 1000,
            command: "import_config",
            payload: { filename: name },
          },
          bytes,
          (event) => {
            if (event?.status === "error") {
              reject(new Error(event.error || "import_config failed"));
              return;
            }
            resolve(event?.data);
          }
        );
      });

      if (result?.serial) {
        try {
          const config = await waitForImportedConfig(result.serial);
          setActiveProfile({
            id: result.serial,
            name: config?.name ?? result.name ?? archiveNameFromPath(name),
            settings: config,
          });
        } catch {
          // The import already succeeded; filesystem sync can still arrive after the UI toast.
        }
      }

      return result;
    },
    [setActiveProfile, t]
  );

  /** Handles the import archives workflow. */
  const importArchives = React.useCallback(
    async (archives: PendingArchive[]) => {
      if (!archives.length) {
        toast.error(
          t("profile.dropInvalid", {
            defaultValue: "Only .zip profile archives can be imported.",
          })
        );
        return;
      }
      if (importingRef.current) return;
      importingRef.current = true;

      const toastId = toast.loading(
        t("profile.dropImporting", {
          count: archives.length,
          defaultValue: "Importing profile archive...",
        })
      );

      try {
        for (const archive of archives) {
          await importArchive(archive.name, await archive.bytes);
        }
        toast.success(
          t("profile.dropImportSuccess", {
            count: archives.length,
            defaultValue: "Profile archive imported.",
          }),
          { id: toastId }
        );
      } catch (error: any) {
        toast.error(
          t("profile.importFailed", {
            defaultValue: "Failed to import profile",
          }),
          { id: toastId, description: error?.message }
        );
      } finally {
        importingRef.current = false;
      }
    },
    [importArchive, t]
  );

  React.useEffect(() => {
    /** Handles the on drag enter interaction. */
    const onDragEnter = (event: DragEvent) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      const items = Array.from(event.dataTransfer?.items ?? []);
      const hasZip =
        items.length === 0 ||
        items.some((item) => {
          if (item.kind !== "file") return false;
          const file = item.getAsFile();
          return !file?.name || isZipName(file.name);
        });
      setDropState(hasZip ? "zip" : "invalid");
    };

    /** Handles the on drag over interaction. */
    const onDragOver = (event: DragEvent) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = dropState === "invalid" ? "none" : "copy";
      }
    };

    /** Handles the on drag leave interaction. */
    const onDragLeave = (event: DragEvent) => {
      if (!hasFileDrag(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDropState(null);
    };

    /** Handles the on drop interaction. */
    const onDrop = (event: DragEvent) => {
      if (!hasFileDrag(event)) return;
      event.preventDefault();
      const files = filesFromDrop(event);
      resetDrag();
      void importArchives(
        files.map((file) => ({
          name: file.name,
          bytes: file.arrayBuffer(),
        }))
      );
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [dropState, importArchives, resetDrag]);

  React.useEffect(() => {
    if (!__WITH_TAURI__) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    /** Performs the setup operation. */
    const setup = async () => {
      const [{ getCurrentWebview }, { readFile }] = await Promise.all([
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/plugin-fs"),
      ]);
      if (disposed) return;
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          const paths = payload.paths ?? [];
          setDropState(paths.some(isZipName) ? "zip" : "invalid");
          return;
        }
        if (payload.type === "over") {
          setDropState((current) => current ?? "zip");
          return;
        }
        if (payload.type === "leave") {
          resetDrag();
          return;
        }
        if (payload.type === "drop") {
          resetDrag();
          const zipPaths = (payload.paths ?? []).filter(isZipName);
          void importArchives(
            zipPaths.map((path) => ({
              name: archiveNameFromPath(path),
              bytes: readFile(path),
            }))
          );
        }
      });
    };

    setup().catch((error) => {
      console.warn("Failed to attach Tauri drag/drop listener", error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importArchives, resetDrag]);

  if (!dropState) return null;

  const isValid = dropState === "zip";

  return (
    <div className="fixed inset-0 z-[150] pointer-events-none flex items-center justify-center bg-slate-950/55 backdrop-blur-sm">
      <div
        className={`mx-6 flex min-h-56 w-full max-w-xl flex-col items-center justify-center rounded-lg border-2 border-dashed px-8 py-10 text-center shadow-2xl ${
          isValid
            ? "border-primary-300 bg-white/95 text-slate-900 dark:border-primary-400 dark:bg-slate-900/95 dark:text-white"
            : "border-red-300 bg-white/95 text-red-700 dark:border-red-400 dark:bg-slate-900/95 dark:text-red-200"
        }`}
      >
        <Upload className="mb-5 h-12 w-12" />
        <div className="text-xl font-semibold">
          {isValid
            ? t("profile.dropImportTitle", {
                defaultValue: "Drop to import profile archive",
              })
            : t("profile.dropInvalidTitle", {
                defaultValue: "Unsupported file type",
              })}
        </div>
        <div className="mt-2 text-sm opacity-80">
          {isValid
            ? t("profile.dropImportHint", {
                defaultValue: "Release the .zip file to add it as a new profile.",
              })
            : t("profile.dropInvalid", {
                defaultValue: "Only .zip profile archives can be imported.",
              })}
        </div>
      </div>
    </div>
  );
};

export default ConfigArchiveDropOverlay;
