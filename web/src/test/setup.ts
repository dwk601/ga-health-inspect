import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

declare global {
  var __UI_SDK_STRICT__: boolean | undefined
}
globalThis.__UI_SDK_STRICT__ = true

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
