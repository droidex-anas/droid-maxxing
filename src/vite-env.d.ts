/// <reference types="vite/client" />

interface Window {
  __droidexPerf?: {
    getSnapshot: () => import('./lib/rendererPerf').RendererPerfSnapshot;
  };
}
