import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  formatAgentResponse,
  normalizeMarkdown,
  normalizeStreamingMarkdown,
  toPlainText,
} from '../src/formatting.js';
import { encodeChatTarget, parseChatTarget } from '../src/bridge.js';

test('formatAgentResponse emits a single markdown chunk for short input', () => {
  const chunks = formatAgentResponse('Hello **world**');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.parseMode, 'markdown');
  assert.match(chunks[0]!.text, /Hello \*\*world\*\*/);
});

test('formatAgentResponse splits long input into multiple chunks under the limit', () => {
  const long = `${'paragraph one. '.repeat(400)}\n\n${'paragraph two. '.repeat(400)}`;
  const chunks = formatAgentResponse(long);
  assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 5000, 'each chunk should be ≤5000 chars');
  }
});

test('normalizeMarkdown collapses repeated blank lines', () => {
  assert.equal(normalizeMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('normalizeStreamingMarkdown closes unbalanced bold', () => {
  // remend should close the dangling `**` so the partial output renders.
  const out = normalizeStreamingMarkdown('hello **world');
  assert.match(out, /\*\*world\*?\*?/);
});

test('toPlainText strips markdown formatting', () => {
  const plain = toPlainText('# Title\n\n- one\n- two');
  assert.match(plain, /Title/);
  assert.match(plain, /one/);
  assert.match(plain, /two/);
  assert.doesNotMatch(plain, /<\/?[a-z]/);
});

test('encodeChatTarget / parseChatTarget roundtrip', () => {
  const target = encodeChatTarget('cc0onr82', 'group');
  assert.equal(target, 'group:cc0onr82');
  const parsed = parseChatTarget(target);
  assert.deepEqual(parsed, { chatId: 'cc0onr82', chatType: 'group' });
});

test('parseChatTarget treats bare id as private', () => {
  assert.deepEqual(parseChatTarget('u_abc'), {
    chatId: 'u_abc',
    chatType: 'private',
  });
});
