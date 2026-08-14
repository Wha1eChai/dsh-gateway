# dsh-gateway platform: linux x64

This private, data-only package carries the pinned CLIProxyAPI `v7.2.131`
Linux x64 executable under `vendor/cli-proxy-api`.

The package uses only the literal upstream `no-plugin` asset
`CLIProxyAPI_7.2.131_linux_amd64_no-plugin.tar.gz`. The managed configuration
fragment at `config/managed.yaml` also asserts `plugins.enabled: false`. The
upstream asset digest, target platform, executable digest, and license
attribution are recorded in `provenance/cli-proxy-api.json`.

This package has no install lifecycle script and performs no network or
runtime download. It is selected only on `linux`/`x64` hosts.
