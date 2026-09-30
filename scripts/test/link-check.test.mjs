import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrls, summarize } from '../link-check.mjs';
import { render } from '../lib/i18n.mjs';
import { setLogLevel } from '../lib/log.mjs';

setLogLevel('ERROR');

test('checkUrls: notes are messages, summarize turns them into lines with the note', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/bot')) return { status: 403, headers: { get: () => null } };
    if (url.endsWith('/slow')) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return { status: 404, headers: { get: () => null } };
  };
  const items = [
    { url: 'https://site.test/bot', kind: 'link' },
    { url: 'https://site.test/slow', kind: 'image' },
    { url: 'https://site.test/gone', kind: 'link' },
    { url: 'https://tilda.ru/page/preview/?pageid=100001', kind: 'link', internal: true },
  ];
  const results = await checkUrls(items, { fetchImpl, timeoutMs: 50, concurrency: 1 });
  const summary = summarize(results);
  assert.equal(summary.brokenLinks, 1);
  assert.equal(summary.brokenImages, 1);
  assert.equal(summary.internal, 1);
  const en = render('en', summary);
  assert.ok(en.broken.includes('image 0 https://site.test/slow — timeout 50 ms'), en.broken.join('\n'));
  assert.ok(en.broken.includes('link 404 https://site.test/gone'), en.broken.join('\n'));
  assert.ok(en.warned.some((line) => line.includes('403') && line.includes('bot protection')), en.warned.join('\n'));
  assert.doesNotMatch(JSON.stringify(en), /[А-Яа-яЁё]/);
  assert.ok(render('ru', summary).broken.includes('image 0 https://site.test/slow — таймаут 50 мс'));
});
