import { useSyncExternalStore } from 'react';

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export type PwaState = {
  /** Browser reports a network connection. This is not a guarantee the backend is reachable. */
  online: boolean;
  /** Running as an installed app / Add to Home Screen. */
  standalone: boolean;
  /** The browser offered a native install prompt. */
  canInstall: boolean;
  /** The app has been installed in this browser. */
  installed: boolean;
  /** A new service worker is waiting for the user's explicit restart. */
  updateReady: boolean;
  /** The public app shell is cached for offline launch. */
  offlineReady: boolean;
  /** Service worker registration failed; the site still works online. */
  registrationFailed: boolean;
  secure: boolean;
  supported: boolean;
};

const listeners = new Set<() => void>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let updateRequested = false;
let initialized = false;

function standaloneNow() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: window-controls-overlay)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

let state: PwaState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  standalone: standaloneNow(),
  canInstall: false,
  installed: standaloneNow(),
  updateReady: false,
  offlineReady: false,
  registrationFailed: false,
  secure: typeof window === 'undefined' ? false : window.isSecureContext,
  supported: typeof navigator !== 'undefined' && !!navigator.serviceWorker,
};

function patch(next: Partial<PwaState>) {
  const merged = { ...state, ...next };
  if (Object.keys(next).every(key => merged[key as keyof PwaState] === state[key as keyof PwaState])) return;
  state = merged;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function snapshot() { return state; }

export function usePwa() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Shared by the PWA shell and incoming-call notifications: one worker per scope. */
export async function registerTrampoWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !navigator.serviceWorker || !window.isSecureContext) return null;
  if (!registrationPromise) {
    // Production builds get the full app-shell worker. Vite dev keeps the earlier
    // notification-only worker so hot reload is never trapped behind a cache.
    const file = import.meta.env.PROD ? 'sw.js' : 'call-sw.js';
    const script = new URL(`${import.meta.env.BASE_URL}${file}`, location.href);
    const scope = new URL('.', script).href;
    registrationPromise = navigator.serviceWorker.register(script.href, { scope, updateViaCache: 'none' })
      .then(async reg => {
        registration = reg;
        patch({ registrationFailed: false });
        if (reg.waiting && navigator.serviceWorker.controller) patch({ updateReady: true });
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) patch({ updateReady: true });
          });
        });
        await navigator.serviceWorker.ready;
        patch({ offlineReady: import.meta.env.PROD });
        return reg;
      })
      .catch(() => {
        patch({ registrationFailed: true, offlineReady: false });
        return null;
      });
  }
  return registrationPromise;
}

export async function installPwa(): Promise<'accepted' | 'dismissed' | 'unavailable' | 'installed'> {
  if (state.standalone || state.installed) return 'installed';
  const prompt = deferredPrompt;
  if (!prompt) return 'unavailable';
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    deferredPrompt = null;
    patch({ canInstall: false, installed: choice.outcome === 'accepted' || state.installed });
    return choice.outcome;
  } catch {
    deferredPrompt = null;
    patch({ canInstall: false });
    return 'unavailable';
  }
}

export async function checkForPwaUpdate() {
  try { await registration?.update(); } catch { /* Offline or transient; keep the current shell. */ }
}

export async function applyPwaUpdate() {
  const waiting = registration?.waiting;
  if (!waiting) { await checkForPwaUpdate(); return; }
  updateRequested = true;
  waiting.postMessage({ type: 'TRAMPO_UPDATE' });
}

export function initPwa() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const online = () => patch({ online: true });
  const offline = () => patch({ online: false });
  window.addEventListener('online', online);
  window.addEventListener('offline', offline);

  const display = window.matchMedia('(display-mode: standalone)');
  const displayChange = () => {
    const standalone = standaloneNow();
    patch({ standalone, installed: state.installed || standalone });
  };
  display.addEventListener?.('change', displayChange);

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    patch({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    patch({ canInstall: false, installed: true, standalone: standaloneNow() });
  });

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) {
        updateRequested = false;
        location.reload();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkForPwaUpdate();
    });
    void registerTrampoWorker();
    // Long-lived installed windows still check occasionally without disturbing a call.
    setInterval(() => { void checkForPwaUpdate(); }, 60 * 60 * 1000);
  }
}
