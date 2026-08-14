# ADR 0001: Deliver the gateway as an ordinary DSH Bundle

- Status: Accepted
- Date: 2026-08-14

## Context

The gateway needs a Host integration, an optional process runtime, an
operations App, and a convenient installation unit. DSH already defines
Plugins as the install, trust, dependency, and lifecycle unit; dsh-webpage
defines Apps as contributions and Packs as composition. Introducing a gateway
super-plugin or changing dsh-webpage would create a second lifecycle model.

## Decision

Ship `dsh-gateway` as an out-of-tree Bundle for DSH `0.1.0-rc.6`. Compose the
Host Plugin, optional managed-runtime and analytics companions, the App
contribution, and compatible Webpage dependencies in one ordinary Pack. Keep
all gateway product code and state outside dsh-webpage. The App is not
independently installable, and the Pack contains composition metadata rather
than a new runtime.

## Consequences

DSH owns load order, dependency resolution, trust, activation, and disposal.
Gateway roles can be installed together or omitted by mode. The Pack must not
silently enable OAuth, remote management, dynamic upstream plugins, or binary
updates. A future reusable Webpage capability requires an independent App
consumer before it moves upstream. External mode remains usable when the
managed-runtime and analytics companions are both absent; their Remote methods
report typed unavailability instead of preventing the core Host/App path from
loading.

## Rejected alternatives

Rejected: modifying dsh-webpage, embedding gateway behavior in the Webpage
core, adding a second package manager, and making the App the provider.

## Verification gate

The packed profile must load the ordinary bundle through public DSH bundle
metadata and must dispose every gateway contribution without modifying DSH or
dsh-webpage files. A packed external-only profile must run setup, model
discovery/apply, and a Playground probe without runtime or analytics packages.
