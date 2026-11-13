import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { CommunityPanel } from './CommunityPanel'

const user = { id: 'visitor1', collectionId: 'users', collectionName: 'users', verified: true, role: 'user' }
const emptyPage = { page: 1, perPage: 500, totalPages: 1, totalItems: 0, items: [] }

function renderCommunity() {
  render(<CommunityPanel facilityId="facility1" mapped={false} coordinates={null} origin={null} retryMap={null} user={user} refresh={() => {}} onSignIn={() => {}} />)
}

test('removal only deletes the selected comment after confirmation', async () => {
  const comment = { id: 'comment1', owner: 'visitor1', facility_id: 'facility1', body: 'A pleasant visit.', authorName: 'Visitor', created: '2026-01-01 12:00:00.000Z' }
  let commentLoads = 0
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (new URL(String(input), window.location.origin).pathname === '/api/collections/comments/records' && commentLoads++ === 0) {
      return Response.json({ ...emptyPage, totalItems: 1, items: [comment] })
    }
    return Response.json(emptyPage)
  })
  vi.stubGlobal('fetch', fetchMock)
  const visitor = userEvent.setup()
  renderCommunity()

  const launcher = await screen.findByRole('button', { name: 'Remove comment' })
  await visitor.click(launcher)
  let dialog = await screen.findByRole('alertdialog', { name: 'Remove this comment?' })
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  await visitor.click(cancel)
  await waitFor(() => expect(document.activeElement).toBe(launcher))
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
  expect(screen.getByText('A pleasant visit.')).toBeTruthy()

  fireEvent.click(launcher)
  expect(screen.queryByText('Loading removal confirmation…')).toBeNull()
  await screen.findByRole('alertdialog', { name: 'Remove this comment?' })
  await visitor.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement).toBe(launcher))
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)

  await visitor.click(launcher)
  dialog = await screen.findByRole('alertdialog', { name: 'Remove this comment?' })
  await visitor.click(within(dialog).getByRole('button', { name: 'Remove' }))
  await screen.findByText('No comments yet.')
  const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
  expect(deletes).toHaveLength(1)
  expect(new URL(String(deletes[0][0]), window.location.origin).pathname).toBe('/api/collections/comments/records/comment1')
  expect(screen.queryByText('A pleasant visit.')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Visitor experience · 1–5' })))
})
