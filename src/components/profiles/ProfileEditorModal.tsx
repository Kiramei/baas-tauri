import React from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, FolderOpen, Loader2, Upload, X } from "lucide-react";
import { IconTooltip } from "@/components/ui/Tooltip";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import { useModalFocus } from "@/components/ui/Modal";
import { unusedDefaultProfileName } from "@/shared/ProfileName";
import { buildServerOptions, isPcServer, supportsPcServers } from "@/shared/serverOptions";
import type { ProfileTab } from "@/shared/ProfileTabs";
import type { FolderImportProgress, FolderImportReport } from "@/shared/ProfileFolderImport";

interface ProfileEditorModalProps {
  open: boolean;
  mode: "create" | "edit";
  initial: ProfileTab | null;
  lowPerformanceMode?: boolean;
  onClose: () => void;
  onSubmit: (values: { name: string; server: string }) => Promise<void>;
  onImport: () => Promise<void>;
  onImportFolders: (
    onProgress: (progress: FolderImportProgress) => void
  ) => Promise<FolderImportReport | null>;
  checkName: (name: string, selfId?: string) => boolean;
}

const ProfilePane = React.forwardRef<
  HTMLDivElement,
  {
    children: React.ReactNode;
    direction: number;
    animate: boolean;
  }
>(({ children, direction, animate }, ref) => {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      inert={!present}
      aria-hidden={!present}
      custom={direction}
      variants={{
        enter: (value: number) => ({
          x: animate ? `${value * 100}%` : 0,
          opacity: animate ? 0 : 1,
        }),
        exit: (value: number) => ({
          x: animate ? `${value * -100}%` : 0,
          opacity: animate ? 0 : 1,
        }),
      }}
      initial="enter"
      animate={{ x: 0, opacity: 1 }}
      exit="exit"
      transition={{ duration: animate ? 0.22 : 0, ease: [0.22, 1, 0.36, 1] }}
      className="w-full"
    >
      {children}
    </motion.div>
  );
});
ProfilePane.displayName = "ProfilePane";

export default function ProfileEditorModal(props: ProfileEditorModalProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const animate = !props.lowPerformanceMode && !reducedMotion;
  const [name, setName] = React.useState(
    () => props.initial?.name ?? unusedDefaultProfileName((value) => props.checkName(value))
  );
  const [server, setServer] = React.useState("NULL");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importPane, setImportPane] = React.useState(false);
  const [progress, setProgress] = React.useState<FolderImportProgress | null>(null);
  const [report, setReport] = React.useState<FolderImportReport | null>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const archiveRef = React.useRef<HTMLButtonElement>(null);
  const busyRef = React.useRef(false);
  const titleId = React.useId();
  const busy = submitting || importing;

  useModalFocus(props.open, panelRef, () => {
    if (busyRef.current) return;
    if (importPane) setImportPane(false);
    else props.onClose();
  });

  React.useEffect(() => {
    if (!props.open) return;
    setName(props.initial?.name ?? unusedDefaultProfileName((value) => props.checkName(value)));
    setServer(props.initial?.server ?? "NULL");
    setError(null);
    setImportPane(false);
    setProgress(null);
    setReport(null);
  }, [props.open, props.initial]);

  React.useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => {
      if (importPane) archiveRef.current?.focus({ preventScroll: true });
      else
        panelRef.current
          ?.querySelector<HTMLInputElement>("[data-profile-name]")
          ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.open, importPane]);

  const submit = async () => {
    if (busyRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) return setError(t("configAdd.nameRequired"));
    if (server === "NULL") return setError(t("configAdd.serverRequired"));
    if (props.checkName(trimmed, props.initial?.id)) return setError(t("configAdd.nameDuplicate"));
    busyRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await props.onSubmit({ name: trimmed, server });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("configAdd.saveFailed"));
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  const importProfiles = async (folder: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setImporting(true);
    setError(null);
    setReport(null);
    setProgress(null);
    try {
      if (folder) setReport(await props.onImportFolders(setProgress));
      else await props.onImport();
    } catch (reason) {
      const code =
        typeof reason === "object" && reason !== null && "code" in reason ? reason.code : undefined;
      setError(
        code === "no_profiles"
          ? t("profile.importFolderEmpty")
          : code === "unsupported_folder_picker"
            ? t("profile.importFolderUnsupported")
            : reason instanceof Error
              ? reason.message
              : t("profile.importFailed")
      );
    } finally {
      busyRef.current = false;
      setImporting(false);
      setProgress(null);
    }
  };

  if (!props.open) return null;
  return (
    <div
      data-modal-backdrop=""
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/35 p-4 pt-[calc(var(--window-titlebar-height,0px)+1rem)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) props.onClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        initial={animate ? { opacity: 0, y: 4 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: animate ? 0.14 : 0 }}
        className="modal-surface max-h-[calc(100dvh-var(--window-titlebar-height,0px)-32px)] w-full max-w-105 overflow-y-auto outline-none"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="flex min-w-0 items-center gap-2">
            {importPane && (
              <button
                type="button"
                aria-label={t("app.back")}
                disabled={busy}
                className="modal-close shrink-0 disabled:opacity-40"
                onClick={() => setImportPane(false)}
              >
                <ChevronLeft className="size-4" />
              </button>
            )}
            <h2 id={titleId} className="modal-title">
              {importPane
                ? t("profile.importEntry")
                : props.mode === "create"
                  ? t("profile.create")
                  : t("profile.edit")}
            </h2>
          </div>
          <IconTooltip content={t("common.close")} side="bottom">
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={props.onClose}
              disabled={busy}
              className="modal-close disabled:opacity-40"
            >
              <X className="size-4" />
            </button>
          </IconTooltip>
        </div>
        <div className="relative overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout" custom={importPane ? 1 : -1}>
            <ProfilePane
              key={importPane ? "import" : "editor"}
              direction={importPane ? 1 : -1}
              animate={animate}
            >
              {importPane ? (
                <div className="space-y-3">
                  <button
                    ref={archiveRef}
                    type="button"
                    disabled={busy}
                    onClick={() => void importProfiles(false)}
                    className="flex min-h-20 w-full items-center gap-3 rounded-[8px] border border-input px-4 py-4 text-left text-sm outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
                  >
                    <Upload className="size-5 shrink-0" />
                    <span>{t("profile.import")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void importProfiles(true)}
                    className="flex min-h-20 w-full items-center gap-3 rounded-[8px] border border-input px-4 py-4 text-left text-sm outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
                  >
                    <FolderOpen className="size-5 shrink-0" />
                    <span>{t("profile.importFolder")}</span>
                  </button>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("profile.importFolderHint")}
                  </p>
                  {importing && (
                    <p
                      role="status"
                      className="flex items-center gap-2 text-sm text-muted-foreground"
                    >
                      <Loader2 className="size-4 animate-spin" />
                      {progress
                        ? t("profile.importFolderProgress", { ...progress })
                        : t("profile.dropImporting")}
                    </p>
                  )}
                  {report && (
                    <div role="status" className="space-y-2 text-sm">
                      <p>
                        {t("profile.importFolderResult", {
                          imported: report.imported.length,
                          failed: report.failed.length,
                        })}
                      </p>
                      {report.failed.length > 0 && (
                        <ul className="space-y-1 text-destructive">
                          {report.failed.map((item) => (
                            <li key={item.folder}>
                              {item.folder}: {item.error}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {props.mode === "create" && (
                    <button
                      type="button"
                      onClick={() => {
                        setError(null);
                        setImportPane(true);
                      }}
                      disabled={busy}
                      className="flex h-9 w-full items-center gap-2 rounded-[8px] border border-input px-3 text-sm outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
                    >
                      <Upload className="size-4" />
                      <span>{t("profile.importEntry")}</span>
                      <ChevronRight className="ml-auto size-4" />
                    </button>
                  )}
                  <FormInput
                    data-autofocus
                    data-profile-name
                    value={name}
                    label={t("profile.name")}
                    placeholder={t("placeholder.profileName")}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <FormSelect
                    label={t("server.server")}
                    value={server}
                    disabled={busy || props.mode === "edit"}
                    onChange={setServer}
                    placeholder={t("configAdd.selectServer")}
                    options={[
                      { label: t("configAdd.selectServer"), value: "NULL" },
                      ...buildServerOptions(t, {
                        includePc: supportsPcServers(),
                        selected: props.mode === "edit" ? server : undefined,
                      }),
                    ]}
                  />
                  {isPcServer(server) && (
                    <p className="text-xs leading-5 text-muted-foreground">
                      {supportsPcServers() ? t("server.pcCreateHelp") : t("server.pcWindowsOnly")}
                    </p>
                  )}
                </div>
              )}
            </ProfilePane>
          </AnimatePresence>
        </div>
        {error && (
          <div role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button
            type="button"
            data-variant="secondary"
            onClick={props.onClose}
            className="h-8 rounded-[8px] bg-secondary px-3.5 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
            disabled={busy}
          >
            {importPane ? t("common.close") : t("common.cancel")}
          </button>
          {!importPane && (
            <button
              type="button"
              onClick={() => void submit()}
              className="flex h-8 items-center rounded-[8px] bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
              disabled={busy}
            >
              {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
              <span>{props.mode === "create" ? t("common.create") : t("common.save")}</span>
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
