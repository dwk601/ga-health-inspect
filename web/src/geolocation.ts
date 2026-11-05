export function geolocationFailureMessage(code: unknown): string {
  return code === 1 ? 'Location permission was denied. Enable location for this site in your browser settings and try again.' : code === 3 ? 'Finding your location timed out. Try again.' : 'Your location is unavailable. Check your device location settings and try again.'
}
