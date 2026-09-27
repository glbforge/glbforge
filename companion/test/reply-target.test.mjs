import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReplyTarget } from '../reply-target.mjs';

test('no id given: picks the oldest unanswered item', () => {
  const inbox = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const answered = new Set([1]);
  const { item, error } = pickReplyTarget(inbox, answered, null);
  assert.equal(error, null);
  assert.equal(item.id, 2);
});

test('id given and present: picks that exact item, even if it is not the oldest', () => {
  const inbox = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const answered = new Set();
  const { item, error } = pickReplyTarget(inbox, answered, 3);
  assert.equal(error, null);
  assert.equal(item.id, 3);
});

test('id given but stale (already answered and removed, or never existed): errors instead of silently answering a different item', () => {
  // id 1 was answered and spliced out of inbox already, as main.mjs does after a successful reply.
  const inbox = [{ id: 2 }, { id: 3 }];
  const answered = new Set([1]);
  const { item, error } = pickReplyTarget(inbox, answered, 1);
  assert.equal(item, null);
  assert.match(error, /no pending item with id 1/);
});

test('id given but inbox empty: errors, not "nothing to reply to"', () => {
  const { item, error } = pickReplyTarget([], new Set(), 5);
  assert.equal(item, null);
  assert.match(error, /no pending item with id 5/);
});

test('no id given and inbox empty: the generic empty-inbox error', () => {
  const { item, error } = pickReplyTarget([], new Set(), null);
  assert.equal(item, null);
  assert.match(error, /inbox empty/);
});
