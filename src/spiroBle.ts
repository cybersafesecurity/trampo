// Browser adapters for the Spiro Sensor: Web Bluetooth advertisement scanning and device compass.
// Web Bluetooth is only available in Chromium-based browsers over HTTPS (or localhost).
// Continuous advertisement scanning (requestLEScan) additionally needs a Chromium flag on most
// platforms. Where it is missing, the fallback is a one-off device picker that gives no signal strength.
import { SPIRO_PREFIX, isSpiroName } from './spiroSensor';

export type SensorSupport = { state: 'ready' | 'picker' | 'unsupported'; message: string };
export type SpiroSighting = { id: string; name: string; rssi: number | null; at: number };

type BluetoothLike = {
  requestLEScan?: (options: object) => Promise<{ stop: () => void }>;
  requestDevice?: (options: object) => Promise<{ id: string; name?: string }>;
  addEventListener: (type: 'advertisementreceived', fn: (event: any) => void) => void;
  removeEventListener: (type: 'advertisementreceived', fn: (event: any) => void) => void;
};

function bluetooth(): BluetoothLike | null {
  return (globalThis.navigator as Navigator & { bluetooth?: BluetoothLike }).bluetooth ?? null;
}

export function sensorSupport(): SensorSupport {
  if (!window.isSecureContext) return { state: 'unsupported', message: 'The Spiro Sensor needs a secure (HTTPS) connection.' };
  const bt = bluetooth();
  if (!bt) return { state: 'unsupported', message: 'Web Bluetooth is not available in this browser. Use Chrome or Edge on Android or a desktop computer.' };
  if (typeof bt.requestLEScan === 'function') return { state: 'ready', message: 'Live scanning is available.' };
  if (typeof bt.requestDevice === 'function') return { state: 'picker', message: 'Live signal scanning is not enabled in this browser, so the sensor can only list matching devices once. To enable it in Chrome on Android, open chrome://flags and enable “Experimental Web Platform features”, then restart the browser.' };
  return { state: 'unsupported', message: 'This browser does not support Bluetooth scanning.' };
}

/**
 * Start scanning for advertisements whose names begin with TMD024. Must be called from a user gesture.
 * Returns a stop function.
 */
export async function startSpiroScan(onSighting: (sighting: SpiroSighting) => void): Promise<() => void> {
  const bt = bluetooth();
  if (!bt) throw new Error('Web Bluetooth is not available in this browser.');
  const filters = [{ namePrefix: SPIRO_PREFIX }];

  if (typeof bt.requestLEScan === 'function') {
    const scan = await bt.requestLEScan({ filters, keepRepeatedDevices: true });
    const handler = (event: any) => {
      const name: string | undefined = event.name ?? event.device?.name;
      if (!isSpiroName(name) || !event.device?.id) return;
      onSighting({ id: event.device.id, name: name as string, rssi: typeof event.rssi === 'number' ? event.rssi : null, at: Date.now() });
    };
    bt.addEventListener('advertisementreceived', handler);
    return () => {
      bt.removeEventListener('advertisementreceived', handler);
      try { scan.stop(); } catch { /* already stopped */ }
    };
  }

  if (typeof bt.requestDevice === 'function') {
    const device = await bt.requestDevice({ filters });
    if (isSpiroName(device.name)) onSighting({ id: device.id, name: device.name as string, rssi: null, at: Date.now() });
    return () => undefined;
  }
  throw new Error('Bluetooth scanning is not available in this browser.');
}

/** Subscribe to compass heading in degrees clockwise from north, or null when unavailable. */
export function watchHeading(onHeading: (heading: number | null) => void): () => void {
  type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
  const handler = (event: OrientationEvent) => {
    if (typeof event.webkitCompassHeading === 'number' && event.webkitCompassHeading >= 0) onHeading(event.webkitCompassHeading);
    else if (typeof event.alpha === 'number' && event.absolute) onHeading((360 - event.alpha + 360) % 360);
    else onHeading(null);
  };
  const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(eventName as 'deviceorientation', handler as EventListener);
  return () => window.removeEventListener(eventName as 'deviceorientation', handler as EventListener);
}

/** iOS requires an explicit permission request from a user gesture. Resolves true when orientation can be used. */
export async function requestOrientationPermission(): Promise<boolean> {
  const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    try { return (await DOE.requestPermission()) === 'granted'; } catch { return false; }
  }
  return typeof DOE !== 'undefined';
}
