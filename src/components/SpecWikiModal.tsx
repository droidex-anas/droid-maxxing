import { useStoreDispatch, useStoreSelector } from '../hooks/useStore';
import { SpecModal } from './SpecModal';

// Single full-screen spec/plan reader, driven by store state so it can be
// opened from the inline chat card, the approval bar, or the right panel.
export default function SpecWikiModal() {
  const dispatch = useStoreDispatch();
  const spec = useStoreSelector((state) => {
    const appSessionId = state.specWikiAppSessionId;
    return appSessionId ? state.sessionSpecs[appSessionId] : undefined;
  });

  return (
    <SpecModal
      open={!!spec}
      content={spec?.content ?? ''}
      title={spec?.title}
      onClose={() => {
        dispatch({ type: 'SPEC_CLOSE_WIKI' });
      }}
    />
  );
}
