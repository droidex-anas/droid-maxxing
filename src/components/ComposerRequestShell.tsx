import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

const EASE = [0.16, 1, 0.3, 1] as const;

interface ComposerRequestShellProps {
  label: string;
  title: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
}

// Shared composer replacement for every interaction that blocks on the user.
// It owns the common layout and motion while each request type owns its state,
// content, and response behavior.
export function ComposerRequestShell({
  label,
  title,
  description,
  detail,
  children,
  actions,
}: ComposerRequestShellProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.99 }}
      transition={{ duration: 0.2, ease: EASE }}
      className="overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated"
    >
      <div className="px-4 pb-3 pt-3.5">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-droid-text-muted">
          {label}
        </div>
        <div className="text-[14px] font-medium leading-[1.45] text-droid-text">{title}</div>
        {description && (
          <div className="mt-1.5 max-w-2xl text-[12.5px] leading-[1.55] text-droid-text-secondary">
            {description}
          </div>
        )}
        {detail && <div className="mt-3">{detail}</div>}
        {children}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-droid-border px-3 py-2.5">
        {actions}
      </div>
    </motion.section>
  );
}
