import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/main";
import "./styles.css";

type BoundaryState = {
  hasError: boolean;
  message: string;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unknown UI error.",
    };
  }

  override componentDidCatch(error: unknown): void {
    console.error("Uncaught app error:", error);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="auth-gate">
          <div className="auth-card">
            <h1>Application Error</h1>
            <p className="error">{this.state.message}</p>
            <p className="muted">Open browser console for stack trace and reload the page.</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
