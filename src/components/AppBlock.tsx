import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { Play, Square } from 'lucide-react';
import {
  DEFAULT_APP_HEIGHT,
  appBlockHeightFromMessage,
  appBlockReducer,
  createAppDocument,
  currentAppBlockTheme,
} from './appBlockRuntime';

export function RunningAppFrame({ source, instanceId }: { source: string; instanceId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_APP_HEIGHT);
  const theme = useMemo(currentAppBlockTheme, []);
  const document = useMemo(
    () => createAppDocument(source, instanceId, theme),
    [instanceId, source, theme],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const nextHeight = appBlockHeightFromMessage(event.data, instanceId);
      if (nextHeight !== undefined) setHeight(nextHeight);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [instanceId]);

  return (
    <iframe
      ref={iframeRef}
      title="Interactive App block"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={document}
      className="block w-full bg-transparent transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{ height }}
    />
  );
}

export function AppBlock({ source }: { source: string }) {
  const [state, dispatch] = useReducer(appBlockReducer, 'idle');
  const isRunning = state === 'running';
  const instanceId = useId();
  const reduceMotion = useReducedMotion();
  const transition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  return (
    <motion.div
      layout="size"
      transition={{ layout: transition }}
      className="my-2.5 overflow-hidden rounded-xl border border-droid-border bg-droid-elevated/40"
    >
      <div className="flex h-8 items-center justify-between border-b border-droid-border bg-droid-surface/60 px-3">
        <span className="text-[10px] font-medium uppercase tracking-wider text-droid-text-muted">
          App
        </span>
        <button
          type="button"
          aria-label={isRunning ? 'Stop app' : 'Play app'}
          onClick={() => {
            dispatch(isRunning ? 'stop' : 'play');
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-medium text-droid-text-secondary transition-colors hover:bg-droid-elevated hover:text-droid-text"
        >
          {isRunning ? (
            <Square className="h-3 w-3 fill-current" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
          {isRunning ? 'Stop' : 'Play'}
        </button>
      </div>
      <AnimatePresence initial={false} mode="wait">
        {isRunning ? (
          <motion.div
            key="running"
            initial={reduceMotion ? false : { height: 0, opacity: 0, y: -4 }}
            animate={{ height: 'auto', opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <RunningAppFrame source={source} instanceId={instanceId} />
          </motion.div>
        ) : (
          <motion.pre
            key="source"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={transition}
            className="max-h-72 overflow-auto p-3.5"
          >
            <code className="whitespace-pre font-mono text-[12px] leading-[1.65] text-droid-text-secondary">
              {source}
            </code>
          </motion.pre>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
