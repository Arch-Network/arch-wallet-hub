/**
 * Catches an error thrown while rendering, which would otherwise leave
 * the popup or side panel blank, and shows it with the same copy and
 * send actions as any other error.
 */
import { Component, type ReactNode } from "react";

import { log } from "../utils/log";
import ErrorBanner from "./ErrorBanner";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(thrown: unknown): State {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }

  componentDidCatch(thrown: unknown): void {
    log.error("Render crash", thrown);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash-screen">
        <h1 className="page-title">Something went wrong</h1>
        <p className="page-subtitle">The wallet could not show this screen.</p>
        <ErrorBanner message={error.message || error.name} />
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
