import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library unmounts after each test on its own only when Vitest's
// globals are on; they are not, so it is done here.
afterEach(() => {
  cleanup()
})
