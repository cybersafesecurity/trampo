import { asset } from './lib';
import { registerTrampoWorker } from './pwa';

export type CallAlertPreferences = { enabled: boolean; sound: boolean; vibration: boolean };
export type CallAlertPermission = NotificationPermission | 'unsupported';

const STORAGE_KEY = 'trampo.callAlerts.v1';
export const DEFAULT_CALL_ALERTS: CallAlertPreferences = { enabled: true, sound: true, vibration: true };

export function normalizeCallAlerts(value: unknown): CallAlertPreferences {
  const input = value && typeof value === 'object' ? value as Partial<CallAlertPreferences> : {};
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_CALL_ALERTS.enabled,
    sound: typeof input.sound === 'boolean' ? input.sound : DEFAULT_CALL_ALERTS.sound,
    vibration: typeof input.vibration === 'boolean' ? input.vibration : DEFAULT_CALL_ALERTS.vibration,
  };
}

export function readCallAlerts(): CallAlertPreferences {
  try { return normalizeCallAlerts(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
  catch { return { ...DEFAULT_CALL_ALERTS }; }
}

export function writeCallAlerts(prefs: CallAlertPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeCallAlerts(prefs))); } catch { /* Private mode can block storage. */ }
}

export function notificationPermission(): CallAlertPermission {
  if (typeof window === 'undefined' || !('Notification' in window) || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

let audio: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;
let vibrationTimer: ReturnType<typeof setInterval> | null = null;
let titleTimer: ReturnType<typeof setInterval> | null = null;
let originalTitle = '';
let activeCallId: string | null = null;
let desktopNotification: Notification | null = null;

export function audioReady() {
  return !!audio && audio.state === 'running';
}

export async function unlockCallAudio() {
  if (typeof window === 'undefined') return false;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;
  try {
    audio ||= new Ctor();
    if (audio.state === 'suspended') await audio.resume();
    return audio.state === 'running';
  } catch { return false; }
}

async function callWorker() {
  return registerTrampoWorker();
}

export async function requestCallNotificationPermission(): Promise<CallAlertPermission> {
  if (notificationPermission() === 'unsupported') return 'unsupported';
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') { await unlockCallAudio(); void callWorker(); }
    return permission;
  } catch { return Notification.permission; }
}

function ringOnce() {
  if (!audio || audio.state !== 'running') return;
  const now = audio.currentTime;
  // A short, original two-tone alert. No copyrighted ringtone or remote audio file.
  [[0, 880], [0.18, 1174.66], [0.42, 880]].forEach(([offset, frequency]) => {
    const oscillator = audio!.createOscillator();
    const gain = audio!.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
    oscillator.connect(gain).connect(audio!.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.18);
  });
}

function vibrateOnce() {
  try { navigator.vibrate?.([180, 90, 180, 90, 320]); } catch { /* Not supported on this device. */ }
}

function startTitleFlash(callerName: string) {
  if (titleTimer) return;
  originalTitle = document.title;
  let alert = false;
  titleTimer = setInterval(() => {
    alert = !alert;
    document.title = alert ? `📞 ${callerName} is calling · Trampo` : originalTitle;
  }, 900);
  document.title = `📞 ${callerName} is calling · Trampo`;
}

async function showNotification(callId: string, callerName: string, prefs: CallAlertPreferences) {
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
    body: `${callerName} is calling you on Trampo. Open the app to answer or decline.`,
    tag: `trampo-call-${callId}`,
    icon: asset('icons/icon-192.png'),
    badge: asset('icons/badge-96.png'),
    requireInteraction: true,
    silent: !prefs.sound,
    renotify: true,
    data: { callId, url: `${location.origin}${location.pathname}${location.search}#ride` },
  };
  if (prefs.vibration) options.vibrate = [180, 90, 180, 90, 320];
  try {
    const registration = await callWorker();
    if (activeCallId !== callId) return;
    if (registration?.active) {
      await registration.showNotification('Incoming Trampo call', options);
      return;
    }
  } catch { /* Fall back to the page Notification constructor. */ }
  if (activeCallId !== callId || notificationPermission() !== 'granted') return;
  try {
    desktopNotification = new Notification('Incoming Trampo call', options);
    desktopNotification.onclick = () => { window.focus(); desktopNotification?.close(); };
  } catch { /* Some mobile browsers require the service worker path above. */ }
}

export async function closeCallNotification(callId?: string) {
  const tag = `trampo-call-${callId || activeCallId || ''}`;
  try { desktopNotification?.close(); } catch { /* Already closed. */ }
  desktopNotification = null;
  try {
    const registration = await registerTrampoWorker();
    const notifications = await registration?.getNotifications({ tag });
    notifications?.forEach(notification => notification.close());
  } catch { /* No worker notification to close. */ }
}

export function startIncomingCallAlert(callId: string, callerName: string, prefs: CallAlertPreferences) {
  if (!prefs.enabled || activeCallId === callId) return;
  stopIncomingCallAlert();
  activeCallId = callId;
  startTitleFlash(callerName);
  if (prefs.sound) {
    void unlockCallAudio().then(unlocked => { if (unlocked && activeCallId === callId) { ringOnce(); ringTimer = setInterval(ringOnce, 1800); } });
  }
  if (prefs.vibration && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    vibrateOnce();
    vibrationTimer = setInterval(vibrateOnce, 1800);
  }
  if (notificationPermission() === 'granted') void showNotification(callId, callerName, prefs);
}

export function stopIncomingCallAlert() {
  const callId = activeCallId;
  activeCallId = null;
  if (ringTimer) clearInterval(ringTimer);
  if (vibrationTimer) clearInterval(vibrationTimer);
  if (titleTimer) clearInterval(titleTimer);
  ringTimer = vibrationTimer = titleTimer = null;
  if (originalTitle) document.title = originalTitle;
  originalTitle = '';
  try { navigator.vibrate?.(0); } catch { /* Ignore. */ }
  if (callId) void closeCallNotification(callId);
}

export async function previewCallAlert(prefs: CallAlertPreferences) {
  await unlockCallAudio();
  if (prefs.sound) ringOnce();
  if (prefs.vibration) vibrateOnce();
  if (notificationPermission() === 'granted') {
    const registration = await callWorker();
    const options: NotificationOptions = { body: 'Call alerts are ready. Incoming WebRTC calls will appear here.', tag: 'trampo-call-preview', icon: asset('icons/icon-192.png'), badge: asset('icons/badge-96.png'), silent: !prefs.sound };
    try {
      if (registration?.active) await registration.showNotification('Trampo call alerts enabled', options);
      else new Notification('Trampo call alerts enabled', options);
    } catch { /* In-app confirmation is still shown by the caller. */ }
  }
}
