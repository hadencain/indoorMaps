import AppShell from "./ui/AppShell";
import ErrorBoundary from "./ui/ErrorBoundary";

export default function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
