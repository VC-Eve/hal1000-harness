import { Component, type ErrorInfo, type ReactNode } from "react";

// A render throw takes down everything above it, and React's default for an
// uncaught one is to unmount the whole tree — a black page with no message.
//
// That failure mode is worst exactly where it is most likely to matter: the
// settings panel is where a user goes to fix whatever is wrong, so a settings
// crash that also blanks the app leaves no way in. It has happened here once
// already, when a server predating a wire-contract change served a client
// expecting the new shape and `settings.backends` was undefined.
//
// Deliberately not persona-styled and deliberately dependent on nothing. This
// renders *because* something upstream failed, so reading app state, settings,
// or persona copy to describe the failure risks throwing inside the handler for
// a throw. Plain text that always renders beats characterful text that might
// not.

interface Props {
  // What failed, in words the reader can act on: "settings", "the chat pane".
  // Shown verbatim, so name the surface rather than the component.
  label: string;
  children: ReactNode;
  // Offered when recovery is plausible without a reload — closing a modal, say.
  onDismiss?: () => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged as well as shown. The message on screen is for the user; the stack
    // is for whoever debugs it, and swallowing it would trade one silent
    // failure for another.
    console.error(`render error in ${this.props.label}:`, error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="render-error" role="alert" data-testid="render-error">
        <strong>{this.props.label} could not be displayed.</strong>
        {/* The message, not a generic apology. A user who can see
            "Cannot read properties of undefined (reading 'shared')" can tell
            this is a version skew and restart; one who sees "an error
            occurred" cannot tell anything. */}
        <code>{error.message}</code>
        <p>
          This is a fault in HAL, not in anything you did. Restarting the server picks up a rebuilt
          interface; the rest of the app is still running.
        </p>
        <div className="render-error-actions">
          <button className="ghost" onClick={() => this.setState({ error: null })}>
            try again
          </button>
          {this.props.onDismiss ? (
            <button className="ghost" onClick={this.props.onDismiss}>
              close
            </button>
          ) : null}
          <button className="ghost" onClick={() => window.location.reload()}>
            reload
          </button>
        </div>
      </div>
    );
  }
}
