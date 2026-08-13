import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
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

export function RunningAppFrame({
  source,
  instanceId,
  onMeasured,
}: {
  source: string;
  instanceId: string;
  onMeasured?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [{ height, measurement }, setFrameSize] = useState({
    height: DEFAULT_APP_HEIGHT,
    measurement: 0,
  });
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
        setFrameSize((current) => ({ height: nextHeight, measurement: current.measurement + 1 }));
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

  useLayoutEffect(() => {
    if (measurement > 0) onMeasured?.();
  }, [measurement, onMeasured]);

  return (
    <iframe
      ref={iframeRef}
      title="Interactive App block"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={document}
      className="block min-w-0 w-full border-0 bg-transparent transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{ height }}
    />
  );
}

export function revealAppBlock(element: HTMLElement | null, reduceMotion: boolean): void {
  element?.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start',
    inline: 'nearest',
  });
}

export function AppBlock({
  source,
  autoPlay = false,
  isBuilding = false,
}: {
  source: string;
  autoPlay?: boolean;
  isBuilding?: boolean;
}) {
  const [state, dispatch] = useReducer(appBlockReducer, autoPlay ? 'running' : 'idle');
  const blockRef = useRef<HTMLDivElement>(null);
  const manualRevealPending = useRef(false);
  const instanceId = useId();
  const previousAutoPlay = useRef(autoPlay);
  const isRunning = !isBuilding && (state === 'running' || (autoPlay && !previousAutoPlay.current));
  const reduceMotion = useReducedMotion();
  const transition: Transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: [0.16, 1, 0.3, 1] };

  useEffect(() => {
    if (!isBuilding && autoPlay && !previousAutoPlay.current) dispatch('play');
    previousAutoPlay.current = autoPlay;
  }, [autoPlay, isBuilding]);

  const revealAfterMeasurement = useCallback(() => {
    if (!manualRevealPending.current) return;
    manualRevealPending.current = false;
    revealAppBlock(blockRef.current, reduceMotion === true);
  }, [reduceMotion]);

  return (
    <div ref={blockRef} className="scroll-mt-16">
      <AnimatePresence initial={false} mode="wait">
        {isBuilding ? (
          <motion.div
            key="building"
            role="status"
            aria-live="polite"
            aria-label="Building interactive app"
            initial={reduceMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
            transition={transition}
            className="my-3 flex w-full items-center gap-3 overflow-hidden rounded-xl border border-droid-border bg-droid-surface/55 p-3"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-droid-bg text-droid-text-muted ring-1 ring-inset ring-droid-border">
              <AppWindow className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="shimmer-text block text-[13px] font-medium">
                Building interactive app
              </span>
              <span className="block text-[11.5px] text-droid-text-muted">
                Generating the interface
              </span>
            </span>
            <span className="shimmer-text shrink-0 text-[11px] font-medium">Building</span>
          </motion.div>
        ) : isRunning ? (
          <motion.div
            key="running"
            initial={reduceMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 4 }}
            transition={transition}
            className="group/app my-3 min-w-0"
          >
            <RunningAppFrame
              source={source}
              instanceId={instanceId}
              onMeasured={revealAfterMeasurement}
            />
            <div className="flex h-7 items-end justify-end">
              <button
                type="button"
                aria-label="Stop app"
                title="Stop app"
                onClick={() => {
                  manualRevealPending.current = false;
                  dispatch('stop');
                }}
                className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[10.5px] font-medium text-droid-text-muted opacity-45 transition-[color,background-color,opacity] hover:bg-droid-surface hover:text-droid-text-secondary hover:opacity-100 focus-visible:bg-droid-surface focus-visible:text-droid-text-secondary focus-visible:opacity-100 focus-visible:outline-none"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="preview"
            type="button"
            aria-label="Play app"
            onClick={() => {
              manualRevealPending.current = true;
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
    </div>
  );
}
