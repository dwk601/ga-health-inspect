import { useRef } from 'react'
import { AlertDialog, AlertDialogBackdrop, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '@ui-sdk/react/alert-dialog'

export default function RemovalConfirmation({ kind, launcher, onRemove, onClose }: { kind: 'ratings' | 'comments'; launcher: HTMLButtonElement; onRemove: () => Promise<boolean>; onClose: () => void }) {
  const removed = useRef(false)
  const contribution = kind === 'ratings' ? 'rating' : 'comment'

  return <AlertDialog defaultOpen onOpenChangeComplete={next => { if (!next) onClose() }}>
    <AlertDialogBackdrop className="removal-confirmation" />
    <AlertDialogContent className="removal-confirmation" finalFocus={() => removed.current || !launcher.isConnected ? document.getElementById('community-title') : launcher}>
      <AlertDialogTitle>Remove this {contribution}?</AlertDialogTitle>
      <AlertDialogDescription>This {contribution} will be removed.</AlertDialogDescription>
      <div data-slot="removal-actions">
        <AlertDialogClose>Cancel</AlertDialogClose>
        <AlertDialogClose value="confirm" data-variant="confirm" data-agent-confirm={`Removes this ${contribution}`} action={async () => { removed.current = await onRemove() }}>Remove</AlertDialogClose>
      </div>
    </AlertDialogContent>
  </AlertDialog>
}
