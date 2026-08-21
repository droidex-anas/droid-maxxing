import { useCallback, useState, type SetStateAction } from 'react';
import { AppWindow, Blocks } from 'lucide-react';
import type { SkillInfo } from '../../types/bridge';
import type { DraftSelection } from './DraftSelections';

export interface DraftSelectionsState {
  activeSkills: SkillInfo[];
  setActiveSkills: (value: SetStateAction<SkillInfo[]>) => void;
  visualizeSelected: boolean;
  setVisualizeSelected: (value: boolean) => void;
  /** The rows painted onto the draft's first line, in the order they read. */
  items: DraftSelection[];
  hasSelection: boolean;
  /** How far the first line must start in, measured by the rendered row. */
  indentPx: number;
  setIndentPx: (px: number) => void;
  clear: () => void;
}

// What the next prompt carries besides its words: the skills it invokes and the
// Visualize plugin. They are selections rather than draft text, so submitting
// re-attaches the command and the words stay the user's own, and they read as one
// row on the draft's first line.
//
// Every change bumps the composer's draft revision through onDraftEdited, since a
// selection made while a turn is in flight means the draft is no longer the one
// that was submitted and must survive the post-submit clear.
export function useDraftSelections(onDraftEdited: () => void): DraftSelectionsState {
  const [activeSkills, setActiveSkillsState] = useState<SkillInfo[]>([]);
  const [visualizeSelected, setVisualizeSelectedState] = useState(false);
  const [indentPx, setIndentPx] = useState(0);

  // Stable, so an effect that clears the composer on a session switch can depend
  // on these honestly instead of firing on every render.
  const setActiveSkills = useCallback(
    (value: SetStateAction<SkillInfo[]>) => {
      onDraftEdited();
      setActiveSkillsState(value);
    },
    [onDraftEdited],
  );
  const setVisualizeSelected = useCallback(
    (value: boolean) => {
      onDraftEdited();
      setVisualizeSelectedState(value);
    },
    [onDraftEdited],
  );
  const clear = useCallback(() => {
    onDraftEdited();
    setActiveSkillsState([]);
    setVisualizeSelectedState(false);
  }, [onDraftEdited]);

  const items: DraftSelection[] = [
    ...(visualizeSelected
      ? [
          {
            key: 'visualize',
            icon: AppWindow,
            label: 'Visualize',
            removeLabel: 'Remove Visualize',
            onRemove: () => {
              setVisualizeSelected(false);
            },
          },
        ]
      : []),
    ...activeSkills.map((skill) => ({
      key: skill.filePath,
      icon: Blocks,
      label: skill.name,
      removeLabel: `Remove the ${skill.name} skill`,
      onRemove: () => {
        setActiveSkills((prev) => prev.filter((s) => s.filePath !== skill.filePath));
      },
    })),
  ];

  return {
    activeSkills,
    setActiveSkills,
    visualizeSelected,
    setVisualizeSelected,
    items,
    hasSelection: items.length > 0,
    indentPx,
    setIndentPx,
    clear,
  };
}
