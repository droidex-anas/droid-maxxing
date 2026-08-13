import { AnimatePresence } from 'framer-motion';
import { shallowEqual, useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { respondPermission } from '../lib/commands';
import { permissionPurpose } from '../lib/permissionPurpose';
import type { PermissionKind, PermissionOutcome } from '../types/bridge';
import { ComposerRequestShell } from './ComposerRequestShell';

const ACCENT = 'var(--droid-accent)';

const ACTION_TITLE: Record<PermissionKind, string> = {
  exec: 'Allow Droid to run this command?',
  edit: 'Allow Droid to edit this file?',
  create: 'Allow Droid to create this file?',
  apply_patch: 'Allow Droid to apply this patch?',
  mcp: 'Allow Droid to use this tool?',
  spec: 'Allow Droid to finish planning?',
  mission_plan: 'Allow Droid to start this mission?',
  other: 'Allow Droid to continue?',
};

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
    <div className="max-h-36 overflow-y-auto rounded-xl border border-droid-border bg-droid-bg/55 px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">
      <div className="flex gap-2 break-words">
        <span className="select-none text-droid-text-muted">$</span>
        <span className="whitespace-pre-wrap text-droid-text">{command}</span>
      </div>
    </div>
  );
}

function FileDetail({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  const hasDir = slash > 0 && !path.includes(' ');
  const dir = hasDir ? path.slice(0, slash + 1) : '';
  const name = hasDir ? path.slice(slash + 1) : path;
  return (
    <div className="rounded-xl border border-droid-border bg-droid-bg/55 px-3 py-2.5 font-mono text-[11.5px] leading-[1.6]">
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
    <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-droid-border bg-droid-bg/55 px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] text-droid-text-secondary">
      {detail}
    </pre>
  );
}

export default function PermissionInline() {
  const dispatch = useStoreDispatch();
  // Permission requests are session-scoped: only surface the one belonging to
  // the chat the user is looking at.
  const state = useStoreSelector(
    (current) => ({
      activeAppSessionId: current.activeAppSessionId,
      pendingPermissions: current.pendingPermissions,
      activeTranscript: current.activeAppSessionId
        ? current.transcripts[current.activeAppSessionId]
        : undefined,
    }),
    shallowEqual,
  );
  const activeId = state.activeAppSessionId;
  const req = activeId ? state.pendingPermissions[activeId] : undefined;

  // Spec/mission plans use the dedicated approval bar (<PlanApprovalInline />).
  if (!req || req.kind === 'spec' || req.kind === 'mission_plan') return null;

  const detail = cleanDetail(req.detail);
  const purpose = permissionPurpose(req.kind, state.activeTranscript);
  const context = req.title && !GENERIC_TITLES.has(req.title) ? req.title : '';

  const respond = (outcome: PermissionOutcome) => {
    respondPermission(req.appSessionId, req.requestId, outcome);
    dispatch({ type: 'CLEAR_PERMISSION', appSessionId: req.appSessionId });
  };

  return (
    <AnimatePresence>
      <ComposerRequestShell
        key={req.requestId}
        label="Permission"
        title={ACTION_TITLE[req.kind]}
        description={
          <>
            {purpose}
            {context && <span className="mt-1 block text-droid-text-muted">{context}</span>}
          </>
        }
        detail={detail ? <Detail kind={req.kind} detail={detail} /> : undefined}
        actions={
          <>
            <button
              type="button"
              onClick={() => {
                respond('cancel');
              }}
              className="rounded-lg px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:bg-droid-bg/50 hover:text-droid-text"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => {
                respond('proceed_always');
              }}
              className="rounded-lg border border-droid-border px-2.5 py-1.5 text-[12px] text-droid-text-secondary transition-colors hover:border-droid-border-hover hover:text-droid-text"
            >
              Always allow
            </button>
            <button
              type="button"
              onClick={() => {
                respond('proceed_once');
              }}
              className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-droid-bg transition-opacity hover:opacity-90"
              style={{ background: ACCENT }}
            >
              Allow once
            </button>
          </>
        }
      />
    </AnimatePresence>
  );
}
