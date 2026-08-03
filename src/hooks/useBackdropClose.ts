import { useRef } from 'react'

// Spread onto a modal's backdrop div to close it on an actual click on the
// backdrop itself — WITHOUT the classic bug where selecting text inside the
// modal and releasing the mouse past its edge (over the backdrop) also
// closes it. A plain onClick={onClose} on the backdrop fires whenever the
// resulting click event's target is the backdrop, which includes that
// drag-out-while-selecting case (mouseup lands on the backdrop even though
// the selection started inside the card) — confirmed live as a real report.
// Only closes when BOTH the mousedown that started the interaction AND the
// resulting click landed directly on the backdrop, not a descendant.
export function useBackdropClose(onClose: () => void) {
  const mouseDownOnBackdrop = useRef(false)

  return {
    onMouseDown: (e: React.MouseEvent) => {
      mouseDownOnBackdrop.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent) => {
      if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose()
    },
  }
}
