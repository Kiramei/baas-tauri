import { useId, type ComponentProps, type ReactNode } from "react";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsControls";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import SwitchButton from "@/components/ui/SwitchButton";

export function ConfigurationGroup({ title, children }: { title: string; children: ReactNode }) {
  return <SettingsGroup title={title}>{children}</SettingsGroup>;
}

export function ConfigurationRow(props: ComponentProps<typeof SettingsRow>) {
  return <SettingsRow {...props} className={`configuration-row ${props.className ?? ""}`} />;
}

export function ConfigurationInput({
  label,
  description,
  tooltip,
  className,
  ...props
}: ComponentProps<typeof FormInput> & { description?: string }) {
  const id = useId();
  if (!label) return <FormInput {...props} className={className} />;
  return (
    <ConfigurationRow label={label} description={description ?? tooltip} className={className}>
      <FormInput {...props} id={props.id ?? id} aria-label={props["aria-label"] ?? label} />
    </ConfigurationRow>
  );
}

export function ConfigurationSelect({
  label,
  description,
  tooltip,
  className,
  ...props
}: ComponentProps<typeof FormSelect> & { description?: string }) {
  if (!label) return <FormSelect {...props} className={className} />;
  return (
    <ConfigurationRow label={label} description={description ?? tooltip} className={className}>
      <FormSelect {...props} ariaLabel={props.ariaLabel ?? label} />
    </ConfigurationRow>
  );
}

export function ConfigurationToggle({
  label,
  description,
  checked,
  onChange,
  className,
  children,
  disabled,
  iconOnly,
  ...props
}: ComponentProps<typeof SwitchButton> & { description?: string }) {
  const descriptionId = useId();
  if (children || iconOnly)
    return (
      <SwitchButton
        {...props}
        label={label}
        checked={checked}
        onChange={onChange}
        className={className}
        disabled={disabled}
        iconOnly={iconOnly}
      >
        {children}
      </SwitchButton>
    );
  return (
    <div className={`settings-row configuration-row ${className ?? ""}`}>
      <div className="settings-row-copy">
        <div className="settings-label">{label}</div>
        {description && (
          <p id={descriptionId} className="settings-description">
            {description}
          </p>
        )}
      </div>
      <button
        {...props}
        type="button"
        role="switch"
        aria-label={props["aria-label"] ?? label}
        aria-checked={checked}
        aria-describedby={description ? descriptionId : undefined}
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className="control-switch"
      >
        <span aria-hidden="true" className="control-switch-thumb" />
      </button>
    </div>
  );
}
