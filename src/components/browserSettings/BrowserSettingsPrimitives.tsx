import type { ReactNode } from 'react';

export function BrowserSettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-droid-border/80 bg-droid-surface">{children}</div>
  );
}

export function BrowserSettingRow({
  label,
  description,
  children,
  border = false,
}: {
  label: string;
  description: ReactNode;
  children: ReactNode;
  border?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[66px] items-center justify-between gap-5 px-4 py-3.5 ${
        border ? 'border-t border-droid-border/50' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="text-[13px] tracking-tight text-droid-text">{label}</div>
        <div className="mt-0.5 text-[11.5px] leading-[17px] text-droid-text-muted">
          {description}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function BrowserSettingsGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-7">
      <div className="mb-2.5 flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-droid-text-muted">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function BrowserActionButton({
  children,
  onClick,
  disabled = false,
  danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl px-3 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'bg-red-500/10 text-red-300 hover:bg-red-500/20'
          : 'bg-droid-elevated/80 text-droid-text hover:bg-droid-elevated'
      }`}
    >
      {children}
    </button>
  );
}

export function ExactSiteList({
  emptyLabel,
  sites,
  onRevoke,
  disabled = false,
}: {
  emptyLabel: string;
  sites: string[];
  onRevoke: (origin: string) => void;
  disabled?: boolean;
}) {
  if (sites.length === 0) {
    return <div className="px-4 py-3.5 text-[11.5px] text-droid-text-muted">{emptyLabel}</div>;
  }
  return (
    <ul aria-label="Exact site grants" className="divide-y divide-droid-border/50">
      {sites.map((origin) => (
        <li key={origin} className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="min-w-0 truncate font-mono text-[11.5px] text-droid-text-secondary">
            {origin}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onRevoke(origin);
            }}
            className="rounded-lg px-2.5 py-1 text-[11px] text-droid-text-muted transition-colors hover:bg-droid-elevated hover:text-droid-text disabled:opacity-50"
            aria-label={`Remove grant for ${origin}`}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
