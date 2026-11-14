import { useRef, useState } from "react";
import { FormInput } from "@/components/ui/FormInput";
import CButton from "@/components/ui/CButton";
import { validateLocalMirrorCdk } from "@/shared/MirrorCdk";
import { useAppTranslation } from "@/shared/useAppTranslation";
import { formatIsoToReadable } from "@/shared/GlobalUtilities";

interface MirrorCdkFieldProps {
  label: string;
  channel: string;
  configured: boolean;
  pendingKey?: string;
  disabled?: boolean;
  onChange: (value: string) => Promise<void> | void;
  onBusy?: (busy: boolean) => void;
}

/** The input holds only a new key typed on this device. Existing keys stay native. */
export function MirrorCdkField({
  label,
  channel,
  configured,
  pendingKey,
  disabled,
  onChange,
  onBusy,
}: MirrorCdkFieldProps) {
  const { t } = useAppTranslation();
  const [input, setInput] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const verify = async (clear: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusy?.(true);
    setMessage("");
    const key = input.trim();
    try {
      if (clear) {
        await onChange("");
        setInput("");
        return;
      }
      const report = await validateLocalMirrorCdk(channel, key || pendingKey || undefined);
      if (!report.success) {
        if (report.code === 7001) setMessage(t("mirrorc.message.expired"));
        else if (report.code === 7003) setMessage(t("mirrorc.cdk.quota"));
        else if (report.code === 7004) setMessage(t("mirrorc.cdk.mismatch"));
        else if (report.code === 7005) setMessage(t("mirrorc.cdk.blocked"));
        else if (report.code === 7002) setMessage(t("mirrorc.message.confirmCdkey"));
        else setMessage(t("mirrorc.cdk.requestFailed"));
        return;
      }
      if (key) await onChange(key);
      setInput("");
      setMessage(
        report.expiresAtIso && Number.isFinite(Date.parse(report.expiresAtIso))
          ? t("mirrorc.message.validExpires", {
              expire_date: formatIsoToReadable(report.expiresAtIso),
            })
          : t("mirrorc.cdk.testOk")
      );
    } catch {
      setMessage(t("mirrorc.cdk.requestFailed"));
    } finally {
      running.current = false;
      setBusy(false);
      onBusy?.(false);
    }
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <FormInput
          label={label}
          aria-label={label}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={configured ? t("mirrorc.cdk.configured") : t("update.enterCdk")}
          value={input}
          disabled={disabled || busy}
          className="min-w-36 flex-1"
          onChange={(event) => {
            setInput(event.target.value);
            setMessage("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (input.trim() || configured)) {
              event.preventDefault();
              void verify(false);
            }
          }}
        />
        <CButton
          type="button"
          variant="secondary"
          disabled={disabled || busy || (!configured && !input.trim())}
          onClick={() => void verify(false)}
        >
          {busy ? t("mirror.verifying") : t("mirror.verify")}
        </CButton>
        {configured && (
          <CButton
            type="button"
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => void verify(true)}
          >
            {t("common.delete")}
          </CButton>
        )}
      </div>
      {message && (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
