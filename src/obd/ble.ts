/**
 * The Web Bluetooth transport: how a web page talks to a BLE ELM327 adapter.
 *
 * IMPORTANT: none of the service UUIDs below has been verified against a real adapter in this
 * build. There was no Bluetooth hardware where this was written. BLE ELM327 clones expose a
 * serial-style service that is NOT standardised; the list is the set of UUIDs commonly used by
 * BLE serial bridges. An adapter that uses another one needs it added to CANDIDATE_SERVICES.
 *
 * How it works: ask the browser for a device (the user picks it from the browser's own list),
 * connect, look through the services we are allowed to see, pick the first one that has a
 * characteristic we can listen to (notify) and one we can write to, subscribe, and send
 * commands in 20-byte pieces (the default size a BLE write can carry).
 *
 * Everything that touches `navigator.bluetooth` is guarded, so the app runs with it absent.
 */

import { isAllowedCommand } from './elm';
import type { Transport } from './session';

/** A 16-bit UUID is written as a number, which Web Bluetooth expands to the full 128-bit form. */
type ServiceId = number | string;

/** Services tried, in order. Unverified: see the note at the top of the file. */
export const CANDIDATE_SERVICES: ServiceId[] = [
  // FFF0: documented by OBDLink for its CX adapter (custom UART service, notify on FFF1, write on FFF2):
  // https://support.obdlink.com/support/solutions/articles/43000746707-obdlink-cx-adapter-notes (fetched Oct 20, 2026).
  // That is the maker's note for one adapter, not a test of this app. The entries below are still unverified in this build.
  0xfff0,
  0xffe0, // commonly: one characteristic FFE1 for both
  0xffe5, // a variant of the FFE0 family (write FFE9, notify FFE4), seen on some serial bridges
  0xffb0, // another 0xFFxx variant used by some bridges
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART: write ...0002 (RX), notify ...0003 (TX)
  0x18f0, // used by some clones: notify 2AF0, write 2AF1
];

/** The characteristics we expect, used only to log what was found; discovery does not depend on them. */
export const KNOWN_CHARACTERISTICS: string[] = [
  'fff1',
  'fff2',
  'ffe1',
  'ffe4',
  'ffe9',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  '2af0',
  '2af1',
];

export const CHUNK_BYTES = 20;

const UUID128 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID16 = /^(0x)?[0-9a-f]{4}$/;

/**
 * Check a service UUID typed by the user. Accepts a 16-bit hex ("FFF0" or "0xFFF0") or a full
 * 128-bit UUID. Returns the form Web Bluetooth wants (a number or a lower-case string), or null.
 */
export function parseServiceUuid(text: string): ServiceId | null {
  if (typeof text !== 'string') return null;
  const t = text.trim().toLowerCase();
  if (UUID16.test(t)) return parseInt(t.replace(/^0x/, ''), 16);
  if (UUID128.test(t)) return t;
  return null;
}

/** The services to ask the browser for: the user's one first (if valid), then the built-in list. */
export function serviceList(custom?: string | null): ServiceId[] {
  const extra = custom ? parseServiceUuid(custom) : null;
  const all = extra === null ? CANDIDATE_SERVICES : [extra, ...CANDIDATE_SERVICES];
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = typeof s === 'number' ? s.toString(16).padStart(4, '0') : s;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cut text into pieces of at most 20 bytes (ASCII, so characters are bytes). */
export function chunkText(text: string, size: number = CHUNK_BYTES): string[] {
  const n = Math.max(1, Math.floor(size));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

export interface CharacteristicInfo {
  uuid: string;
  notify: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
}

export interface ServiceInfo {
  uuid: string;
  characteristics: CharacteristicInfo[];
}

export interface Endpoint {
  service: string;
  /** The characteristic to listen on. */
  notify: string;
  /** The characteristic to write to (may be the same one). */
  write: string;
}

/** Pick the first service with something to listen to and something to write to. */
export function chooseEndpoint(services: ServiceInfo[]): Endpoint | null {
  for (const s of services) {
    const listen = s.characteristics.find((c) => c.notify);
    if (!listen) continue;
    // Prefer a separate characteristic for writing; fall back to the listening one (FFE1 style).
    const canWrite = (c: CharacteristicInfo): boolean => c.write || c.writeWithoutResponse;
    const writer = s.characteristics.find((c) => c !== listen && canWrite(c)) ?? (canWrite(listen) ? listen : undefined);
    if (writer) return { service: s.uuid, notify: listen.uuid, write: writer.uuid };
  }
  return null;
}

/** True when this browser can do Web Bluetooth at all. */
export function bluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.requestDevice === 'function';
}

export class BleError extends Error {}

/**
 * Ask the user to pick an adapter, connect, and return a transport. Throws BleError with a
 * plain sentence on any failure; a user who closes the picker gets the message 'cancelled'.
 */
export async function connectBle(customService?: string | null): Promise<Transport> {
  if (!bluetoothAvailable()) throw new BleError('This browser has no Web Bluetooth.');
  const optionalServices = serviceList(customService) as BluetoothServiceUUID[];

  let device: BluetoothDevice;
  try {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') throw new BleError('cancelled');
    throw new BleError(e instanceof Error ? e.message : 'Could not open the Bluetooth picker.');
  }

  const gatt = device.gatt;
  if (!gatt) throw new BleError('That device has no Bluetooth GATT server.');
  let server: BluetoothRemoteGATTServer;
  try {
    server = await gatt.connect();
  } catch {
    throw new BleError('Could not connect to the adapter. Is it powered and in range?');
  }

  const services = await server.getPrimaryServices().catch(() => [] as BluetoothRemoteGATTService[]);
  const infos: ServiceInfo[] = [];
  const handles = new Map<string, Map<string, BluetoothRemoteGATTCharacteristic>>();
  for (const svc of services) {
    const chars = await svc.getCharacteristics().catch(() => [] as BluetoothRemoteGATTCharacteristic[]);
    const map = new Map<string, BluetoothRemoteGATTCharacteristic>();
    for (const c of chars) map.set(c.uuid, c);
    handles.set(svc.uuid, map);
    infos.push({
      uuid: svc.uuid,
      characteristics: chars.map((c) => ({
        uuid: c.uuid,
        notify: c.properties.notify || c.properties.indicate,
        write: c.properties.write,
        writeWithoutResponse: c.properties.writeWithoutResponse,
      })),
    });
  }

  const endpoint = chooseEndpoint(infos);
  const chars = endpoint ? handles.get(endpoint.service) : undefined;
  const listenChar = endpoint ? chars?.get(endpoint.notify) : undefined;
  const writeChar = endpoint ? chars?.get(endpoint.write) : undefined;
  if (!endpoint || !listenChar || !writeChar) {
    server.disconnect();
    throw new BleError(
      'Connected, but no serial-style service was found. Rev Key does not know this adapter yet: open an issue on GitHub with its name and service UUID.',
    );
  }
  return new BleTransport(device, server, listenChar, writeChar);
}

/** The part of a characteristic that writing needs (so a test can stand in for the real one). */
export interface Writable {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValue(v: Uint8Array<ArrayBuffer>): Promise<void>;
  writeValueWithoutResponse(v: Uint8Array<ArrayBuffer>): Promise<void>;
}

/**
 * Write one piece and wait for it to finish. Prefers a write that gets a response: OBDLink's
 * notes say its adapter does not support queued writes, so each write must wait for its response.
 * Write-without-response is only used when the characteristic offers nothing else.
 */
export async function writeChunk(char: Writable, piece: Uint8Array<ArrayBuffer>): Promise<void> {
  if (char.properties.write || !char.properties.writeWithoutResponse) await char.writeValue(piece);
  else await char.writeValueWithoutResponse(piece);
}

/** Send bytes in 20-byte pieces, strictly one after another. */
export async function writeInChunks(char: Writable, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) await writeChunk(char, bytes.slice(i, i + CHUNK_BYTES));
}

class BleTransport implements Transport {
  private listener: ((chunk: string) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private ready: Promise<void>;

  constructor(
    device: BluetoothDevice,
    private readonly server: BluetoothRemoteGATTServer,
    listenChar: BluetoothRemoteGATTCharacteristic,
    private readonly writeChar: BluetoothRemoteGATTCharacteristic,
  ) {
    device.addEventListener('gattserverdisconnected', () => {
      if (!this.closed) this.closeListener?.();
      this.closed = true;
    });
    listenChar.addEventListener('characteristicvaluechanged', () => {
      const v = listenChar.value;
      if (!v) return;
      this.listener?.(this.decoder.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), { stream: true }));
    });
    this.ready = listenChar.startNotifications().then(() => undefined);
  }

  onLine(listener: (chunk: string) => void): void {
    this.listener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  /** Writes are queued one after another so two commands can never interleave. */
  send(line: string): Promise<void> {
    // A second guard behind the one in Session: the transport itself will not write anything but a read.
    if (!isAllowedCommand(line)) return Promise.reject(new Error('Refused: the app only reads.'));
    const bytes = new TextEncoder().encode(line.toUpperCase().replace(/ /g, '') + '\r');
    const job = this.queue.then(async () => {
      if (this.closed) throw new Error('closed');
      await this.ready;
      await writeInChunks(this.writeChar, bytes);
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  close(): void {
    this.closed = true;
    try {
      if (this.server.connected) this.server.disconnect();
    } catch {
      // Already gone; nothing to do.
    }
  }
}
