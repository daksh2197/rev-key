import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bluetoothAvailable,
  BleError,
  CANDIDATE_SERVICES,
  chooseEndpoint,
  chunkText,
  connectBle,
  parseServiceUuid,
  writeInChunks,
  writeChunk,
  serviceList,
  type ServiceInfo,
} from './ble';

afterEach(() => vi.unstubAllGlobals());

describe('service UUIDs typed by the user', () => {
  it('accepts a 16-bit hex UUID', () => expect(parseServiceUuid('FFF0')).toBe(0xfff0));
  it('accepts a 16-bit hex UUID with 0x in front', () => expect(parseServiceUuid('0xffe0')).toBe(0xffe0));
  it('accepts a 16-bit hex UUID with spaces around it', () => expect(parseServiceUuid('  18f0 ')).toBe(0x18f0));
  it('accepts a full 128-bit UUID and lower-cases it', () => {
    expect(parseServiceUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
  });
  it('refuses an empty box', () => expect(parseServiceUuid('')).toBeNull());
  it('refuses a UUID with a letter that is not hex', () => expect(parseServiceUuid('FFG0')).toBeNull());
  it('refuses a 3-digit or 5-digit value', () => {
    expect(parseServiceUuid('FFF')).toBeNull();
    expect(parseServiceUuid('FFF00')).toBeNull();
  });
  it('refuses a 32-bit UUID', () => expect(parseServiceUuid('0000fff0')).toBeNull());
  it('refuses a 128-bit UUID with a missing group', () => {
    expect(parseServiceUuid('6e400001-b5a3-f393-e0a9')).toBeNull();
  });
  it('refuses a 128-bit UUID without dashes', () => {
    expect(parseServiceUuid('6e400001b5a3f393e0a9e50e24dcca9e')).toBeNull();
  });
  it('refuses anything that is not a string', () => {
    expect(parseServiceUuid(undefined as unknown as string)).toBeNull();
    expect(parseServiceUuid(12 as unknown as string)).toBeNull();
  });
  it('refuses names such as battery_service', () => expect(parseServiceUuid('battery_service')).toBeNull());
  it('never throws and only returns a number or a 36-character string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = parseServiceUuid(s);
        return r === null || (typeof r === 'number' && r >= 0 && r <= 0xffff) || (typeof r === 'string' && r.length === 36);
      }),
      { numRuns: 300 },
    );
  });
  it('accepts every four-digit hex value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff }), (n) => parseServiceUuid(n.toString(16).padStart(4, '0')) === n),
      { numRuns: 300 },
    );
  });
});

describe('the list of services to look for', () => {
  it('includes the commonly used serial bridges', () => {
    expect(CANDIDATE_SERVICES).toContain(0xfff0);
    expect(CANDIDATE_SERVICES).toContain(0xffe0);
    expect(CANDIDATE_SERVICES).toContain('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
    expect(CANDIDATE_SERVICES).toContain(0x18f0);
  });
  it('puts the user\'s service first', () => expect(serviceList('1234')[0]).toBe(0x1234));
  it('ignores an invalid user service', () => expect(serviceList('nonsense')).toEqual(CANDIDATE_SERVICES));
  it('ignores an empty user service', () => expect(serviceList('')).toEqual(CANDIDATE_SERVICES));
  it('does not list a service twice', () => {
    const list = serviceList('0xFFF0');
    expect(list.filter((s) => s === 0xfff0)).toHaveLength(1);
  });
});

describe('writing in 20-byte pieces', () => {
  it('leaves a short command in one piece', () => expect(chunkText('010C\r')).toEqual(['010C\r']));
  it('cuts a long text into pieces of at most 20', () => {
    const pieces = chunkText('a'.repeat(45));
    expect(pieces.map((p) => p.length)).toEqual([20, 20, 5]);
  });
  it('gives back the same text when the pieces are joined', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.integer({ min: 1, max: 40 }), (s, n) => {
        const pieces = chunkText(s, n);
        return pieces.join('') === s && pieces.every((p) => p.length <= n);
      }),
      { numRuns: 300 },
    );
  });
  it('gives no pieces for empty text', () => expect(chunkText('')).toEqual([]));
});

describe('choosing where to listen and write', () => {
  const svc = (uuid: string, ...chars: ServiceInfo['characteristics']): ServiceInfo => ({ uuid, characteristics: chars });
  const c = (uuid: string, notify: boolean, write: boolean, wnr = false) => ({ uuid, notify, write, writeWithoutResponse: wnr });

  it('picks separate notify and write characteristics', () => {
    const e = chooseEndpoint([svc('s', c('fff1', true, false), c('fff2', false, true))]);
    expect(e).toEqual({ service: 's', notify: 'fff1', write: 'fff2' });
  });
  it('uses one characteristic for both when it can do both', () => {
    const e = chooseEndpoint([svc('s', c('ffe1', true, true, true))]);
    expect(e).toEqual({ service: 's', notify: 'ffe1', write: 'ffe1' });
  });
  it('accepts write-without-response as writing', () => {
    expect(chooseEndpoint([svc('s', c('a', true, false), c('b', false, false, true))])?.write).toBe('b');
  });
  it('skips a service with nothing to listen to', () => {
    const e = chooseEndpoint([svc('one', c('x', false, true)), svc('two', c('y', true, true))]);
    expect(e?.service).toBe('two');
  });
  it('skips a service with nothing to write to', () => {
    const e = chooseEndpoint([svc('one', c('x', true, false)), svc('two', c('y', true, true))]);
    expect(e?.service).toBe('two');
  });
  it('picks the first suitable service', () => {
    const e = chooseEndpoint([svc('one', c('x', true, true)), svc('two', c('y', true, true))]);
    expect(e?.service).toBe('one');
  });
  it('returns null when nothing fits', () => {
    expect(chooseEndpoint([])).toBeNull();
    expect(chooseEndpoint([svc('s', c('x', false, false))])).toBeNull();
  });
});

describe('a browser without Web Bluetooth', () => {
  it('says Web Bluetooth is not available', () => {
    vi.stubGlobal('navigator', {});
    expect(bluetoothAvailable()).toBe(false);
  });
  it('says it is not available when there is no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(bluetoothAvailable()).toBe(false);
  });
  it('refuses to connect with a plain sentence', async () => {
    vi.stubGlobal('navigator', {});
    await expect(connectBle()).rejects.toBeInstanceOf(BleError);
    await expect(connectBle()).rejects.toThrow(/no Web Bluetooth/);
  });
});

// ----- a pretend Bluetooth stack, to check what the transport actually does -----

class FakeChar extends EventTarget {
  writes: Uint8Array[] = [];
  withResponse = 0;
  withoutResponse = 0;
  notifying = false;
  value: DataView | undefined;
  constructor(
    public uuid: string,
    public properties: { notify: boolean; indicate: boolean; write: boolean; writeWithoutResponse: boolean },
  ) {
    super();
  }
  startNotifications() {
    this.notifying = true;
    return Promise.resolve(this);
  }
  writeValueWithoutResponse(v: Uint8Array) {
    this.withoutResponse++;
    this.writes.push(v);
    return Promise.resolve();
  }
  writeValue(v: Uint8Array) {
    this.withResponse++;
    this.writes.push(v);
    return Promise.resolve();
  }
  push(text: string) {
    const bytes = new TextEncoder().encode(text);
    this.value = new DataView(bytes.buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function pretendStack(chars: FakeChar[]) {
  const device = Object.assign(new EventTarget(), {
    gatt: {
      connected: true,
      connect() {
        return Promise.resolve(this);
      },
      disconnect() {
        this.connected = false;
      },
      getPrimaryServices: () => Promise.resolve([{ uuid: 'svc', getCharacteristics: () => Promise.resolve(chars) }]),
    },
  });
  const requestDevice = vi.fn(() => Promise.resolve(device));
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
  return { device, requestDevice };
}

const props = (notify: boolean, write: boolean) => ({ notify, indicate: false, write, writeWithoutResponse: write });

describe('the Web Bluetooth transport with a pretend adapter', () => {
  it('asks the browser for any device plus the candidate services', async () => {
    const { requestDevice } = pretendStack([new FakeChar('ffe1', props(true, true))]);
    await connectBle('1234');
    expect(requestDevice).toHaveBeenCalledWith({ acceptAllDevices: true, optionalServices: serviceList('1234') });
  });
  it('subscribes to the notify characteristic', async () => {
    const rx = new FakeChar('fff1', props(true, false));
    pretendStack([rx, new FakeChar('fff2', props(false, true))]);
    await connectBle();
    expect(rx.notifying).toBe(true);
  });
  it('writes a command plus CR to the write characteristic', async () => {
    const tx = new FakeChar('fff2', props(false, true));
    pretendStack([new FakeChar('fff1', props(true, false)), tx]);
    const t = await connectBle();
    await t.send('010c');
    expect(tx.writes.map((w) => new TextDecoder().decode(w)).join('')).toBe('010C\r');
  });
  it('refuses to write anything that is not a read', async () => {
    const tx = new FakeChar('fff2', props(false, true));
    pretendStack([new FakeChar('fff1', props(true, false)), tx]);
    const t = await connectBle();
    await expect(t.send('04')).rejects.toThrow(/only reads/);
    await expect(t.send('ATPP FF OFF')).rejects.toThrow(/only reads/);
    expect(tx.writes).toHaveLength(0);
  });
  it('hands incoming text to the listener', async () => {
    const rx = new FakeChar('fff1', props(true, false));
    pretendStack([rx, new FakeChar('fff2', props(false, true))]);
    const t = await connectBle();
    const got: string[] = [];
    t.onLine((c) => got.push(c));
    rx.push('41 0C 1A F8\r\r>');
    expect(got.join('')).toBe('41 0C 1A F8\r\r>');
  });
  it('tells the listener when the link drops', async () => {
    const { device } = pretendStack([new FakeChar('ffe1', props(true, true))]);
    const t = await connectBle();
    const closed = vi.fn();
    t.onClose?.(closed);
    device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(closed).toHaveBeenCalledOnce();
  });
  it('explains when the adapter has no serial-style service', async () => {
    pretendStack([new FakeChar('2a00', props(false, false))]);
    await expect(connectBle()).rejects.toThrow(/Setup page/);
  });
  it('reports a closed picker as cancelled', async () => {
    const requestDevice = vi.fn(() => Promise.reject(new DOMException('none', 'NotFoundError')));
    vi.stubGlobal('navigator', { bluetooth: { requestDevice } });
    await expect(connectBle()).rejects.toThrow('cancelled');
  });
});

describe('write order', () => {
  const props = (write: boolean, wnr: boolean) => ({ write, writeWithoutResponse: wnr });
  it('prefers a write with a response when the characteristic offers it', async () => {
    const c = new FakeChar('x', { notify: false, indicate: false, ...props(true, true) });
    await writeChunk(c, new Uint8Array([1]));
    expect([c.withResponse, c.withoutResponse]).toEqual([1, 0]);
  });
  it('falls back to write-without-response only when write is not offered', async () => {
    const c = new FakeChar('x', { notify: false, indicate: false, ...props(false, true) });
    await writeChunk(c, new Uint8Array([1]));
    expect([c.withResponse, c.withoutResponse]).toEqual([0, 1]);
  });
  it('waits for each 20-byte piece to finish before sending the next', async () => {
    let busy = false;
    let overlap = false;
    const sizes: number[] = [];
    const slow = {
      properties: props(true, false),
      writeValue: async (v: Uint8Array) => {
        if (busy) overlap = true;
        busy = true;
        sizes.push(v.length);
        await new Promise((r) => setTimeout(r, 5));
        busy = false;
      },
      writeValueWithoutResponse: () => Promise.reject(new Error('should not be used')),
    };
    await writeInChunks(slow, new Uint8Array(45));
    expect(overlap).toBe(false);
    expect(sizes).toEqual([20, 20, 5]);
  });
});
