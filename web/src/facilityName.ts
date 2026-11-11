import type { Facility } from './types'

export function facilityTitle(facility: Facility) {
  return facility.placeName || facility.name || 'Unnamed facility'
}

export function facilityLabel(facility: Facility) {
  return `${facilityTitle(facility)} · ${facility.address?.trim() || `Address unavailable (${facility.id})`}`
}

export function officialName(facility: Facility) {
  return facility.placeName && facility.name && facility.placeName.toLowerCase() !== facility.name.toLowerCase() ? facility.name : null
}
