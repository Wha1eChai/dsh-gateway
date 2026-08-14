import { clientBundle } from '../../tsdown.client.ts'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

const bundle = clientBundle(
  '@wha1echai/dsh-gateway',
  ['lib/types/index.js'],
  { splitFaces: true },
)

export default (input: Parameters<typeof bundle>[0]) => bundle(input).map((config) => {
  if (config.name !== '@wha1echai/dsh-gateway') return config
  return {
    ...config,
    plugins: [...(config.plugins ?? []), typertPlugin({ mode: 'package', faces: ['host'] })],
  }
})
