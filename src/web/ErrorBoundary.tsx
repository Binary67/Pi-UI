import { Component, type ReactNode } from "react";
import { Banner } from "./Message.tsx";

/** Shows the error text and a reload button, so a throw during render does not blank the page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="settings">
        <div className="settings-inner">
          <Banner>Something went wrong: {this.state.error.message}</Banner>
          <button className="link" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </main>
    );
  }
}
