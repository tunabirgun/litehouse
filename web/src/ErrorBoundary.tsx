import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// A last-resort boundary so an uncaught render/effect error shows a calm, recoverable
// message instead of blanking the whole GitHub Pages app.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Litehouse encountered an unrecoverable error.", error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="lh-error-boundary">
          <div>
            <h1>Litehouse hit an unexpected error</h1>
            <p>
              Your locally stored reports and notes are unaffected. Reload to continue; if this keeps
              happening, your browser may be blocking local storage for this site.
            </p>
            <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
              Reload Litehouse
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
