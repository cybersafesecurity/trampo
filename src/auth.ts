// Public address reservation for UX only. Privileges are granted by the database
// after Supabase verifies this exact email; changing this constant grants nothing.
export const ADMIN_EMAIL = 'trampo.the.app@gmail.com';
export const RESET_COOLDOWN_SECONDS = 60;

export function normalizeEmail(value: string) { return value.trim().toLowerCase(); }
export function isAdminEmail(value: string) { return normalizeEmail(value) === ADMIN_EMAIL; }
export function authRedirectTo() { return `${location.origin}${location.pathname}`; }

export function newPasswordProblem(password: string, confirmation: string): string {
  if (password.length < 10) return 'Use a password with at least 10 characters.';
  if (password.length > 128) return 'Use a password with no more than 128 characters.';
  if (password !== confirmation) return 'The passwords do not match. Please check both fields.';
  return '';
}

type ErrorLike = { message?: string; code?: string; status?: number };
export function authErrorMessage(error: unknown): string {
  const e = (error || {}) as ErrorLike;
  const code = `${e.code || ''} ${e.message || ''}`.toLowerCase();
  if (code.includes('email_address_not_authorized') || code.includes('not authorized'))
    return 'This email is not authorized by the current mail service. Use trampo.the.app@gmail.com for admin access. Other addresses need custom SMTP configured in Supabase.';
  if (code.includes('rate_limit') || code.includes('rate limit') || code.includes('too many') || e.status === 429 || code.includes('after '))
    return 'Too many email requests. Please wait before trying again; the test mail service allows only about two emails per hour. Check your inbox and spam folder before requesting another link.';
  if (code.includes('otp_expired') || code.includes('expired') || code.includes('invalid flow state') || code.includes('code challenge') || code.includes('code verifier'))
    return 'This email link has expired, was already used, or belongs to a different browser. Request a new link and open the newest email in the same browser where you requested it.';
  if (code.includes('invalid_credentials') || code.includes('invalid login')) return 'The email or password is incorrect. Check both, or use Forgot password?';
  if (code.includes('email_exists') || code.includes('user_already_exists')) return 'An account already uses this email. Sign in or use Forgot password? to regain access.';
  if (code.includes('same_password') || code.includes('different from the old')) return 'Choose a different password from your previous one.';
  if (code.includes('weak_password') || code.includes('password should')) return 'Choose a stronger password with at least 10 characters.';
  if (code.includes('email not confirmed')) return 'Confirm your email using the signup link before signing in. Check your inbox and spam folder.';
  if (code.includes('failed to fetch') || code.includes('network') || code.includes('fetch failed')) return 'Could not reach the account service. Check your internet connection and try again.';
  return e.message || 'Something went wrong. Please try again.';
}

// Supabase returns email-link errors in either the query or hash. Display these
// instead of silently dropping the user onto an unrelated sign-in screen.
export function authCallbackError(url: string): string {
  try {
    const parsed = new URL(url);
    const params = [new URLSearchParams(parsed.search), new URLSearchParams(parsed.hash.replace(/^#/, ''))];
    for (const p of params) {
      if (p.has('error') || p.has('error_description'))
        return authErrorMessage({ code: p.get('error_code') || p.get('error') || '', message: p.get('error_description') || '' });
    }
  } catch { /* An invalid URL is not an auth callback. */ }
  return '';
}

export function clearAuthCallback() {
  const url = new URL(location.href);
  const authKeys = new Set(['code', 'error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type', 'token_hash']);
  const clean = (params: URLSearchParams) => { for (const key of authKeys) params.delete(key); return params; };
  const query = clean(url.searchParams).toString();
  const hash = clean(new URLSearchParams(url.hash.replace(/^#/, ''))).toString();
  // Keep ordinary app navigation such as #profile, but remove one-time credentials.
  const navigationHash = url.hash && !url.hash.includes('=') ? url.hash : hash ? `#${hash}` : '';
  history.replaceState(null, '', `${url.pathname}${query ? `?${query}` : ''}${navigationHash}`);
}
