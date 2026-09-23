/**
 * Runs tasks one at a time, in the order they arrive.
 *
 * Every rgb-lib binding takes a mutable borrow of the wallet for the whole call, and the
 * async ones (`sync`, sends) hold it across their awaits. A second command arriving
 * mid-sync panics inside rgb-lib with a BorrowMutError, and a WebAssembly panic leaves the
 * engine unusable until the wallet is reopened. Callers cannot coordinate this themselves:
 * in a browser several views may hold the same account.
 *
 * A rejected task must not stall the queue, so the tail swallows the outcome; the caller
 * still receives the original promise.
 *
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>} The queueing function.
 */
export default function serialQueue(): <T>(task: () => Promise<T> | T) => Promise<T>;
