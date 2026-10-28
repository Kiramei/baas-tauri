import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Check,
  Loader2,
  Package,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import PluginResultView from "@/components/plugins/PluginResultView";
import BuiltinToolForm from "@/components/plugins/BuiltinToolForm";
import { InventoryToolResult } from "@/components/plugins/InventoryTool";
import HoardToolResult from "@/components/plugins/HoardToolResult";
import EquipmentToolResult from "@/components/plugins/EquipmentToolResult";
import { isBuiltinTool, isDeviceAction } from "@/shared/PluginTools";
import { useApp } from "@/context/AppContext";
import { useWebSocketStore } from "@/store/WebsocketStore";
import {
  pluginDefaults,
  pluginJsonEqual,
  pluginRequest,
  PluginRequestError,
  pluginText,
  validatePluginValue,
  createPluginRequestId,
  consumeRequestedPlugin,
  PLUGIN_OPEN_EVENT,
  type JsonValue,
  type PluginAction,
  type PluginCatalog,
  type PluginDescriptor,
  type PluginJob,
  type PluginSettings,
  type PluginSchema,
  type PluginValidationIssue,
} from "@/shared/Plugins";

type PluginRequester = typeof pluginRequest;
const isJobActive = (job: PluginJob | null) => job?.state === "queued" || job?.state === "running";

function ErrorNotice({ error }: { error: unknown }) {
  const { t } = useTranslation();
  const code = error instanceof PluginRequestError ? error.code : "request_failed";
  const errorMessages: Record<string, string> = {
    unsupported: t("plugins.errors.unsupported"),
    connection_unavailable: t("plugins.errors.connectionUnavailable"),
    session_changed: t("plugins.errors.sessionChanged"),
    timeout: t("plugins.errors.timeout"),
  };
  const known = code in errorMessages;
  return (
    <div
      role="alert"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 break-words">
        {known ? errorMessages[code] : t("plugins.errors.requestFailed")}
        {!known && error instanceof Error && (
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{error.message}</p>
        )}
      </div>
    </div>
  );
}

function ValidationNotice({
  issues,
  invalid,
}: {
  issues: PluginValidationIssue[];
  invalid: boolean;
}) {
  const { t } = useTranslation();
  const messages = {
    required: t("plugins.validation.required"),
    type: t("plugins.validation.type"),
    enum: t("plugins.validation.enum"),
    unknown: t("plugins.validation.unknown"),
  };
  const limitMessage = (reason: string, count: number) => {
    switch (reason) {
      case "minimum":
        return t("plugins.validation.minimum", { count });
      case "maximum":
        return t("plugins.validation.maximum", { count });
      case "minLength":
        return t("plugins.validation.minLength", { count });
      case "maxLength":
        return t("plugins.validation.maxLength", { count });
      case "minItems":
        return t("plugins.validation.minItems", { count });
      default:
        return t("plugins.validation.maxItems", { count });
    }
  };
  if (!issues.length && !invalid) return null;
  return (
    <ul className="space-y-1 text-xs text-destructive" aria-live="polite">
      {invalid && <li>{t("plugins.invalidValue")}</li>}
      {issues.slice(0, 8).map((issue, index) => (
        <li key={index} className="break-words">
          {issue.path}:{" "}
          {issue.reason in messages
            ? messages[issue.reason as keyof typeof messages]
            : limitMessage(issue.reason, issue.limit ?? 0)}
        </li>
      ))}
    </ul>
  );
}

function ActionPanel({
  action,
  plugin,
  configId,
  request,
  onJob,
  blocked,
  onPending,
}: {
  action: PluginAction;
  plugin: PluginDescriptor;
  configId?: string;
  request: PluginRequester;
  onJob: (job: PluginJob) => void;
  blocked: boolean;
  onPending: (pending: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [values, setValues] = useState(() => pluginDefaults(action.input_schema));
  const [invalidPaths, setInvalidPaths] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attempt = useRef<{ input: string; id: string } | null>(null);
  const onInvalid = useCallback(
    (path: string, invalid: boolean) => setInvalidPaths((prev) => ({ ...prev, [path]: invalid })),
    []
  );
  const invalid = Object.values(invalidPaths).some(Boolean);
  const issues = validatePluginValue(action.input_schema, values);
  const canRun = Boolean(
    configId && plugin.enabled && plugin.state === "available" && !blocked && !pending
  );
  const run = async () => {
    if (!canRun || invalid || issues.length) return;
    setPending(true);
    onPending(true);
    setError(null);
    const serialized = JSON.stringify(values);
    if (attempt.current?.input !== serialized)
      attempt.current = { input: serialized, id: createPluginRequestId() };
    try {
      const job = await request<PluginJob>("run_plugin_action", configId, {
        plugin_id: plugin.id,
        action_id: action.id,
        input: values,
        request_id: attempt.current.id,
      });
      attempt.current = null;
      onJob(job);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
      onPending(false);
    }
  };
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{pluginText(action.name, i18n.language)}</h4>
        <span className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">
          {isDeviceAction(action) ? t("plugins.deviceTask") : t("plugins.compute")}
        </span>
      </div>
      {action.description && (
        <p className="text-sm text-muted-foreground">
          {pluginText(action.description, i18n.language)}
        </p>
      )}
      <BuiltinToolForm
        plugin={plugin}
        actionId={action.id}
        schema={action.input_schema}
        value={values}
        onChange={setValues}
        onInvalid={onInvalid}
        disabled={!canRun}
      />
      <ValidationNotice issues={issues} invalid={invalid} />
      {error ? <ErrorNotice error={error} /> : null}
      <Button onClick={() => void run()} disabled={!canRun || invalid || issues.length > 0}>
        {pending ? <Loader2 className="animate-spin" /> : <Play />}
        {t("plugins.run")}
      </Button>
    </section>
  );
}

function JobPanel({
  job,
  configId,
  request,
  onChange,
  schema,
  plugin,
}: {
  job: PluginJob;
  schema?: PluginSchema;
  plugin: PluginDescriptor;
  configId: string;
  request: PluginRequester;
  onChange: (job: PluginJob) => void;
}) {
  const { t, i18n } = useTranslation();
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!isJobActive(job)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request<PluginJob>("get_plugin_job", configId, { job_id: job.id });
        if (disposed) return;
        setError(null);
        onChange(next);
        if (isJobActive(next)) timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (!disposed) setError(failure);
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [job.id, job.state, configId, request, onChange, retry]);
  const cancel = async () => {
    setCancelling(true);
    try {
      onChange(await request<PluginJob>("cancel_plugin_job", configId, { job_id: job.id }));
    } catch (failure) {
      setError(failure);
    } finally {
      setCancelling(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-secondary/30 p-4"
      aria-live="polite"
      data-plugin-job={job.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 font-medium">
          {isJobActive(job) ? (
            <Loader2 className="size-4 animate-spin" />
          ) : job.state === "succeeded" ? (
            <Check className="size-4" />
          ) : null}
          {
            {
              queued: t("plugins.job.queued"),
              running: t("plugins.job.running"),
              succeeded: t("plugins.job.succeeded"),
              failed: t("plugins.job.failed"),
              cancelled: t("plugins.job.cancelled"),
            }[job.state]
          }
        </h4>
        {isJobActive(job) && (
          <Button size="sm" variant="outline" disabled={cancelling} onClick={() => void cancel()}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {pluginText(
          plugin.actions.find((action) => action.id === job.action_id)?.name,
          i18n.language
        )}
      </p>
      {job.result !== undefined &&
        (isBuiltinTool(plugin, "baas.hoard-ap") && job.action_id === "plan" ? (
          <HoardToolResult value={job.result} />
        ) : isBuiltinTool(plugin, "baas.equipment-planner") ? (
          <EquipmentToolResult value={job.result} schema={schema} />
        ) : isBuiltinTool(plugin, "baas.inventory-calculator") ? (
          <>
            <InventoryToolResult value={job.result} />
            <details className="min-w-0">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {t("plugins.rawResult")}
              </summary>
              <PluginResultView value={job.result} schema={schema} />
            </details>
          </>
        ) : (
          <PluginResultView value={job.result} schema={schema} />
        ))}
      {job.error && (
        <p className="whitespace-pre-wrap break-words text-sm text-destructive">
          {job.error.message}
        </p>
      )}
      {error ? (
        <>
          <ErrorNotice error={error} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setRetry((value) => value + 1);
            }}
          >
            {t("plugins.refresh")}
          </Button>
        </>
      ) : null}
    </section>
  );
}

function PluginDetail({
  plugin,
  configId,
  request,
  onRefresh,
  canUninstall,
  job,
  onJob,
}: {
  plugin: PluginDescriptor;
  configId?: string;
  request: PluginRequester;
  onRefresh: () => void;
  canUninstall: boolean;
  job: PluginJob | null;
  onJob: (job: PluginJob) => void;
}) {
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [formGeneration, setFormGeneration] = useState(0);
  const [draft, setDraft] = useState<JsonValue>(() => pluginDefaults(plugin.settings_schema));
  const [invalidPaths, setInvalidPaths] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(Boolean(configId));
  const [pending, setPending] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmation, setConfirmation] = useState<"trust" | "uninstall" | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedActionId, setSelectedActionId] = useState(plugin.actions[0]?.id ?? "");
  useEffect(() => {
    if (!configId || plugin.state !== "available") {
      setLoading(false);
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    void request<PluginSettings>("get_plugin_settings", configId, { plugin_id: plugin.id })
      .then((value) => {
        if (!disposed) {
          setSettings(value);
          setFormGeneration((generation) => generation + 1);
          setDraft(value.values);
          setInvalidPaths({});
          setSaved(false);
        }
      })
      .catch((failure) => {
        if (!disposed) setError(failure);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [configId, plugin.id, plugin.state, request, reload]);
  const onInvalid = useCallback(
    (path: string, invalid: boolean) => setInvalidPaths((prev) => ({ ...prev, [path]: invalid })),
    []
  );
  const invalid = Object.values(invalidPaths).some(Boolean);
  const busy = pending || actionPending || isJobActive(job);
  const hasSettings = Object.keys(plugin.settings_schema.properties ?? {}).length > 0;
  const settingsIssues = validatePluginValue(plugin.settings_schema, draft);
  const settingsDirty =
    hasSettings && settings !== null && !pluginJsonEqual(draft, settings.values);
  const selectedAction =
    plugin.actions.find((action) => action.id === selectedActionId) ?? plugin.actions[0];
  const mutate = async (command: string, payload: Record<string, unknown>, global = false) => {
    setPending(true);
    setError(null);
    try {
      await request(command, global ? undefined : configId, { plugin_id: plugin.id, ...payload });
      setConfirmation(null);
      onRefresh();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  const save = async () => {
    if (!settings || !configId || invalid || settingsIssues.length) return;
    setPending(true);
    setSaved(false);
    setError(null);
    try {
      const next = await request<PluginSettings>("update_plugin_settings", configId, {
        plugin_id: plugin.id,
        revision: settings.revision,
        values: draft,
      });
      setSettings(next);
      setDraft(next.values);
      setInvalidPaths({});
      setSaved(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="min-w-0 space-y-5" data-plugin-detail={plugin.id}>
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-xl font-semibold">
              {pluginText(plugin.name, i18n.language)}
            </h2>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {plugin.id} · {plugin.version}
            </p>
          </div>
          <Button
            variant={plugin.enabled ? "outline" : "default"}
            disabled={!configId || busy || plugin.state !== "available"}
            onClick={() =>
              plugin.source === "external" && !plugin.enabled && !plugin.trusted
                ? setConfirmation("trust")
                : void mutate("set_plugin_enabled", { enabled: !plugin.enabled })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {plugin.enabled ? t("plugins.disable") : t("plugins.enable")}
          </Button>
        </div>
        {plugin.description && (
          <p className="break-words text-sm text-muted-foreground">
            {pluginText(plugin.description, i18n.language)}
          </p>
        )}
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-md bg-secondary px-2 py-1">
            {plugin.source === "builtin" ? t("plugins.builtin") : t("plugins.external")}
          </span>
          {plugin.author && (
            <span className="rounded-md bg-secondary px-2 py-1">{plugin.author}</span>
          )}
          <span className="rounded-md bg-secondary px-2 py-1">
            {plugin.enabled ? t("plugins.enabled") : t("plugins.disabled")}
          </span>
        </div>
        <div className="rounded-lg border border-border p-3">
          <h3 className="flex items-center gap-2 text-xs font-medium">
            <ShieldCheck className="size-4" />
            {t("plugins.permissions")}
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {plugin.permissions.map((permission) => (
              <li key={permission}>
                {permission === "compute"
                  ? t("plugins.permissionCompute")
                  : permission === "device.tasks"
                    ? t("plugins.permissionDevice")
                    : permission}
              </li>
            ))}
          </ul>
          {plugin.source === "external" && (
            <p className="mt-2 text-xs text-muted-foreground">{t("plugins.permissionsHint")}</p>
          )}
        </div>
      </header>
      {!configId && (
        <p className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
          {t("plugins.chooseProfile")}
        </p>
      )}
      {plugin.state !== "available" && (
        <p role="alert" className="break-words text-sm text-destructive">
          {plugin.state === "incompatible" ? t("plugins.incompatible") : t("plugins.pluginError")}
          {plugin.error ? `: ${plugin.error.message}` : ""}
        </p>
      )}
      {error ? <ErrorNotice error={error} /> : null}
      {configId && hasSettings && plugin.state === "available" && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t("plugins.settings")}</h3>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("plugins.reloadSettings")}
              disabled={busy || loading}
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              {t("plugins.reloadSettings")}
            </Button>
          </div>
          {loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("plugins.loading")}
            </p>
          ) : (
            settings && (
              <>
                <BuiltinToolForm
                  key={`${settings.revision}:${formGeneration}`}
                  plugin={plugin}
                  schema={plugin.settings_schema}
                  value={draft}
                  onChange={(value) => {
                    setDraft(value);
                    setSaved(false);
                  }}
                  onInvalid={onInvalid}
                  disabled={busy}
                />
                <ValidationNotice issues={settingsIssues} invalid={invalid} />
                {Object.keys(plugin.settings_schema.properties ?? {}).length > 0 && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="outline"
                      disabled={busy || invalid || settingsIssues.length > 0 || !settingsDirty}
                      onClick={() => void save()}
                    >
                      {t("common.save")}
                    </Button>
                    {saved && (
                      <span role="status" className="text-sm text-muted-foreground">
                        {t("plugins.saved")}
                      </span>
                    )}
                  </div>
                )}
              </>
            )
          )}
        </section>
      )}
      {plugin.actions.length > 0 && (
        <section className="space-y-3">
          <h3 className="font-semibold">{t("plugins.actions")}</h3>
          {!plugin.enabled && configId && (
            <p className="text-sm text-muted-foreground">{t("plugins.enableToRun")}</p>
          )}
          {settingsDirty && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("pluginTools.saveBeforeRun")}
            </p>
          )}
          {plugin.actions.length > 1 && (
            <label className="block min-w-0 space-y-2 text-sm">
              <span>{t("pluginTools.chooseAction")}</span>
              <select
                className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2"
                value={selectedAction?.id}
                disabled={busy}
                onChange={(event) => setSelectedActionId(event.target.value)}
              >
                {plugin.actions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {pluginText(action.name, i18n.language)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedAction && (
            <ActionPanel
              key={selectedAction.id}
              action={selectedAction}
              plugin={plugin}
              configId={configId}
              request={request}
              onJob={onJob}
              onPending={setActionPending}
              blocked={busy || loading || settingsDirty || (hasSettings && !settings)}
            />
          )}
        </section>
      )}
      {job && configId && (
        <JobPanel
          job={job}
          plugin={plugin}
          configId={configId}
          request={request}
          onChange={onJob}
          schema={plugin.actions.find((action) => action.id === job.action_id)?.output_schema}
        />
      )}
      {plugin.source === "external" && canUninstall && (
        <div className="border-t border-border pt-4">
          <Button
            variant="ghost"
            className="text-destructive"
            disabled={busy}
            onClick={() => setConfirmation("uninstall")}
          >
            <Trash2 />
            {t("plugins.uninstall")}
          </Button>
        </div>
      )}
      <Modal
        isOpen={confirmation !== null}
        onClose={() => {
          if (!pending) setConfirmation(null);
        }}
        title={confirmation === "uninstall" ? t("plugins.uninstall") : t("plugins.trustTitle")}
        width={30}
      >
        <div className="space-y-4">
          {error ? <ErrorNotice error={error} /> : null}
          <p className="text-sm leading-relaxed">
            {confirmation === "uninstall"
              ? t("plugins.uninstallConfirm", { name: pluginText(plugin.name, i18n.language) })
              : t("plugins.trustWarning", { name: pluginText(plugin.name, i18n.language) })}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={pending} onClick={() => setConfirmation(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={confirmation === "uninstall" ? "destructive" : "default"}
              disabled={pending}
              onClick={() =>
                void (confirmation === "uninstall"
                  ? mutate("uninstall_plugin", {}, true)
                  : mutate("set_plugin_enabled", { enabled: true, trust_code: true }))
              }
            >
              {pending ? <Loader2 className="animate-spin" /> : null}
              {confirmation === "uninstall" ? t("plugins.uninstall") : t("plugins.trustEnable")}
            </Button>
          </div>
        </div>
      </Modal>
    </article>
  );
}

/** A global catalog with profile-scoped details; exported for native and browser integration checks. */
function PluginsWorkspaceContent({
  configId,
  profileName,
  request = pluginRequest,
}: {
  configId?: string;
  profileName?: string;
  request?: PluginRequester;
}) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [jobs, setJobs] = useState<Record<string, PluginJob>>({});
  const onJob = useCallback(
    (job: PluginJob) => setJobs((previous) => ({ ...previous, [job.plugin_id]: job })),
    []
  );
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const openRequested = () => {
      const id = consumeRequestedPlugin();
      if (id) {
        setQuery("");
        setSelectedId(id);
      }
    };
    openRequested();
    window.addEventListener(PLUGIN_OPEN_EVENT, openRequested);
    return () => window.removeEventListener(PLUGIN_OPEN_EVENT, openRequested);
  }, []);
  const [revision, setRevision] = useState(0);
  const [installing, setInstalling] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    void request<PluginCatalog>("get_plugin_catalog", configId)
      .then((value) => {
        if (
          value?.api_version !== 1 ||
          !Array.isArray(value.plugins) ||
          !Array.isArray(value.capabilities)
        )
          throw new PluginRequestError("unsupported", "Unsupported plugin API version");
        if (!disposed) setCatalog(value);
      })
      .catch((failure) => {
        if (!disposed) setError(failure);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [configId, request, revision]);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const plugins =
    catalog?.plugins.filter((plugin) =>
      `${plugin.id} ${pluginText(plugin.name, i18n.language)} ${pluginText(plugin.description, i18n.language)} ${plugin.author ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ) ?? [];
  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? plugins[0];
  const install = async (file: File) => {
    setInstalling(true);
    setError(null);
    try {
      if (!file.size || file.size > 10 * 1024 * 1024) throw new Error(t("plugins.archiveSize"));
      const bytes = new Uint8Array(await file.arrayBuffer());
      await request("install_plugin", undefined, { filename: file.name }, bytes);
      if (live.current) refresh();
    } catch (failure) {
      if (live.current) setError(failure);
    } finally {
      if (live.current) setInstalling(false);
    }
  };
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-5 pb-4" data-plugin-workspace>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("plugins.title")}</h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">{t("plugins.description")}</p>
          <p className="mt-2 break-words text-xs text-muted-foreground">
            {profileName
              ? t("plugins.currentProfile", { name: profileName })
              : t("plugins.chooseProfile")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={loading || installing}
            onClick={refresh}
            aria-label={t("plugins.refresh")}
          >
            <RefreshCw className={loading ? "animate-spin" : ""} />
            <span>{t("plugins.refresh")}</span>
          </Button>
          {catalog?.capabilities.includes("install") && (
            <Button
              variant="outline"
              disabled={installing}
              onClick={() => fileInput.current?.click()}
            >
              {installing ? <Loader2 className="animate-spin" /> : <Upload />}
              {t("plugins.install")}
            </Button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            aria-label={t("plugins.install")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void install(file);
            }}
          />
        </div>
      </header>
      {error ? <ErrorNotice error={error} /> : null}
      {catalog?.errors?.length ? (
        <div className="space-y-2 rounded-lg border border-border p-3" role="status">
          {catalog.errors.map((issue, index) => (
            <p key={index} className="break-words text-xs text-muted-foreground">
              {issue.plugin_id ? `${issue.plugin_id}: ` : ""}
              {issue.message}
            </p>
          ))}
        </div>
      ) : null}
      {loading && !catalog ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("plugins.loading")}
        </p>
      ) : (
        catalog && (
          <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]">
            <section className="min-w-0 space-y-3" aria-label={t("plugins.catalog")}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("plugins.search")}
                  aria-label={t("plugins.search")}
                  className="pl-9"
                />
              </div>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-1">
                {plugins.map((plugin) => (
                  <button
                    type="button"
                    key={plugin.id}
                    aria-pressed={selected?.id === plugin.id}
                    onClick={() => setSelectedId(plugin.id)}
                    className={`min-w-0 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 ${selected?.id === plugin.id ? "border-primary/45 bg-primary/5" : "border-border bg-card hover:bg-secondary/50"}`}
                  >
                    <span className="flex items-start gap-2">
                      <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 break-words font-medium">
                        {pluginText(plugin.name, i18n.language)}
                      </span>
                      <span className="ml-auto shrink-0 pt-0.5 text-xs text-muted-foreground sm:hidden">
                        {plugin.state !== "available"
                          ? t("plugins.unavailable")
                          : plugin.enabled
                            ? t("plugins.enabled")
                            : t("plugins.disabled")}
                      </span>
                    </span>
                    <span className="mt-2 hidden break-words text-xs text-muted-foreground sm:line-clamp-2">
                      {pluginText(plugin.description, i18n.language)}
                    </span>
                    <span className="mt-3 hidden flex-wrap items-center gap-2 text-xs text-muted-foreground sm:flex">
                      <span>{plugin.version}</span>
                      <span>·</span>
                      <span>
                        {plugin.source === "builtin" ? t("plugins.builtin") : t("plugins.external")}
                      </span>
                      <span className="ml-auto">
                        {plugin.state !== "available"
                          ? t("plugins.unavailable")
                          : plugin.enabled
                            ? t("plugins.enabled")
                            : t("plugins.disabled")}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {!plugins.length && (
                <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                  {query ? t("plugins.noResults") : t("plugins.empty")}
                </p>
              )}
            </section>
            {selected && (
              <div className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
                <PluginDetail
                  key={`${configId ?? "none"}:${selected.id}`}
                  plugin={selected}
                  configId={configId}
                  request={request}
                  onRefresh={refresh}
                  canUninstall={catalog.capabilities.includes("uninstall")}
                  job={jobs[selected.id] ?? null}
                  onJob={onJob}
                />
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

export function PluginsWorkspace(props: {
  configId?: string;
  profileName?: string;
  request?: PluginRequester;
}) {
  return <PluginsWorkspaceContent key={props.configId ?? "none"} {...props} />;
}

export default function PluginsPage() {
  const { activeProfile } = useApp();
  const connected = useWebSocketStore(
    (state) => state._auth_phase === "authenticated" && state.connections.trigger?.readyState === 1
  );
  return (
    <PluginsWorkspace
      key={`${activeProfile?.id ?? "none"}:${connected}`}
      configId={activeProfile?.id}
      profileName={activeProfile?.name}
    />
  );
}
