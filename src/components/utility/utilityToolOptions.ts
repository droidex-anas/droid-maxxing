import { ChangesIcon, Files, Globe, SquareTerminal, type IconComponent } from '@droidex/icons';
import type { UtilityTool } from '../../lib/utilityPanel';

export interface UtilityToolOption {
  tool: UtilityTool;
  label: string;
  icon: IconComponent;
  shortcut: string;
}

export const UTILITY_TOOL_OPTIONS: UtilityToolOption[] = [
  { tool: 'review', label: 'Review', icon: ChangesIcon, shortcut: '⌘⇧R' },
  { tool: 'terminal', label: 'Terminal', icon: SquareTerminal, shortcut: '⌃`' },
  { tool: 'browser', label: 'Browser', icon: Globe, shortcut: '⌘⇧B' },
  { tool: 'files', label: 'Files', icon: Files, shortcut: '⌘⇧F' },
];

export function utilityToolOption(tool: UtilityTool): UtilityToolOption {
  return UTILITY_TOOL_OPTIONS.find((option) => option.tool === tool) ?? UTILITY_TOOL_OPTIONS[0];
}
