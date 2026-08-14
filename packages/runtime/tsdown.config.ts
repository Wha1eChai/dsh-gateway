import { clientBundle } from '../../tsdown.client.ts'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const bundle = clientBundle(
  '@wha1echai/dsh-gateway-runtime',
  ['lib/types/index.js'],
  { client: false },
)

export default (input: Parameters<typeof bundle>[0]) => bundle(input).map((config) => ({
  ...config,
  plugins: [...(config.plugins ?? []), typertPlugin({ mode: 'package', faces: ['host'] })],
}))
