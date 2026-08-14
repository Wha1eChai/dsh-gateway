# ADR 0006: Make OAuth and model input security fail closed

- Status: Accepted
- Date: 2026-08-14

## Context

CLIProxyAPI supports provider OAuth flows and multimodal requests. A working
OAuth flow does not establish provider Terms compliance, and `/v1/models`
metadata does not prove that a model accepts images. CPA may also expose
callback behavior whose bind address needs release-specific verification.

## Decision

Support device flow and a loopback-only local callback as distinct Host
operations. Device flow is the default and always-supported flow; it returns
only verification instructions and a short-lived operation handle. A rc.6
Typert Remote does not prove a trusted HTTP `Origin`, so the Client's
`Origin`, `Referer`, `Host`, or page-origin value is never used for an OAuth
security decision. Local callback is disabled unless the implementation proves
a trusted public origin derived by the server, an exact provider/redirect
binding, one-use random state, expiry, loopback-only CPA listener, and one-time
completion. If the server-derived origin or `7.2.131` loopback binding cannot
be proven, local callback stays disabled and device flow remains available;
remote callback OAuth is out of scope. DSH does not own token refresh or OAuth
auth files; CPA does.

Models are text-only unless explicit profile metadata opts a model into image
input. Image capability is never inferred from names, `/v1/models`, or a CPA
response. OAuth is opt-in and subject to provider-specific policy review; the
project makes no pooling, resale, subscription, or redistribution claim.

## Consequences

The Browser receives user-facing device/callback instructions but never a
management key, authorization code, access token, refresh token, auth-file
path, or raw callback response. A provider or release that cannot satisfy the
server-derived-origin, loopback, and state checks remains unavailable for local
callback while device flow remains the supported path. Image requests fail
before attachment when the model is not explicitly marked capable.

## Rejected alternatives

Rejected: trusting Client HTTP Origin, remote callback OAuth, browser-owned
OAuth tokens, automatic image modality, hidden account pooling, upstream
auto-update, and upstream dynamic plugins.

## Verification gate

Tests must cover expired/replayed/wrong-state callbacks, non-loopback bind
rejection, ignored/rejected Client-origin claims, missing or mismatched
server-derived public origin, independent Host origin rejection, sanitized
default device flow that remains available, token non-disclosure, text-only
default, and explicit image opt-in. Release review must record the asset
provenance and the provider-policy decision for every enabled OAuth flow.
