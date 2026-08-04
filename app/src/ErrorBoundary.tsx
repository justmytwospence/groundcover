/**
 * Without this, any throw anywhere in the tree unmounts everything and leaves a white page,
 * which is indistinguishable from the site being broken -- and worse, it looks like the user's
 * data is gone when it is sitting safely in IndexedDB the whole time. Saying so is most of the
 * value here.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Stays in this browser: there is no error reporting service, which is the same promise the
    // landing page makes about activity data.
    console.error('traversed crashed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="connect-scroll">
        <div className="connect-card" style={{ margin: 'auto' }}>
          <h1 className="connect-title" style={{ fontSize: 24 }}>
            Something broke
          </h1>
          <p className="connect-lede">
            Your downloaded activities are still safe in this browser &mdash; nothing here deletes
            them. Reloading is usually enough.
          </p>
          <pre
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--text-muted)',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid var(--panel-border)',
              borderRadius: 6,
              padding: '10px 12px',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message}
          </pre>
          <button className="ghost" onClick={() => window.location.reload()} style={{ marginTop: 14 }}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
