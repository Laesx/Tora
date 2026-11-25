import React from "react";

/**
 * Settings building blocks: a card of rows split by dividers, one row per setting (label + optional hint
 * on the left, control on the right), a switch and a segmented control. Every row has the same padding
 * above and below, so rows with and without a hint line up.
 */

export const SettingsCard: React.FC<{
  icon?: React.ElementType;
  title: React.ReactNode;
  /** Buttons at the right of the title */
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon: Icon, title, actions, children }) => (
  <section className="bg-bg-secondary border border-border-subtle rounded-2xl px-5 pt-4 pb-1">
    <div className="flex items-center justify-between gap-3 min-h-[28px]">
      <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-accent" />}
        {title}
      </h2>
      {actions && <div className="flex items-center gap-1.5">{actions}</div>}
    </div>
    <div className="divide-y divide-border-subtle">{children}</div>
  </section>
);

interface RowTextProps {
  icon?: React.ElementType;
  label: React.ReactNode;
  hint?: React.ReactNode;
}

const RowText: React.FC<RowTextProps> = ({ icon: Icon, label, hint }) => (
  <div className="min-w-0">
    <div className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
      {Icon && <Icon className="w-3.5 h-3.5 text-accent shrink-0" />}
      {label}
    </div>
    {hint && <div className="text-[11px] text-text-muted mt-0.5">{hint}</div>}
  </div>
);

interface RowLayoutProps {
  /** Indented under the setting it depends on */
  indent?: boolean;
  disabled?: boolean;
  /** No padding of its own (a row inside a card that isn't a `SettingsCard`) */
  flush?: boolean;
}

const rowClass = ({ indent, disabled, flush }: RowLayoutProps) =>
  `${flush ? "" : "py-3 min-h-[52px]"} ${indent ? "pl-6" : ""} ${disabled ? "opacity-50" : ""}`;

/** A setting with its control on the right; `stacked` puts the control under the text instead (wide inputs). */
export const SettingRow: React.FC<
  RowTextProps & RowLayoutProps & { stacked?: boolean; children?: React.ReactNode }
> = ({ icon, label, hint, indent, disabled, flush, stacked, children }) =>
  stacked ? (
    <div className={`${rowClass({ indent, disabled, flush })} space-y-2`}>
      <RowText icon={icon} label={label} hint={hint} />
      {children}
    </div>
  ) : (
    <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${rowClass({ indent, disabled, flush })}`}>
      <RowText icon={icon} label={label} hint={hint} />
      {children && <div className="shrink-0 flex items-center gap-2">{children}</div>}
    </div>
  );

/** An on / off switch (`role="switch"`); inside a `<label>` the whole label toggles it. */
export const Toggle: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
}> = ({ checked, onChange, disabled, "aria-label": ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed ${
      checked ? "bg-accent border-accent" : "bg-bg-tertiary border-border-subtle"
    }`}
  >
    <span
      className={`inline-block h-3.5 w-3.5 rounded-full shadow transition-transform ${
        checked ? "translate-x-[18px] bg-white" : "translate-x-[2px] bg-text-muted"
      }`}
    />
  </button>
);

/** A setting that is a switch: the whole row is clickable. */
export const ToggleRow: React.FC<
  RowTextProps &
    RowLayoutProps & {
      checked: boolean;
      onChange: (checked: boolean) => void;
      /** Tighter rows inside a `SettingGroup` */
      compact?: boolean;
    }
> = ({ icon, label, hint, indent, disabled, flush, compact, checked, onChange }) => (
  <label
    className={`flex items-center justify-between gap-4 ${
      compact ? `py-1.5 ${indent ? "pl-6" : ""} ${disabled ? "opacity-50" : ""}` : rowClass({ indent, disabled, flush })
    } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
  >
    <RowText icon={icon} label={label} hint={hint} />
    <Toggle checked={checked} onChange={onChange} disabled={disabled} />
  </label>
);

/** A few related switches under one heading ("Open Now Playing when…"), with no dividers between them. */
export const SettingGroup: React.FC<RowTextProps & RowLayoutProps & { children: React.ReactNode }> = ({
  icon,
  label,
  hint,
  indent,
  disabled,
  children,
}) => (
  <div className={`py-3 ${indent ? "pl-6" : ""} ${disabled ? "opacity-50" : ""}`}>
    <RowText icon={icon} label={label} hint={hint} />
    <div className="mt-1 pl-3">{children}</div>
  </div>
);

/** A small row of mutually exclusive buttons (title language, clock, update mode). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center bg-bg-primary p-1 rounded-xl border border-border-subtle">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={`px-3 py-1 rounded-lg text-xs font-semibold transition disabled:cursor-not-allowed ${
            value === o.id ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
