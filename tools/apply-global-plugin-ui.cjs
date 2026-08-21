const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();

function patch(relativePath, replacements) {
  const filePath = path.join(root, relativePath);
  let source = fs.readFileSync(filePath, 'utf8');
  for (const [before, after, label] of replacements) {
    const count = source.split(before).length - 1;
    if (count !== 1) {
      throw new Error(`${relativePath}: expected one ${label}, found ${count}`);
    }
    source = source.replace(before, after);
  }
  fs.writeFileSync(filePath, source);
  console.log(`patched ${relativePath}`);
}

patch('src/App.tsx', [
  [
    "import { PullRequestsView } from './features/pull-requests/PullRequestsView';\n",
    "import { PullRequestsView } from './features/pull-requests/PullRequestsView';\nimport { PluginLibraryView } from './features/plugins/PluginLibraryView';\nimport { usePluginWorkspace } from './features/plugins/hooks/usePluginWorkspace';\n",
    'plugin workspace imports',
  ],
  [
    "  const [expandedBrowserAppSessionId, setExpandedBrowserAppSessionId] = useState<string | null>(\n    null,\n  );\n  const cliLaunchHandled = useRef(false);\n",
    "  const [expandedBrowserAppSessionId, setExpandedBrowserAppSessionId] = useState<string | null>(\n    null,\n  );\n  const pluginWorkspace = usePluginWorkspace();\n  const cliLaunchHandled = useRef(false);\n",
    'plugin workspace controller',
  ],
  [
    "  const showUtilityPane = !embedded && !!activeSession && utilityPanel.open && !showWizard;\n  // The pull request workspace owns the whole content area and the top-right\n  // corner of its own toolbar, so the session-scoped overlays (Context panel)\n  // and floating window buttons stay out of it instead of covering its header.\n  const prWorkspaceView = !embedded && state.mainView === 'pull-requests';\n  // An expanded browser covers the full content row, which would leave the pull\n  // request workspace hidden and non-interactive behind it. The expansion stays\n  // owned by the browser pane; this view simply does not take part in it.\n  const browserExpanded =\n    !!activeSession &&\n    showUtilityPane &&\n    !prWorkspaceView &&\n    activeUtilityTab?.tool === 'browser' &&\n    expandedBrowserAppSessionId === activeSession.appSessionId;\n",
    "  const pluginWorkspaceView = !embedded && pluginWorkspace.isOpen;\n  const showUtilityPane =\n    !embedded && !pluginWorkspaceView && !!activeSession && utilityPanel.open && !showWizard;\n  // Full workspaces own the content area and their own toolbar, so session-scoped\n  // overlays and floating controls stay out of the way.\n  const prWorkspaceView = !embedded && state.mainView === 'pull-requests';\n  const fullWorkspaceView = prWorkspaceView || pluginWorkspaceView;\n  // An expanded browser covers the full content row, so full workspaces do not\n  // participate in browser expansion.\n  const browserExpanded =\n    !!activeSession &&\n    showUtilityPane &&\n    !fullWorkspaceView &&\n    activeUtilityTab?.tool === 'browser' &&\n    expandedBrowserAppSessionId === activeSession.appSessionId;\n",
    'full workspace routing state',
  ],
  [
    "  const rightPanelVisible =\n    !focused && !prWorkspaceView && !showUtilityPane && state.rightPanelOpen && hasSessionContent;\n",
    "  const rightPanelVisible =\n    !focused &&\n    !fullWorkspaceView &&\n    !showUtilityPane &&\n    state.rightPanelOpen &&\n    hasSessionContent;\n",
    'workspace overlay suppression',
  ],
  [
    "              <Sidebar workspaceScopes={workspaceScopes} />\n",
    "              <Sidebar\n                workspaceScopes={workspaceScopes}\n                pluginLibraryOpen={pluginWorkspaceView}\n                onOpenPluginLibrary={pluginWorkspace.open}\n                onLeavePluginLibrary={pluginWorkspace.close}\n              />\n",
    'sidebar plugin props',
  ],
  [
    "              {!embedded && state.mainView === 'pull-requests' ? (\n                <PullRequestsView />\n",
    "              {pluginWorkspaceView ? (\n                <PluginLibraryView\n                  selectedSlug={pluginWorkspace.selectedSlug}\n                  onSelectPlugin={pluginWorkspace.select}\n                  onUsePlugin={pluginWorkspace.useInComposer}\n                  onOpenSettings={() => {\n                    dispatch({ type: 'TOGGLE_SETTINGS' });\n                  }}\n                />\n              ) : !embedded && state.mainView === 'pull-requests' ? (\n                <PullRequestsView />\n",
    'plugin workspace render route',
  ],
  [
    "      {!showUtilityPane && !prWorkspaceView && (\n",
    "      {!showUtilityPane && !fullWorkspaceView && (\n",
    'floating toolbar suppression',
  ],
]);

patch('src/components/Sidebar.tsx', [
  [
    "import {\n  CirclePlus,\n",
    "import {\n  Blocks,\n  CirclePlus,\n",
    'Blocks icon import',
  ],
  [
    "export default function Sidebar({ workspaceScopes }: { workspaceScopes: WorkspaceScope[] }) {\n",
    "export default function Sidebar({\n  workspaceScopes,\n  pluginLibraryOpen,\n  onOpenPluginLibrary,\n  onLeavePluginLibrary,\n}: {\n  workspaceScopes: WorkspaceScope[];\n  pluginLibraryOpen: boolean;\n  onOpenPluginLibrary: () => void;\n  onLeavePluginLibrary: () => void;\n}) {\n",
    'sidebar plugin props',
  ],
  [
    "  const startChat = (cwd: string) => {\n    dispatch({ type: 'START_CHAT', cwd, executionMode: cwd ? 'worktree' : 'local' });\n  };\n",
    "  const startChat = (cwd: string) => {\n    onLeavePluginLibrary();\n    dispatch({ type: 'START_CHAT', cwd, executionMode: cwd ? 'worktree' : 'local' });\n  };\n",
    'leave plugins on new chat',
  ],
  [
    "  const handleSelectSession = useCallback(\n    (appSessionId: string) => {\n      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });\n",
    "  const handleSelectSession = useCallback(\n    (appSessionId: string) => {\n      onLeavePluginLibrary();\n      dispatch({ type: 'SET_ACTIVE_SESSION', id: appSessionId });\n",
    'leave plugins on session select',
  ],
  [
    "    [dispatch, unreadOnly],\n  );\n",
    "    [dispatch, onLeavePluginLibrary, unreadOnly],\n  );\n",
    'session callback dependencies',
  ],
  [
    "          onClick={() => {\n            const cwd = resolvePrWorkspaceCwd({\n",
    "          onClick={() => {\n            onLeavePluginLibrary();\n            const cwd = resolvePrWorkspaceCwd({\n",
    'leave plugins on pull requests',
  ],
  [
    "            state.mainView === 'pull-requests'\n              ? 'bg-droid-active text-droid-text'\n",
    "            state.mainView === 'pull-requests' && !pluginLibraryOpen\n              ? 'bg-droid-active text-droid-text'\n",
    'pull requests active state',
  ],
  [
    "              state.mainView === 'pull-requests'\n                ? 'text-droid-text'\n",
    "              state.mainView === 'pull-requests' && !pluginLibraryOpen\n                ? 'text-droid-text'\n",
    'pull requests icon active state',
  ],
  [
    "          Pull requests\n        </button>\n      </div>\n",
    "          Pull requests\n        </button>\n        <button\n          data-testid=\"plugins-nav\"\n          onClick={onOpenPluginLibrary}\n          className={`group mt-0.5 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors ${\n            pluginLibraryOpen\n              ? 'bg-droid-active text-droid-text'\n              : 'text-droid-text hover:bg-droid-elevated'\n          }`}\n        >\n          <Blocks\n            className={`h-4 w-4 shrink-0 transition-colors ${\n              pluginLibraryOpen\n                ? 'text-droid-text'\n                : 'text-droid-text-secondary group-hover:text-droid-text'\n            }`}\n            strokeWidth={1.75}\n          />\n          Plugins\n        </button>\n      </div>\n",
    'plugins navigation row',
  ],
]);
