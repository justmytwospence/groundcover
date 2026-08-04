import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { ThemeToggle } from './panels/ThemeToggle.js';
import { applyTheme } from './lib/theme.js';
import { useStore } from './state/store.js';
import './theme.css';

// Before first paint, so nobody sees a dark flash on the way to a light page.
applyTheme(useStore.getState().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeToggle />
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
