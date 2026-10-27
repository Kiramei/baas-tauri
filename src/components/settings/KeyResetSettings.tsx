import { useRef, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { validateKeyInput, type KeyInputError } from "@/shared/KeyInput";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { Modal } from "@/components/ui/Modal";
import { FormInput } from "@/components/ui/FormInput";
import CButton from "@/components/ui/CButton";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsControls";

function KeyResetDialog({
  resetKey,
  onClose,
}: {
  resetKey: (newKey: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [key, setKey] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validationError, setValidationError] = useState<KeyInputError | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pendingRef = useRef(false);

  const close = () => {
    if (!pendingRef.current) onClose();
  };

  const submit = async () => {
    if (pendingRef.current) return;
    const error = validateKeyInput(key, confirmation);
    setValidationError(error);
    setFailureMessage(null);
    if (error) return;

    pendingRef.current = true;
    setSubmitting(true);
    const newKey = key.trim();
    // Keep plaintext out of retained form state, diagnostics and toast messages.
    setKey("");
    setConfirmation("");
    try {
      await resetKey(newKey);
      toast.success(t("auth.resetKeySuccess"));
      onClose();
    } catch (error) {
      setFailureMessage(
        error instanceof Error && error.message === t("auth.resetKeyUnsupported")
          ? t("auth.resetKeyUnsupported")
          : t("auth.resetKeyFailed")
      );
    } finally {
      pendingRef.current = false;
      setSubmitting(false);
    }
  };

  const errorMessage = validationError
    ? validationError === "required"
      ? t("auth.keyRequired")
      : t("auth.keyMismatch")
    : failureMessage;

  return (
    <Modal isOpen onClose={close} title={t("auth.resetKeyTitle")} width={40}>
      <form
        className="space-y-4"
        aria-busy={submitting}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="text-sm text-muted-foreground">{t("auth.resetKeyDescription")}</p>
        <FormInput
          data-autofocus
          label={t("auth.newPasswordLabel")}
          aria-label={t("auth.newPasswordLabel")}
          name="new-key"
          type="password"
          autoComplete="new-password"
          value={key}
          disabled={submitting}
          onChange={(event) => setKey(event.target.value)}
        />
        <FormInput
          label={t("auth.confirmPasswordLabel")}
          aria-label={t("auth.confirmPasswordLabel")}
          name="confirm-key"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          disabled={submitting}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {errorMessage && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <div className="modal-footer">
          <CButton type="button" variant="secondary" disabled={submitting} onClick={close}>
            {t("common.cancel")}
          </CButton>
          <CButton type="submit" disabled={submitting}>
            {submitting && <Loader2 aria-hidden className="size-4 animate-spin" />}
            {submitting ? t("auth.resettingKey") : t("auth.resetKey")}
          </CButton>
        </div>
      </form>
    </Modal>
  );
}

/** Available only for a browser's authenticated remote backend session. */
export function KeyResetSettings() {
  const { t } = useAppTranslation();
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const sessionId = useWebSocketStore((state) =>
    state._auth_phase === "authenticated" ? (state._session?.sessionId ?? null) : null
  );
  const resetKey = useWebSocketStore((state) => state.resetKey);

  return (
    <SettingsGroup title={t("auth.loginSettingsTitle")}>
      <SettingsRow label={t("auth.passwordLabel")} description={t("auth.resetKeyDescription")}>
        <CButton
          type="button"
          variant="secondary"
          disabled={!sessionId}
          onClick={() => setOpenSessionId(sessionId)}
        >
          <KeyRound aria-hidden className="size-4" />
          {t("auth.resetKey")}
        </CButton>
      </SettingsRow>
      {openSessionId !== null && openSessionId === sessionId && (
        <KeyResetDialog resetKey={resetKey} onClose={() => setOpenSessionId(null)} />
      )}
    </SettingsGroup>
  );
}
