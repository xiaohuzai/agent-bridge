// adapters/pending-rpcs.mjs — settling in-flight JSON-RPC calls when a child
// dies or is replaced.
//
// Every long-lived adapter keeps `pending: Map<id, {resolve, reject, child}>`.
// The paid-for rule is the child identity: a late `exit` event from an OLD
// child must never reject a NEW child's pending calls (same lesson as the
// turn sweep). Three adapters carried the same two loops; this is the one
// copy, so a future fix cannot land in two of three places.

/** Reject only the calls owned by `child`; leave a newer child's calls alone. */
export function rejectPendingForChild(pending, child, message) {
  for (const [id, p] of pending) {
    if (p.child !== child) continue;
    pending.delete(id);
    p.reject(new Error(message));
  }
}

/** Reject everything — the child being replaced owns every unsettled call. */
export function rejectAllPending(pending, message) {
  for (const [, p] of pending) p.reject(new Error(message));
  pending.clear();
}
