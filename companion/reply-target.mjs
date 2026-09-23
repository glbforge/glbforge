/**
 * Which inbox item a POST /reply answers.
 *
 * Pulled out of main.mjs's HTTP handler so it can be unit-tested without an
 * Electron runtime: it touches only the inbox array and the answered set,
 * nothing from the window or the brain.
 */

/**
 * @param {Array<{id: number}>} inbox unanswered-or-not items, oldest first
 * @param {Set<number>} answered ids already replied to
 * @param {number | null} requestedId an explicit id from the caller, or null/undefined for "the oldest unanswered"
 * @returns {{ item: {id: number} | null, error: string | null }}
 */
export function pickReplyTarget(inbox, answered, requestedId) {
  if (requestedId != null) {
    const exact = inbox.find((i) => i.id === requestedId);
    if (!exact) {
      return { item: null, error: `no pending item with id ${requestedId} (it may already be answered, or never existed); call companion_listen or check companion_state.data.inbox_pending` };
    }
    return { item: exact, error: null };
  }
  const oldest = inbox.find((i) => !answered.has(i.id));
  if (!oldest) return { item: null, error: 'nothing to reply to (inbox empty)' };
  return { item: oldest, error: null };
}
