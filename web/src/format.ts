const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

export function formatDate(value: string | null) {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  return dateFormat.format(new Date(Date.UTC(year, month - 1, day)))
}
