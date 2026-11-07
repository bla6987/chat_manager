/**
 * Runs chat indexing in a worker when the browser allows it. Only response text
 * crosses to it and only a summary and encoded rows come back, so a chat's parsed
 * body never exists on the page. The worker goes away when it has been idle.
 */

const IDLE_MS = 30_000;
// A worker that never answers must not stop indexing for good. A reply to any job
// resets this, so only a stalled worker reaches it, not a long queue.
const STALL_MS = 30_000;

let worker = null;
let unavailable = false;
let nextJobId = 0;
let idleTimer = null;
let stallTimer = null;
const jobs = new Map();

/** The worker itself could not run, as opposed to rejecting one chat's content. */
export class IndexWorkerUnavailable extends Error {}

function watchForStall() {
    clearTimeout(stallTimer);
    stallTimer = jobs.size ? setTimeout(() => failAllJobs('Index worker stopped responding'), STALL_MS) : null;
    stallTimer?.unref?.();
}

function stopWorker() {
    clearTimeout(idleTimer);
    clearTimeout(stallTimer);
    idleTimer = null;
    stallTimer = null;
    worker?.terminate();
    worker = null;
}

function failAllJobs(error) {
    unavailable = true;
    stopWorker();
    const waiting = [...jobs.values()];
    jobs.clear();
    for (const job of waiting) job.reject(new IndexWorkerUnavailable(String(error?.message || error || 'Index worker failed')));
}

function startWorker() {
    worker = new Worker(new URL('./chat-index-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        watchForStall();
        if (data.ok) job.resolve({ summary: data.summary, descriptorsPayload: data.descriptorsPayload });
        else job.reject(new Error(data.error));
        if (jobs.size === 0) {
            idleTimer = setTimeout(stopWorker, IDLE_MS);
            idleTimer.unref?.();
        }
    };
    worker.onerror = event => { event.preventDefault?.(); failAllJobs(event.message); };
    worker.onmessageerror = () => failAllJobs('Index worker message failed');
}

/**
 * Whether indexChatTextInWorker can be tried at all.
 * @returns {boolean}
 */
export function isIndexWorkerAvailable() {
    return !unavailable && typeof Worker === 'function';
}

/**
 * @param {string} text - A chat's response body
 * @param {string} fileName
 * @returns {Promise<{ summary: Object, descriptorsPayload: string }>}
 *   Rejects with IndexWorkerUnavailable if the caller should index it itself.
 */
export function indexChatTextInWorker(text, fileName) {
    return new Promise((resolve, reject) => {
        clearTimeout(idleTimer);
        idleTimer = null;
        try {
            if (!worker) startWorker();
            const id = ++nextJobId;
            jobs.set(id, { resolve, reject });
            worker.postMessage({ id, text, fileName });
            if (!stallTimer) watchForStall();
        } catch (error) {
            failAllJobs(error);
            reject(new IndexWorkerUnavailable(String(error?.message || error)));
        }
    });
}
