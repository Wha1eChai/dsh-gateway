import { clientBundle } from '../../tsdown.client.ts'

export default clientBundle(
  '@wha1echai/dsh-gateway-pack',
  ['lib/types/index.js'],
  { client: false },
)

