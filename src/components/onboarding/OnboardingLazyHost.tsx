import { Suspense } from 'react';
import { motion } from 'framer-motion';
import type { OnboardingController } from '../../hooks/useOnboarding';
import { OnboardingSkeleton } from '../skeletons/WorkspaceSkeletons';
import { LazyOnboardingWizard } from '../../lib/lazySurfaces';

// Sync motion shell so App's AnimatePresence can run enter/exit while the wizard
// chunk loads behind an in-layout skeleton.
export function OnboardingLazyHost({
  controller,
  onComplete,
}: {
  controller: OnboardingController;
  onComplete: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col bg-droid-bg text-droid-text"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Suspense fallback={<OnboardingSkeleton />}>
        <LazyOnboardingWizard controller={controller} onComplete={onComplete} />
      </Suspense>
    </motion.div>
  );
}
