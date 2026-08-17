import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';
import { AppWindow, Play, Square } from 'lucide-react';
import { AppBlockErrorFallback } from './AppBlockErrorFallback';
import {
  APP_BUILD_TIMEOUT_MS,
  DEFAULT_APP_HEIGHT,
  MIN_APP_BUILD_MS,
  appBlockStartupTransition,
  appBlockReadyFromMessage,
  appBlockHeightFromMessage,
  appBlockMathRequestFromMessage,
  appBlockReducer,
  createAppBridgeSession,
  currentAppBlockTheme,
  isAppFrameVisible,
  renderAppBlockMath,
  type AppBlockStartupState,
} from './appBlockRuntime';
import { createAppDocument } from './appBlockDocument';

// Shared chrome for the App's pre-run states, matching the Play card's shape so
// each swap changes wording rather than layout.
function AppLoadingSurface({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={title}
      className="flex w-full items-center gap-3 rounded-xl border border-droid-border bg-droid-surface/55 p-3"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-droid-bg text-droid-text-muted ring-1 ring-inset ring-droid-border">
        <AppWindow className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="shimmer-text block text-[13px] font-medium">{title}</span>
        <span className="block text-[11.5px] text-droid-text-muted">{subtitle}</span>
      </span>
      {trailing}
    </div>
  );
}

export function RunningAppFrame({
  source,
  instanceId,
  buildFloorMs = MIN_APP_BUILD_MS,
  onVisible,
}: {
  source: string;
  instanceId: string;
  // How long the build surface is held once shown. A frame that follows the
  // live build card passes 0: the wait was already visible, so a second status
  // surface would only blink.
  buildFloorMs?: number;
  onVisible?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [{ height, measurement }, setFrameSize] = useState({
    height: DEFAULT_APP_HEIGHT,
    measurement: 0,
  });
  const [runtimeError, setRuntimeError] = useState<{ token: string; message: string } | null>(null);
  const theme = useMemo(currentAppBlockTheme, []);
  const bridge = useMemo(createAppBridgeSession, [instanceId, source, theme]);
  const document = useMemo(
    () => createAppDocument(source, instanceId, theme, bridge.token),
    [bridge.token, instanceId, source, theme],
  );
  // The frame stays hidden while the App boots so the reveal lands at its real
  // measured height instead of jumping from the default one.
  const [build, setBuild] = useState({ floorElapsed: false, expired: false });
  const isVisible = isAppFrameVisible({ ...build, measured: measurement > 0 });

  useEffect(() => {
    setBuild({ floorElapsed: false, expired: false });
    const floor = setTimeout(() => {
      setBuild((current) => ({ ...current, floorElapsed: true }));
    }, buildFloorMs);
    const ceiling = setTimeout(() => {
      setBuild((current) => ({ ...current, expired: true }));
    }, APP_BUILD_TIMEOUT_MS);
    return () => {
      clearTimeout(floor);
      clearTimeout(ceiling);
    };
  }, [buildFloorMs, document]);

  useLayoutEffect(() => {
    let startupState: AppBlockStartupState = 'waiting';
    let heightFrame = 0;
    let pendingHeight: number | undefined;
    const scheduleHeight = (nextHeight: number) => {
      pendingHeight = nextHeight;
      if (heightFrame) return;
      heightFrame = requestAnimationFrame(() => {
        heightFrame = 0;
        if (pendingHeight === undefined) return;
        const measuredHeight = pendingHeight;
        pendingHeight = undefined;
        setFrameSize((current) => ({
          height: measuredHeight,
          measurement: current.measurement + 1,
        }));
      });
    };
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const startup = appBlockStartupTransition(startupState, event.data, instanceId, bridge.token);
      startupState = startup.state;
      if (startup.error) {
        bridge.guard.fail();
        setRuntimeError({ token: bridge.token, message: startup.error });
        return;
      }
      if (appBlockReadyFromMessage(event.data, instanceId, bridge.token)) {
        return;
      }
      if (startupState !== 'ready') return;
      const nextHeight = appBlockHeightFromMessage(event.data, instanceId, bridge.token);
      if (nextHeight !== undefined) {
        if (!bridge.guard.acceptHeight(nextHeight)) return;
        scheduleHeight(nextHeight);
        return;
      }
      const mathRequest = appBlockMathRequestFromMessage(event.data, instanceId, bridge.token);
      if (!mathRequest) return;
      if (!bridge.guard.startMath()) {
        frameWindow.postMessage(
          {
            type: 'droidex:math-rendered',
            instanceId,
            bridgeToken: bridge.token,
            requestId: mathRequest.requestId,
          },
          '*',
        );
        return;
      }
      void renderAppBlockMath(mathRequest)
        .then((html) => {
          if (iframeRef.current?.contentWindow !== frameWindow) return;
          frameWindow.postMessage(
            {
              type: 'droidex:math-rendered',
              instanceId,
              bridgeToken: bridge.token,
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
              bridgeToken: bridge.token,
              requestId: mathRequest.requestId,
            },
            '*',
          );
        })
        .finally(() => {
          bridge.guard.finishMath();
        });
    };
    window.addEventListener('message', onMessage);
    return () => {
      if (heightFrame) cancelAnimationFrame(heightFrame);
      window.removeEventListener('message', onMessage);
    };
  }, [bridge, instanceId]);

  useLayoutEffect(() => {
    if (isVisible) onVisible?.();
  }, [isVisible, onVisible]);

  if (runtimeError?.token === bridge.token) {
    return <AppBlockErrorFallback message={runtimeError.message} />;
  }

  return (
    <div className="relative min-w-0">
      {!isVisible && (
        <AppLoadingSurface title="Starting interactive app" subtitle="Preparing the interface" />
      )}
      <iframe
        ref={iframeRef}
        onLoad={() => {
          iframeRef.current?.contentWindow?.postMessage(
            {
              type: 'droidex:host-ready',
              instanceId,
              bridgeToken: bridge.token,
            },
            '*',
          );
        }}
        title="Interactive App block"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        // The hidden frame must still load: a lazy one below the fold would
        // never boot, and the build surface would never end.
        loading="eager"
        srcDoc={document}
        aria-hidden={!isVisible}
        tabIndex={isVisible ? undefined : -1}
        className={`min-w-0 w-full border-0 bg-transparent ${
          isVisible ? 'block' : 'invisible pointer-events-none absolute inset-x-0 top-0'
        }`}
        style={{ height }}
      />
    </div>
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
  isCutOff = false,
}: {
  source: string;
  autoPlay?: boolean;
  isBuilding?: boolean;
  // The stored source lost its closing fence, so this App can never run. It
  // outranks every other state: there is nothing to build and nothing to play.
  isCutOff?: boolean;
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

  const revealAfterStart = useCallback(() => {
    if (!manualRevealPending.current) return;
    manualRevealPending.current = false;
    revealAppBlock(blockRef.current, reduceMotion === true);
  }, [reduceMotion]);

  if (isCutOff) {
    return <AppBlockErrorFallback message="Saved history kept only part of this App's source." />;
  }

  return (
    <div ref={blockRef} className="scroll-mt-16">
      <AnimatePresence initial={false} mode="wait">
        {isBuilding ? (
          <motion.div
            key="building"
            initial={reduceMotion ? false : { opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -3 }}
            transition={transition}
            className="my-3"
          >
            <AppLoadingSurface
              title="Building interactive app"
              subtitle="Generating the interface"
              trailing={
                <span className="shimmer-text shrink-0 text-[11px] font-medium">Building</span>
              }
            />
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
              // A new source is a different App: remount so its build state
              // starts over instead of revealing at the old measurement.
              key={`${instanceId}:${source}`}
              source={source}
              instanceId={instanceId}
              buildFloorMs={autoPlay ? 0 : MIN_APP_BUILD_MS}
              onVisible={revealAfterStart}
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
