/**
 * Generation Failure Alert — Detect failed foreground response generations and
 * play a short, self-contained Web Audio alert.
 *
 * SillyTavern does not expose a dedicated GENERATION_FAILED event. Detection
 * therefore combines its generation lifecycle, response, and stop events with
 * visible error toasts. A short settle delay lets the manual-stop event arrive
 * after GENERATION_ENDED before a missing response is classified as a failure.
 */

const RESPONSE_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const FAILURE_SETTLE_DELAY_MS = 180;
const ATTEMPT_EXPIRY_MS = 15 * 60 * 1000;

let audioContext = null;
let currentAttempt = null;
let attemptSequence = 0;
let toastObserver = null;
let audioWarningShown = false;

function getAudioContext() {
    if (audioContext) return audioContext;

    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) return null;

    audioContext = new AudioContextClass();
    return audioContext;
}

/**
 * Unlock Web Audio while handling a user gesture (for example, enabling the
 * toggle). Browsers may otherwise block a sound first requested after an API
 * call has failed in the background.
 * @returns {Promise<boolean>}
 */
export async function primeFailureAlertAudio() {
    try {
        const context = getAudioContext();
        if (!context) return false;
        if (context.state === 'suspended') {
            await context.resume();
        }
        return context.state === 'running';
    } catch (error) {
        console.warn('[chat_manager] Could not initialize failure alert audio:', error);
        return false;
    }
}

function scheduleTone(context, output, frequency, startOffset, duration) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const startAt = context.currentTime + startOffset;
    const endAt = startAt + duration;

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, startAt);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.82, endAt);

    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(0.24, startAt + 0.018);
    envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);

    oscillator.connect(envelope);
    envelope.connect(output);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.01);
}

/**
 * Play a concise descending two-note failure cue.
 * @returns {Promise<boolean>} Whether playback was scheduled.
 */
export async function playFailureAlertSound() {
    try {
        const ready = await primeFailureAlertAudio();
        const context = getAudioContext();
        if (!ready || !context) return false;

        const output = context.createGain();
        output.gain.setValueAtTime(0.7, context.currentTime);
        output.connect(context.destination);

        scheduleTone(context, output, 740, 0, 0.16);
        scheduleTone(context, output, 440, 0.19, 0.27);

        window.setTimeout(() => output.disconnect(), 650);
        return true;
    } catch (error) {
        if (!audioWarningShown) {
            audioWarningShown = true;
            console.warn('[chat_manager] Failed to play generation failure alert:', error);
        }
        return false;
    }
}

function isErrorToastNode(node) {
    if (!(node instanceof Element)) return false;
    return node.matches('.toast-error') || Boolean(node.querySelector('.toast-error'));
}

function isAttemptCurrent(attempt) {
    return Boolean(attempt && currentAttempt && attempt.id === currentAttempt.id);
}

function expireAttempt(attempt) {
    window.setTimeout(() => {
        if (isAttemptCurrent(attempt)) {
            currentAttempt = null;
        }
    }, ATTEMPT_EXPIRY_MS);
}

/**
 * @param {object} attempt
 * @param {string} reason
 * @param {() => boolean} isEnabled
 */
function alertForAttempt(attempt, reason, isEnabled) {
    if (!isAttemptCurrent(attempt) || attempt.alerted || attempt.stopped || !attempt.armed) return;
    if (!isEnabled()) return;

    attempt.alerted = true;
    console.warn(`[chat_manager] Response generation failed (${reason}).`);
    void playFailureAlertSound();
}

/**
 * Initialize generation failure detection. Safe to call once during extension
 * startup; subsequent calls are ignored.
 *
 * @param {object} options
 * @param {object} options.eventSource SillyTavern event emitter
 * @param {object} options.eventTypes SillyTavern event type map
 * @param {() => object} options.getContext Returns the current ST context
 * @param {() => boolean} options.isEnabled Returns the persisted toggle state
 */
export function initGenerationFailureAlert({ eventSource, eventTypes, getContext, isEnabled }) {
    if (!eventSource || !eventTypes || initGenerationFailureAlert.initialized) return;
    initGenerationFailureAlert.initialized = true;

    const hasAfterCommandsEvent = Boolean(eventTypes.GENERATION_AFTER_COMMANDS);

    // A persisted-on toggle still needs one interaction after a page load to
    // satisfy browser autoplay policies. Sending a message naturally supplies
    // that interaction before a later failure.
    const primeFromUserGesture = () => {
        if (isEnabled()) {
            void primeFailureAlertAudio();
        }
    };
    document.addEventListener('pointerdown', primeFromUserGesture, { capture: true, once: true });
    document.addEventListener('keydown', primeFromUserGesture, { capture: true, once: true });

    eventSource.on(eventTypes.GENERATION_STARTED, (type, _options, dryRun = false) => {
        if (dryRun || !RESPONSE_GENERATION_TYPES.has(type)) return;

        const attempt = {
            id: ++attemptSequence,
            type,
            armed: !hasAfterCommandsEvent,
            received: false,
            stopped: false,
            alerted: false,
            streamingFailed: false,
        };
        currentAttempt = attempt;
        expireAttempt(attempt);
    });

    if (hasAfterCommandsEvent) {
        eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS, (type, _options, dryRun = false) => {
            if (!currentAttempt || dryRun || currentAttempt.type !== type) return;
            currentAttempt.armed = true;
        });
    }

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        if (currentAttempt) {
            currentAttempt.received = true;
        }
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (currentAttempt) {
            currentAttempt.stopped = true;
        }
    });

    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        const attempt = currentAttempt;
        if (!attempt || !attempt.armed) return;

        // StreamingProcessor distinguishes a transport/parser failure
        // (isStopped=true, isFinished=false) from a user stop
        // (isFinished=true before GENERATION_STOPPED is emitted).
        const streamingProcessor = getContext()?.streamingProcessor;
        attempt.streamingFailed = Boolean(
            streamingProcessor?.isStopped === true && streamingProcessor?.isFinished === false,
        );

        window.setTimeout(() => {
            if (!isAttemptCurrent(attempt)) return;

            if (attempt.streamingFailed) {
                alertForAttempt(attempt, 'streaming error', isEnabled);
            } else if (!attempt.received && !attempt.stopped) {
                alertForAttempt(attempt, 'no response received', isEnabled);
            }

            if (isAttemptCurrent(attempt)) {
                currentAttempt = null;
            }
        }, FAILURE_SETTLE_DELAY_MS);
    });

    // Core API failures are normally rendered as toastr errors. Observing the
    // DOM avoids replacing toastr's single global subscriber used by ST itself.
    toastObserver = new MutationObserver((mutations) => {
        const attempt = currentAttempt;
        if (!attempt || !attempt.armed || attempt.stopped) return;

        for (const mutation of mutations) {
            if (Array.from(mutation.addedNodes).some(isErrorToastNode)) {
                alertForAttempt(attempt, 'API error', isEnabled);
                break;
            }
        }
    });
    toastObserver.observe(document.body, { childList: true, subtree: true });
}
