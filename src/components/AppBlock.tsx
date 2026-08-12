import { useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { AppWindow, Play, Square } from 'lucide-react';
import {
  DEFAULT_APP_HEIGHT,
  appBlockHeightFromMessage,
  appBlockMathRequestFromMessage,
  appBlockReducer,
  createAppDocument,
  currentAppBlockTheme,
  renderAppBlockMath,
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
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const nextHeight = appBlockHeightFromMessage(event.data, instanceId);
      if (nextHeight !== undefined) {
        setHeight(nextHeight);
        return;
      }
      const mathRequest = appBlockMathRequestFromMessage(event.data, instanceId);
      if (!mathRequest) return;
      void renderAppBlockMath(mathRequest)
        .then((html) => {
          if (iframeRef.current?.contentWindow !== frameWindow) return;
          frameWindow.postMessage(
            {
              type: 'droidex:math-rendered',
              instanceId,
              requestId: mathRequest.requestId,
              html,
            },
            '*',
          );
        })
        .catch(() => {
          if (iframeRef.current?.contentWindow !== frameWindow) return;
          frameWindow.postMessage(
            {
              type: 'droidex:math-rendered',
              instanceId,
              requestId: mathRequest.requestId,
            },
            '*',
          );
        });
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

export function AppBlock({ source, autoPlay = false }: { source: string; autoPlay?: boolean }) {
  const [state, dispatch] = useReducer(appBlockReducer, autoPlay ? 'running' : 'idle');
  const isRunning = state === 'running';
  const instanceId = useId();
  const previousAutoPlay = useRef(autoPlay);
  const reduceMotion = useReducedMotion();
  const transition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  useEffect(() => {
    if (autoPlay && !previousAutoPlay.current) dispatch('play');
    previousAutoPlay.current = autoPlay;
  }, [autoPlay]);

  return (
    <AnimatePresence initial={false} mode="wait">
      {isRunning ? (
        <motion.div
          key="running"
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: 4 }}
          transition={transition}
          className="group/app relative my-3 min-w-0 overflow-hidden"
        >
          <button
            type="button"
            aria-label="Stop app"
            title="Stop app"
            onClick={() => {
              dispatch('stop');
            }}
            className="pointer-events-none absolute right-2 top-2 z-10 flex h-7 items-center gap-1.5 rounded-lg border border-droid-border bg-droid-bg/90 px-2 text-[10.5px] font-medium text-droid-text-secondary opacity-0 shadow-sm backdrop-blur transition group-hover/app:pointer-events-auto group-hover/app:opacity-70 hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
          <RunningAppFrame source={source} instanceId={instanceId} />
        </motion.div>
      ) : (
        <motion.button
          key="preview"
          type="button"
          aria-label="Play app"
          onClick={() => {
            dispatch('play');
          }}
          initial={reduceMotion ? false : { opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
          transition={transition}
          className="group my-3 flex w-full items-center gap-3 rounded-xl border border-droid-border bg-droid-surface/55 p-3 text-left transition-colors hover:border-droid-border-hover hover:bg-droid-surface focus-visible:border-droid-border-hover focus-visible:outline-none"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-droid-bg text-droid-text-secondary ring-1 ring-inset ring-droid-border">
            <AppWindow className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-droid-text">Interactive App</span>
            <span className="block text-[11.5px] text-droid-text-muted">
              Runs locally in this chat
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-droid-text-secondary transition-colors group-hover:bg-droid-elevated group-hover:text-droid-text">
            <Play className="h-3 w-3 fill-current" />
            Play
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
