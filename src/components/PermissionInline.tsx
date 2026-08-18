import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondPermission } from '../lib/commands';
import type { PermissionKind, PermissionOutcome } from '../types/bridge';

const EASE = [0.16, 1, 0.3, 1] as const;
const ACCENT = 'var(--droid-accent)';
// Permission asks are an attention signal: a small warning dot marks the ask
// while the card itself stays on the standard elevated surface.
const WARN = 'var(--droid-orange)';

// A plain-language explanation of what Droid is asking to do, so the prompt
// is never just a bare "Permission required".
const KIND_PROMPT: Record<PermissionKind, string> = {
  exec: 'Droid wants to run a terminal command',
  edit: 'Droid wants to edit a file',
  create: 'Droid wants to create a file',
  apply_patch: 'Droid wants to apply a code patch',
  mcp: 'Droid wants to use an external tool',
  spec: 'Droid wants to finish planning',
  mission_plan: 'Droid proposed a mission plan',
  other: 'Droid is requesting permission to proceed',
};

// Backend titles that only restate the kind add nothing under the reason
// line; meaningful ones (e.g. MCP "server · tool") are shown as a subtitle.
const GENERIC_TITLES = new Set([
  'Permission required',
  'Run command',
  'Edit file',
  'Create file',
  'Apply patch',
]);

function cleanDetail(detail: string | undefined): string {
  const t = (detail ?? '').trim();
  if (!t || t === '{}' || t === '[]' || t === 'null' || t === 'undefined') return '';
  return t;
}

function CommandDetail({ command }: { command: string }) {
  return (
    <div className="max-h-32 overflow-y-auto rounded-xl border border-droid-border/70 bg-droid-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed">
      <span className="whitespace-pre-wrap break-words text-droid-text">{command}</span>
    </div>
  );
}

function FileDetail({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  const hasDir = slash > 0 && !path.includes(' ');
  const dir = hasDir ? path.slice(0, slash + 1) : '';
  const name = hasDir ? path.slice(slash + 1) : path;
  return (
    <div className="rounded-xl border border-droid-border/70 bg-droid-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed">
      <span className="break-all">
        {dir && <span className="text-droid-text-muted/60">{dir}</span>}
        <span className="text-droid-text">{name}</span>
      </span>
    </div>
  );
}

function Detail({ kind, detail }: { kind: PermissionKind; detail: string }) {
  if (kind === 'exec') return <CommandDetail command={detail} />;
  if (kind === 'edit' || kind === 'create' || kind === 'apply_patch') {
    return <FileDetail path={detail} />;
  }
  return (
    <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-droid-border/70 bg-droid-bg/50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-droid-text-secondary">
      {detail}
    </div>
  );
}

export default function PermissionInline() {
  const dispatch = useStoreDispatch();
  const reduceMotion = useReducedMotion();
  // Permission requests are session-scoped: only surface the one belonging to
  // the chat the user is looking at.
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      pendingPermissions: current.pendingPermissions,
    }),
    shallowEqual,
  );
  const activeId = state.activeAppSessionId;
  const req = activeId ? state.pendingPermissions[activeId] : undefined;

  // Spec/mission plans use the dedicated approval bar (<PlanApprovalInline />).
  if (!req || req.kind === 'spec' || req.kind === 'mission_plan') return null;

  const detail = cleanDetail(req.detail);
  const reason = KIND_PROMPT[req.kind];
  const subtitle = req.title && !GENERIC_TITLES.has(req.title) ? req.title : '';

  const respond = (outcome: PermissionOutcome) => {
    respondPermission(req.appSessionId, req.requestId, outcome);
    dispatch({ type: 'CLEAR_PERMISSION', appSessionId: req.appSessionId });
  };

  return (
    <AnimatePresence>
      <motion.div
        key={req.requestId}
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.985 }}
        transition={{ duration: reduceMotion ? 0 : 0.22, ease: EASE }}
        className="mb-2.5 overflow-hidden rounded-2xl border border-droid-border bg-droid-elevated shadow-[0_10px_32px_rgba(0,0,0,0.35)]"
      >
        <div className="px-4 pt-3.5 pb-3">
          <div className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: WARN }}
              aria-hidden
            />
            <div className="min-w-0 text-[13px] font-medium leading-snug text-droid-text break-words">
              {reason}
            </div>
          </div>
          {subtitle && (
            <div className="mt-0.5 truncate pl-3.5 text-[11.5px] text-droid-text-muted">
              {subtitle}
            </div>
          )}
        </div>

        {detail && (
          <div className="px-4 pb-3">
            <Detail kind={req.kind} detail={detail} />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 px-4 pb-3.5">
          <button
            onClick={() => {
              respond('cancel');
            }}
            className="rounded-full px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-surface hover:text-droid-text"
          >
            Deny
          </button>
          <button
            onClick={() => {
              respond('proceed_always');
            }}
            className="rounded-full border border-droid-border bg-droid-bg/40 px-3.5 py-1.5 text-[12px] font-medium text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
          >
            Always allow
          </button>
          <button
            onClick={() => {
              respond('proceed_once');
            }}
            className="rounded-full px-4 py-1.5 text-[12px] font-semibold text-droid-bg transition-opacity hover:opacity-90"
            style={{ background: ACCENT }}
          >
            Allow once
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
