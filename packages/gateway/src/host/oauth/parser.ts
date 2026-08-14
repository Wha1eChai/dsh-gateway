import { CodexDeviceLoginError } from './errors.js';
import type { CodexDeviceLoginDetails } from './types.js';

const MAX_LINE_LENGTH = 8_192;
const MAX_VERIFICATION_URI_LENGTH = 512;
const MAX_USER_CODE_LENGTH = 128;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_EXPIRY_MS = 24 * 60 * 60 * 1_000;
export const CODEX_DEVICE_EXPIRY_MS = 15 * 60 * 1_000;
export const CODEX_DEVICE_POLL_INTERVAL_MS = 5 * 1_000;
const SAFE_CODE = /^[A-Z0-9]{4,32}(?:-[A-Z0-9]{2,32})+$/;
const SAFE_URL_LINE = /^https:\/\/[^\s]+$/;

export interface CodexDeviceLoginParserOptions {
  readonly now?: () => number;
  readonly maxOutputBytes?: number;
}

export type CodexDeviceLoginTerminalState = 'success' | 'failed' | 'denied' | 'expired' | 'cancelled';

export type CodexDeviceLoginParserEvent =
  | { readonly kind: 'ready'; readonly details: CodexDeviceLoginDetails }
  | { readonly kind: 'state'; readonly state: CodexDeviceLoginTerminalState };

/**
 * Incremental parser for the small, human-readable device-login contract.
 * Unknown lines are ignored; candidate fields are accepted only in exact,
 * bounded forms and conflicting fields fail closed.
 */
export class CodexDeviceLoginParser {
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private lineBuffer = '';
  private outputBytes = 0;
  private verificationUri: string | undefined;
  private userCode: string | undefined;
  private expiresAtMs: number | undefined;
  private pollIntervalMs: number | undefined;
  private emittedReady = false;
  private terminalState: CodexDeviceLoginTerminalState | undefined;

  constructor(options: CodexDeviceLoginParserOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = boundedInteger(options.maxOutputBytes ?? 64 * 1024, 1_024, 256 * 1_024);
  }

  feed(chunk: string | Uint8Array): CodexDeviceLoginParserEvent[] {
    const text = typeof chunk === 'string' ? chunk : this.decodeChunk(chunk);
    this.outputBytes += new TextEncoder().encode(text).byteLength;
    if (this.outputBytes > this.maxOutputBytes) {
      throw parseError('output_limit_exceeded');
    }

    this.lineBuffer += text;
    if (this.lineBuffer.length > MAX_LINE_LENGTH * 2) {
      throw parseError('line_limit_exceeded');
    }

    const events: CodexDeviceLoginParserEvent[] = [];
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      events.push(...this.parseLine(line));
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
    return events;
  }

  finish(): CodexDeviceLoginParserEvent[] {
    const decoderTail = this.decodeTail();
    if (decoderTail.length > 0) {
      this.lineBuffer += decoderTail;
      this.outputBytes += new TextEncoder().encode(decoderTail).byteLength;
      if (this.outputBytes > this.maxOutputBytes) throw parseError('output_limit_exceeded');
    }
    if (this.lineBuffer.length > 0) {
      const line = this.lineBuffer.replace(/\r$/, '');
      this.lineBuffer = '';
      if (line.length > MAX_LINE_LENGTH) throw parseError('line_limit_exceeded');
      const events = this.parseLine(line);
      const ready = this.readyEvent();
      if (ready !== undefined && !events.some((event) => event.kind === 'ready')) events.push(ready);
      return events;
    }
    if (this.emittedReady) return [];
    const ready = this.readyEvent();
    return ready === undefined ? [] : [ready];
  }

  private decodeChunk(value: Uint8Array): string {
    try {
      return this.decoder.decode(value, { stream: true });
    } catch {
      throw parseError('output_not_utf8');
    }
  }

  private decodeTail(): string {
    try {
      return this.decoder.decode();
    } catch {
      throw parseError('output_not_utf8');
    }
  }

  private parseLine(rawLine: string): CodexDeviceLoginParserEvent[] {
    if (rawLine.length > MAX_LINE_LENGTH) throw parseError('line_limit_exceeded');
    const line = rawLine.trim();
    if (line.length === 0) return [];

    const events: CodexDeviceLoginParserEvent[] = [];
    const verificationUri = parseVerificationUri(line);
    if (verificationUri !== undefined) {
      this.setField('verificationUri', verificationUri);
    }

    const userCode = parseUserCode(line);
    if (userCode !== undefined) {
      this.setField('userCode', userCode);
    }

    const expiry = parseExpiry(line, this.now());
    if (expiry !== undefined) {
      this.setField('expiresAtMs', expiry);
    }

    const interval = parsePollInterval(line);
    if (interval !== undefined) {
      this.setField('pollIntervalMs', interval);
    }

    const state = parseTerminalState(line);
    if (state !== undefined) {
      if (this.terminalState !== undefined && this.terminalState !== state) {
        throw parseError('conflicting_terminal_state');
      }
      this.terminalState = state;
      events.push({ kind: 'state', state });
    }

    const ready = this.readyEvent();
    if (ready !== undefined && !this.emittedReady) {
      this.emittedReady = true;
      events.push(ready);
    }
    return events;
  }

  private setField(field: 'verificationUri' | 'userCode' | 'expiresAtMs' | 'pollIntervalMs', value: string | number): void {
    const current = this[field];
    if (current !== undefined && current !== value) throw parseError(`conflicting_${field}`);
    this[field] = value as never;
  }

  private readyEvent(): Extract<CodexDeviceLoginParserEvent, { kind: 'ready' }> | undefined {
    if (this.verificationUri === undefined || this.userCode === undefined) return undefined;
    return {
      kind: 'ready',
      details: {
        verificationUri: this.verificationUri,
        userCode: this.userCode,
        expiresAtMs: this.expiresAtMs ?? this.now() + CODEX_DEVICE_EXPIRY_MS,
        pollIntervalMs: this.pollIntervalMs ?? CODEX_DEVICE_POLL_INTERVAL_MS,
      },
    };
  }
}

export function parseCodexDeviceLoginOutput(
  output: string,
  options: CodexDeviceLoginParserOptions = {},
): CodexDeviceLoginDetails {
  const parser = new CodexDeviceLoginParser(options);
  const events = parser.feed(output);
  events.push(...parser.finish());
  const ready = [...events].reverse().find((event) => event.kind === 'ready');
  if (ready?.kind !== 'ready') throw parseError('required_fields_missing');
  return ready.details;
}

function parseVerificationUri(line: string): string | undefined {
  const labelled = /^(?:codex device url|verification (?:url|uri)|(?:open|visit) this (?:url|link))(?: in your browser)?:\s*(https:\/\/[^\s]+)$/i.exec(line);
  const candidate = labelled?.[1] ?? (SAFE_URL_LINE.test(line) ? line : undefined);
  if (candidate === undefined || candidate.length > MAX_VERIFICATION_URI_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw parseError('verification_uri_invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) {
    throw parseError('verification_uri_invalid');
  }
  if (url.hostname !== 'auth.openai.com' || url.pathname !== '/codex/device') {
    throw parseError('verification_uri_unapproved');
  }
  return url.toString();
}

function parseUserCode(line: string): string | undefined {
  const labelled = /^(?:codex device|device|user|verification) code:\s*([A-Z0-9]{4,32}(?:-[A-Z0-9]{2,32})+)$/i.exec(line);
  const embedded = /^follow these steps to sign in with (?:device )?code\s+([A-Z0-9]{4,32}(?:-[A-Z0-9]{2,32})+)\s*$/i.exec(line);
  const candidate = labelled?.[1] ?? embedded?.[1];
  if (candidate === undefined) return undefined;
  const code = candidate.toUpperCase();
  if (!SAFE_CODE.test(code) || code.length > MAX_USER_CODE_LENGTH) throw parseError('user_code_invalid');
  return code;
}

function parseExpiry(line: string, nowMs: number): number | undefined {
  const duration = /^(?:this )?(?:device )?code expires? in\s+(\d{1,6})\s+(seconds?|minutes?|hours?)\.?$/i.exec(line)
    ?? /^\(expires in\s+(\d{1,6})\s+(seconds?|minutes?|hours?)\)$/i.exec(line);
  if (duration !== null) {
    const amount = Number(duration[1]);
    const unit = duration[2]?.toLowerCase();
    const multiplier = unit?.startsWith('hour') ? 60 * 60 * 1_000 : unit?.startsWith('minute') ? 60 * 1_000 : 1_000;
    const lifetimeMs = amount * multiplier;
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_EXPIRY_MS) {
      throw parseError('expiry_invalid');
    }
    return nowMs + lifetimeMs;
  }
  const absolute = /^(?:expires at|expiry):\s*(\d{4}-\d{2}-\d{2}T[^\s]+)$/i.exec(line);
  if (absolute !== null) {
    const expiry = Date.parse(absolute[1] ?? '');
    if (!Number.isSafeInteger(expiry) || expiry <= nowMs || expiry - nowMs > MAX_EXPIRY_MS) {
      throw parseError('expiry_invalid');
    }
    return expiry;
  }
  return undefined;
}

function parsePollInterval(line: string): number | undefined {
  const match = /^(?:poll(?:ing)?(?: interval)?|interval|check)\s*(?:is|every|:)\s*(\d{1,6})\s+(seconds?|minutes?)\.?$/i.exec(line);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const intervalMs = amount * (unit?.startsWith('minute') ? 60 * 1_000 : 1_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw parseError('poll_interval_invalid');
  }
  return intervalMs;
}

function parseTerminalState(line: string): CodexDeviceLoginTerminalState | undefined {
  if (line === 'Codex authentication successful'
    || line === 'Codex device authentication successful!'
    || /^(?:login|device login|authorization) (?:successful|succeeded|complete|completed|authorized)\.?$/i.test(line)) return 'success';
  if (line.startsWith('Codex device authentication failed:')) return 'failed';
  if (/^(?:authorization|login) denied\.?$/i.test(line)) return 'denied';
  if (/^(?:device code|authorization) expired\.?$/i.test(line)) return 'expired';
  if (/^(?:login|device login|authorization) (?:cancelled|canceled)\.?$/i.test(line)) return 'cancelled';
  return undefined;
}

function parseError(code: string): CodexDeviceLoginError {
  return new CodexDeviceLoginError({ category: 'parse', code });
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw parseError('parser_limit_invalid');
  return value;
}
