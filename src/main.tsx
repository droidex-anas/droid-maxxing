import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initialState, StoreProvider } from './hooks/useStore';
import { initializeRendererDiagnostics } from './lib/rendererDiagnostics';
import { applyTheme } from './lib/theme';
import App from './App';
import './index.css';

if (window.droidControl) void initializeRendererDiagnostics();

// Apply the persisted theme BEFORE the first React paint. App also applies it
// in an effect, but that runs after the first commit — with the hardcoded dark
// CSS fallbacks in index.css that paints one dark frame before the real theme
// lands (a flash for light/custom themes). Applying synchronously here means
// the first painted frame already carries the persisted colors.
applyTheme(initialState.theme);

const root = document.getElementById('root');
if (!root) throw new Error('DROIDEX root element is missing.');

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
