import { clientBundle } from '../../tsdown.client.ts'

export default clientBundle(
  '@wha1echai/dsh-gateway-analytics',
  ['lib/types/index.js'],
  { client: false },
)

