import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { CommunityPanel } from './CommunityPanel'

const user = { id: 'visitor1', collectionId: 'users', collectionName: 'users', verified: true, role: 'user' }
const emptyPage = { page: 1, perPage: 500, totalPages: 1, totalItems: 0, items: [] }

function renderCommunity() {
  render(<CommunityPanel facilityId="facility1" mapped={false} coordinates={null} origin={null} retryMap={null} user={user} refresh={() => {}} onSignIn={() => {}} />)
}

test('a verified visitor posts a trimmed comment and the composer clears', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) => Response.json(init?.method === 'POST' ? { id: 'comment1' } : emptyPage))
  vi.stubGlobal('fetch', fetchMock)
  const visitor = userEvent.setup()
  renderCommunity()
  await screen.findByText('No comments yet.')

  const composer = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your comment' })
  await visitor.type(composer, '  A pleasant visit.  ')
  await visitor.click(screen.getByRole('button', { name: 'Post comment' }))
  await screen.findByText('Comment posted.')

  const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(posts).toHaveLength(1)
  const [url, init] = posts[0]
  expect(new URL(String(url), window.location.origin).pathname).toBe('/api/collections/comments/records')
  expect(JSON.parse(String(init?.body))).toEqual({ owner: 'visitor1', facility_id: 'facility1', body: 'A pleasant visit.' })
  await waitFor(() => expect(composer.value).toBe(''))
})
