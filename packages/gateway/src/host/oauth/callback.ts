const trustedHostServerOriginBrand = Symbol('trusted-host-server-origin');

export interface TrustedHostServerOrigin {
  readonly source: 'host-server';
  readonly origin: string;
  readonly [trustedHostServerOriginBrand]: true;
}

export interface LocalCallbackCapabilityInput {
  /** Only this server-owned seam can authorize the capability. */
  readonly trustedServerOrigin?: TrustedHostServerOrigin;
  /** Accepted as data only; it can never authorize local callback. */
  readonly browserOrigin?: string;
}

/**
 * Creates the opaque seam value that a Host may pass after deriving its own
 * public server origin. This does not inspect or trust a browser Origin.
 */
export function createTrustedHostServerOrigin(origin: string): TrustedHostServerOrigin | undefined {
  if (!isLoopbackOrigin(origin)) return undefined;
  return {
    source: 'host-server',
    origin,
    [trustedHostServerOriginBrand]: true,
  };
}

export function hasTrustedLocalCallbackCapability(input: LocalCallbackCapabilityInput): boolean {
  const trusted = input?.trustedServerOrigin;
  return trusted !== undefined
    && trusted.source === 'host-server'
    && trusted[trustedHostServerOriginBrand] === true
    && isLoopbackOrigin(trusted.origin);
}

export const isLocalCallbackCapabilityEnabled = hasTrustedLocalCallbackCapability;

function isLoopbackOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 256) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (url.protocol === 'http:' || url.protocol === 'https:')
    && (hostname === 'localhost' || hostname === '127.0.0.1')
    && url.origin === origin;
}
