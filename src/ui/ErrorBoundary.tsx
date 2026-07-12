import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { buildingKey } from "../persistence";
import { demoById } from "../demos";

interface Props {
  children: ReactNode;
}

interface ErrState {
  error: Error | null;
}

/** App-shell error boundary: a render crash anywhere below lands here instead
 *  of white-screening the app. The escape hatch is per-property — "Reset this
 *  property" clears ONLY the active property's persisted building and restores
 *  its pristine demo; every other property's save, the layer prefs, and the
 *  display prefs survive untouched.
 *
 *  Deliberately a class component with NO store subscription: if store-derived
 *  render state is what crashed, the fallback must not re-enter it. All store
 *  access is imperative (getState) at render/click time. */
export default class ErrorBoundary extends Component<Props, ErrState> {
  state: ErrState = { error: null };

  static getDerivedStateFromError(error: Error): ErrState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[indoorMaps] render crash:", error, info.componentStack);
  }

  private tryAgain = () => this.setState({ error: null });

  private resetProperty = () => {
    const s = useStore.getState();
    // Drop the persisted blob first so a reload also comes up clean even if
    // the re-render below crashes again.
    try {
      localStorage.removeItem(buildingKey(s.propertyId));
    } catch {
      /* storage unavailable — the in-memory reset below still applies */
    }
    // Restore the pristine demo via the store's own reset (re-derives route
    // endpoints, clears selections), then clear crash-prone session state the
    // reset doesn't touch and re-mount the tree.
    s.resetBuilding();
    useStore.setState({
      ordinal: 0,
      probe: null,
      past: [],
      future: [],
      highlightedPatrolId: null,
    });
    this.setState({ error: null });
  };

  private reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    const propertyName = demoById(useStore.getState().propertyId).name;
    return (
      <div className="crash-overlay">
        <div className="crash-card">
          <div className="crash-head">
            <AlertTriangle size={18} />
            <span>Something broke while rendering</span>
          </div>
          <p className="crash-sub">
            The app hit an unexpected error. Your other properties and settings
            are untouched. You can try again, or reset{" "}
            <strong>{propertyName}</strong> to its original demo data if the
            crash keeps happening.
          </p>
          <pre className="crash-msg">{this.state.error.message}</pre>
          <div className="crash-actions">
            <button className="crash-btn" onClick={this.tryAgain}>
              <RefreshCw size={13} /> Try again
            </button>
            <button className="crash-btn danger" onClick={this.resetProperty}>
              <RotateCcw size={13} /> Reset {propertyName}
            </button>
            <button className="crash-btn" onClick={this.reload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
