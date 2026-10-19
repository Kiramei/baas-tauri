import { useId, type ComponentProps, type ReactNode } from "react";
import { FormSelect } from "@/components/ui/FormSelect";
import "./settings.css";
import "@/components/ui/control-switch.css";

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section className="settings-group" aria-labelledby={titleId}>
      <h3 id={titleId} className="settings-group-title">
        {title}
      </h3>
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  className = "",
}: {
  label: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row-copy">
        <div className="settings-label">{label}</div>
        {description && <p className="settings-description">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsSelect({
  label = "",
  description,
  className,
  ...props
}: ComponentProps<typeof FormSelect> & { description?: string }) {
  return (
    <SettingsRow label={label} description={description} className={className}>
      <FormSelect
        {...props}
        ariaLabel={props.ariaLabel ?? label}
        className="settings-select-control"
      />
    </SettingsRow>
  );
}

export function SettingsToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <div className="settings-label">{label}</div>
        {description && (
          <p id={descriptionId} className="settings-description">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        aria-describedby={description ? descriptionId : undefined}
        onClick={() => onChange(!checked)}
        className="control-switch"
      >
        <span aria-hidden="true" className="control-switch-thumb" />
      </button>
    </div>
  );
}
