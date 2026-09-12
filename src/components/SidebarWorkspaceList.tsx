import { useSidebarPagination } from '../hooks/useSidebarPagination';
import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Plus, FolderOpen } from 'lucide-react';
import { SIDEBAR_VISIBLE_SESSION_LIMIT, type WorkspaceSection } from '../lib/workspaces';
import type { SessionSummary } from '../types/bridge';
import { SidebarWorkspaceRow } from './SidebarWorkspaceRow';
import { SidebarSessionList } from './SidebarSessionList';

const EASE = [0.16, 1, 0.3, 1] as const;

// Animated expand/collapse for sidebar sections, no chrome. Reduced-motion
// users get an instantaneous toggle (zero-duration transitions, same pattern
// as SubagentsDock).
function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface Props {
  workspaces: WorkspaceSection[];
  chatSessions: SessionSummary[];
  pinnedSessions: SessionSummary[];
  isFiltered: boolean;
  activeAppSessionId: string | null;
  renderRow: (session: SessionSummary) => ReactNode;
  onAddWorkspace: () => Promise<void>;
  onNewChat: (cwd: string) => void;
  onRemoveWorkspace: (cwd: string) => void;
  onShowEarlierSessions: (cwds: readonly string[]) => void;
  limit?: number;
}

// Owns expansion and pagination for the familiar workspace / pinned / chat lists.
export function SidebarWorkspaceList({
  workspaces,
  chatSessions,
  pinnedSessions,
  isFiltered,
  activeAppSessionId,
  renderRow,
  onAddWorkspace,
  onNewChat,
  onRemoveWorkspace,
  onShowEarlierSessions,
  limit = SIDEBAR_VISIBLE_SESSION_LIMIT,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { defaultVisibleCount, visibleCountFor, showMore, showLess } = useSidebarPagination(limit);
  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderSessionList = (
    sectionKey: string,
    sessions: SessionSummary[],
    earlier?: { count: number; onShow: () => void },
  ) => (
    <SidebarSessionList
      sessions={sessions}
      defaultVisibleCount={defaultVisibleCount}
      visibleCount={visibleCountFor(sectionKey)}
      activeAppSessionId={activeAppSessionId}
      renderRow={renderRow}
      onShowMore={() => {
        showMore(sectionKey);
      }}
      onShowLess={() => {
        showLess(sectionKey);
      }}
      earlierSessionCount={earlier?.count}
      onShowEarlier={earlier?.onShow}
    />
  );

  if (
    isFiltered &&
    workspaces.length === 0 &&
    chatSessions.length === 0 &&
    pinnedSessions.length === 0
  ) {
    return <p className="px-3 py-2 text-[12px] text-droid-text-muted">No tasks match this view.</p>;
  }

  return (
    <>
      {/* Pinned — every pinned chat across workspaces, hidden while empty */}
      {pinnedSessions.length > 0 &&
        (() => {
          const open = !collapsed.has('__pinned__');
          return (
            <div>
              <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
                <button
                  onClick={() => {
                    toggleCollapse('__pinned__');
                  }}
                  aria-expanded={open}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
                >
                  <ChevronRight
                    className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                  />
                  <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                    Pinned
                  </span>
                </button>
              </div>
              <Expand open={open}>{renderSessionList('__pinned__', pinnedSessions)}</Expand>
            </div>
          );
        })()}

      {/* Workspaces — folder-scoped, where sessions run (main area) */}
      {(() => {
        // Filtered views hide sections with no matching rows.
        if (isFiltered && workspaces.length === 0) return null;
        const open = !collapsed.has('__workspaces__');
        return (
          <div>
            <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
              <button
                onClick={() => {
                  toggleCollapse('__workspaces__');
                }}
                aria-expanded={open}
                className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
              >
                <ChevronRight
                  className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                  Workspaces
                </span>
              </button>
              <button
                onClick={() => {
                  void onAddWorkspace();
                }}
                title="Add workspace"
                className="p-1 rounded-md text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/60 transition-colors shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>

            <Expand open={open}>
              <div className="space-y-2.5">
                {workspaces.map((ws) => {
                  const wsOpen = !collapsed.has(ws.cwd);
                  return (
                    <SidebarWorkspaceRow
                      key={ws.cwd}
                      name={ws.name}
                      open={wsOpen}
                      onToggle={() => {
                        toggleCollapse(ws.cwd);
                      }}
                      onNewChat={() => {
                        onNewChat(ws.cwd);
                      }}
                      onRemove={() => {
                        onRemoveWorkspace(ws.cwd);
                      }}
                    >
                      <Expand open={wsOpen}>
                        {renderSessionList(ws.cwd, ws.sessions, {
                          count: ws.earlierSessionCount,
                          onShow: () => {
                            onShowEarlierSessions(ws.executionCwds);
                          },
                        })}
                      </Expand>
                    </SidebarWorkspaceRow>
                  );
                })}

                {workspaces.length === 0 && (
                  <button
                    onClick={() => {
                      void onAddWorkspace();
                    }}
                    className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left text-droid-text-muted hover:text-droid-text hover:bg-droid-elevated/40 transition-colors"
                  >
                    <FolderOpen className="w-4 h-4 shrink-0" />
                    <span className="text-[13px]">Open workspace</span>
                  </button>
                )}
              </div>
            </Expand>
          </div>
        );
      })()}

      {/* Chats — plain, folder-less conversations */}
      {(() => {
        if (isFiltered && chatSessions.length === 0) return null;
        const open = !collapsed.has('__chats__');
        return (
          <div>
            <div className="group/header flex items-center gap-1 px-1 pt-1 pb-1.5">
              <button
                onClick={() => {
                  toggleCollapse('__chats__');
                }}
                aria-expanded={open}
                className="flex items-center gap-2 min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 hover:bg-droid-elevated/40 transition-colors"
              >
                <ChevronRight
                  className={`w-3 h-3 text-droid-text-muted/70 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span className="text-[11px] font-medium tracking-wide text-droid-text-muted">
                  Chats
                </span>
              </button>
            </div>
            <Expand open={open}>
              {chatSessions.length === 0 ? (
                <div className="mt-0.5 px-3 py-2 text-[12px] text-droid-text-muted">
                  No chats yet.
                </div>
              ) : (
                renderSessionList('__chats__', chatSessions)
              )}
            </Expand>
          </div>
        );
      })()}
    </>
  );
}
