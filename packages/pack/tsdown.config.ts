import { clientBundle } from '../../tsdown.client.ts'

export default clientBundle(
  '@dshapps/dsh-gateway-pack',
  ['lib/types/index.js'],
  { client: false },
)

