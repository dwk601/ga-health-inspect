const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

export function formatDate(value: string | null) {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  return dateFormat.format(new Date(Date.UTC(year, month - 1, day)))
}

const timeFormat = new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' })

export function formatTime(value: string | null) {
  const match = value?.match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return timeFormat.format(new Date(Date.UTC(1970, 0, 1, Number(match[1]), Number(match[2]))))
}
