export function MapFailure({ onRetry }: { onRetry: () => void }) {
  return <div className="map-failure"><p role="status">The map could not be loaded. You can still search and view facility details.</p><button onClick={onRetry}>Retry</button></div>
}
