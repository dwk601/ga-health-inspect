export type LocationFix = { coordinates: [number, number]; accuracy: number; timestamp: number }

export function distanceMiles(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const lat = (b[1] - a[1]) * radians
  const lon = (b[0] - a[0]) * radians
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(lon / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

export async function getPreciseLocation(): Promise<LocationFix> {
  if (!window.isSecureContext) throw new Error('Location requires a secure connection. Open this site over HTTPS and try again.')
  if (!navigator.geolocation) throw new Error('This browser does not support location.')
  const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }))
  return { coordinates: [position.coords.longitude, position.coords.latitude], accuracy: position.coords.accuracy, timestamp: Date.now() }
}

export function geolocationFailureMessage(code: unknown): string {
  return code === 1 ? 'Location permission was denied. Enable location for this site in your browser settings and try again.' : code === 3 ? 'Finding your location timed out. Try again.' : 'Your location is unavailable. Check your device location settings and try again.'
}
