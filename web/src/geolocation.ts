export type LocationFix = { coordinates: [number, number]; accuracy: number; timestamp: number }

export function distanceMiles(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const lat = (b[1] - a[1]) * radians
  const lon = (b[0] - a[0]) * radians
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(lon / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export function geolocationFailureMessage(code: unknown): string {
  return code === 1 ? 'Location permission was denied. Enable location for this site in your browser settings and try again.' : code === 3 ? 'Finding your location timed out. Try again.' : 'Your location is unavailable. Check your device location settings and try again.'
}
