import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_EMAIL, authCallbackError, authErrorMessage, authRedirectTo, clearAuthCallback, isAdminEmail, newPasswordProblem, normalizeEmail } from '../src/auth.ts';

test('admin reservation is an exact, normalized email match', () => {
  assert.equal(ADMIN_EMAIL, 'trampo.the.app@gmail.com');
  assert.equal(normalizeEmail('  Trampo.The.App@Gmail.com  '), ADMIN_EMAIL);
  assert.equal(isAdminEmail(` ${ADMIN_EMAIL.toUpperCase()} `), true);
  for (const email of ['trampo.the.app+other@gmail.com', 'trampotheapp@gmail.com', 'trampo.the.app@gmail.com.evil.test', 'kampalanalf@gmail.com']) assert.equal(isAdminEmail(email), false);
});
test('new passwords require 10–128 characters and an exact confirmation', () => {
  assert.match(newPasswordProblem('short', 'short'), /10 characters/);
  assert.match(newPasswordProblem('a'.repeat(129), 'a'.repeat(129)), /128/);
  assert.match(newPasswordProblem('a-valid-password', 'different-password'), /do not match/);
  assert.equal(newPasswordProblem('a-valid-password', 'a-valid-password'), '');
});
test('email delivery, rate-limit, expired-link and sign-in errors are actionable', () => {
  assert.match(authErrorMessage({ code: 'email_address_not_authorized' }), /custom SMTP/);
  assert.match(authErrorMessage({ code: 'over_email_send_rate_limit' }), /two emails per hour/);
  assert.match(authErrorMessage({ code: 'otp_expired' }), /newest email/);
  assert.match(authErrorMessage({ message: 'Code verifier not found' }), /same browser/);
  assert.match(authErrorMessage({ code: 'invalid_credentials' }), /Forgot password/);
  assert.match(authErrorMessage({ code: 'email_exists' }), /already uses/);
  assert.match(authErrorMessage({ message: 'Failed to fetch' }), /internet connection/);
});
test('auth callback errors are read from query and hash without accepting unrelated hashes', () => {
  assert.match(authCallbackError('https://example.test/trampo/?error=access_denied&error_code=otp_expired'), /expired/);
  assert.match(authCallbackError('https://example.test/trampo/#error_description=Email%20link%20expired'), /expired/);
  assert.equal(authCallbackError('https://example.test/trampo/#profile'), '');
});
test('auth redirects preserve the static-host subpath and exclude old credentials', () => {
  const oldLocation = globalThis.location, oldHistory = globalThis.history;
  try {
    globalThis.location = { origin: 'https://example.test', pathname: '/trampo/', hash: '#access_token=secret', href: 'https://example.test/trampo/?code=one-time#access_token=secret' };
    assert.equal(authRedirectTo(), 'https://example.test/trampo/');
    let replacement = '';
    globalThis.history = { replaceState(_state, _title, url) { replacement = url; } };
    clearAuthCallback();
    assert.equal(replacement, '/trampo/');
    globalThis.location.href = 'https://example.test/trampo/?keep=yes&code=one-time#profile';
    clearAuthCallback();
    assert.equal(replacement, '/trampo/?keep=yes#profile');
  } finally { globalThis.location = oldLocation; globalThis.history = oldHistory; }
});
