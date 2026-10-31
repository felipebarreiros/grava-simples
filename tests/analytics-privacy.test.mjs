import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPage, analyticsUrl, sanitizeAnalytics } from '../src/analytics/privacy.ts';

const origin = 'https://grava-simples.vercel.app';

test('analytics routes remove Clerk challenges and local project and take identifiers', () => {
  assert.equal(analyticsPage('/login/sso-callback'), 'login');
  assert.equal(analyticsPage('/app', '#project/private-project/recording/private-take'), 'recording');
  assert.equal(analyticsPage('/app', '#project/private-project'), 'studio');
  assert.equal(analyticsPage('/anything-private'), 'not-found');
  assert.equal(analyticsUrl(origin + '/login/sso-callback?__clerk_ticket=secret#private', origin), origin + '/login');
  assert.equal(analyticsUrl(origin + '/app?redirect_url=private#project/private-project/recording/private-take', origin), origin + '/recording');
  assert.equal(analyticsUrl('blob:' + origin + '/private-media', origin), '[redacted]');
  assert.equal(analyticsUrl('https://clerk.example/v1/client?jwt=secret', origin), 'https://clerk.example');
  assert.equal(analyticsUrl(origin + '/assets/index-123.js?ticket=secret', origin), origin + '/assets/index-123.js');
});

test('SDK event sanitization removes DOM content and secrets while preserving replay and symbolication', () => {
  const source = {
    $current_url: origin + '/app?secret=one#project/private-project/recording/private-take',
    $session_entry_referrer: origin + '/login?__clerk_ticket=secret',
    $set_once: { $initial_current_url: origin + '/login?__clerk_ticket=secret', $initial_referrer: 'https://private.example/secret' },
    $elements: [{ tag_name: 'button', $el_text: 'My private recording', attr__title: 'Private name' }],
    $exception_message: 'Private transcript',
    $exception_list: [{ type: 'TypeError', value: 'Private transcript', stacktrace: { frames: [{ filename: origin + '/assets/main.js?secret=two', function: 'onSave', lineno: 42, vars: { token: 'secret' }, context_line: 'private source' }] } }],
    $snapshot_data: [{ type: 2, data: { masked: true } }],
    format: 'srt',
  };
  const safe = sanitizeAnalytics(source, origin);
  assert.equal(safe.$current_url, origin + '/recording');
  assert.equal(safe.$set_once.$initial_current_url, origin + '/login');
  assert.deepEqual(safe.$elements, [{ tag_name: 'button' }]);
  assert.equal(safe.$exception_list[0].stacktrace.frames[0].filename, origin + '/assets/main.js');
  assert.equal(safe.$exception_list[0].stacktrace.frames[0].lineno, 42);
  assert.equal(safe.$exception_list[0].value, 'Application error (message redacted)');
  assert.deepEqual(safe.$snapshot_data, source.$snapshot_data);
  assert.equal(safe.format, 'srt');
  assert.doesNotMatch(JSON.stringify(safe), /secret|Private|private-project|private-take/);
  assert.equal(source.$exception_list[0].value, 'Private transcript');
});
