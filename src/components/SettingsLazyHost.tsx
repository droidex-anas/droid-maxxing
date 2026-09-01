import { Suspense } from 'react';
import { motion } from 'framer-motion';
import { SettingsPanelSkeleton } from './skeletons/WorkspaceSkeletons';
import { LazySettingsPanel } from '../lib/lazySurfaces';

// Sync motion shell so App's AnimatePresence can run enter/exit while the
// settings chunk loads behind an in-layout skeleton.
export function SettingsLazyHost() {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex bg-droid-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <Suspense fallback={<SettingsPanelSkeleton />}>
        <LazySettingsPanel />
      </Suspense>
    </motion.div>
  );
}
