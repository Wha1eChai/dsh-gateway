import path from 'node:path'

export const version = '0.1.0'
export const releaseTag = `v${version}`
export const releaseBaseUrl = `https://github.com/Wha1eChai/dsh-gateway/releases/download/${releaseTag}`

export const webpage = Object.freeze({
  name: '@dshapps/webpage',
  version: '0.2.0',
  filename: 'dshapps-webpage-0.2.0.tgz',
  url: 'https://github.com/Wha1eChai/dsh-webpage/releases/download/v0.2.0/dshapps-webpage-0.2.0.tgz',
  sha256: '7567c0c984dccaa334de0a06d87ee2fa4fb5adde96eb5b0c578dc7bf2c1e4433',
})

export const packageSpecs = Object.freeze([
  { key: 'gateway', directory: 'packages/gateway', name: '@dshapps/dsh-gateway' },
  { key: 'runtime', directory: 'packages/runtime', name: '@dshapps/dsh-gateway-runtime' },
  { key: 'analytics', directory: 'packages/analytics', name: '@dshapps/dsh-gateway-analytics' },
  { key: 'pack', directory: 'packages/pack', name: '@dshapps/dsh-gateway-pack' },
  { key: 'platform-win32-x64', directory: 'packages/platform/win32-x64', name: '@dshapps/dsh-gateway-platform-win32-x64' },
  { key: 'platform-win32-arm64', directory: 'packages/platform/win32-arm64', name: '@dshapps/dsh-gateway-platform-win32-arm64' },
  { key: 'platform-darwin-x64', directory: 'packages/platform/darwin-x64', name: '@dshapps/dsh-gateway-platform-darwin-x64' },
  { key: 'platform-darwin-arm64', directory: 'packages/platform/darwin-arm64', name: '@dshapps/dsh-gateway-platform-darwin-arm64' },
  { key: 'platform-linux-x64', directory: 'packages/platform/linux-x64', name: '@dshapps/dsh-gateway-platform-linux-x64' },
  { key: 'platform-linux-arm64', directory: 'packages/platform/linux-arm64', name: '@dshapps/dsh-gateway-platform-linux-arm64' },
])

export function packageFilename(name) {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}

export function packageUrl(name) {
  return `${releaseBaseUrl}/${packageFilename(name)}`
}

export function portableFileSpecifier(filePath) {
  return `file:${path.resolve(filePath).replaceAll('\\', '/')}`
}
