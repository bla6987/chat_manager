/**
 * Momentum scrolling for long chat-manager lists.
 * Wheel/trackpad input adds inertial continuation with exponential decay.
 */

const BASE_FRAME_MS = 1000 / 60;
const VELOCITY_BLEND = 0.2;
const FRICTION_PER_FRAME = 0.92;
const MIN_VELOCITY_PX_PER_MS = 0.02;
const MAX_STEP_PX = 120;
const LINE_DELTA_PX = 16;

const DELTA_MODE_PIXEL = 0;
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

function getReducedMotionMedia() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return null;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)');
}

function prefersReducedMotion(media) {
    return !!media?.matches;
}

function normalizeDeltaPx(event, container) {
    if (!event || !container) return 0;

    let delta = event.deltaY;
    switch (event.deltaMode) {
        case DELTA_MODE_LINE:
            delta *= LINE_DELTA_PX;
            break;
        case DELTA_MODE_PAGE:
            delta *= (container.clientHeight || window.innerHeight || 0);
            break;
        case DELTA_MODE_PIXEL:
        default:
            break;
    }

    return Number.isFinite(delta) ? delta : 0;
}

/**
 * Attach inertial momentum behavior to a scroll container.
 * @param {HTMLElement} container
 * @returns {() => void} cleanup function
 */
export function attachMomentumScroll(container) {
    if (!container || typeof container.addEventListener !== 'function') {
        return () => { };
    }

    const reducedMotionMedia = getReducedMotionMedia();
    let rafId = null;
    let velocityPxPerMs = 0;
    let lastTimestamp = 0;

    const stopMomentum = () => {
        velocityPxPerMs = 0;
        lastTimestamp = 0;

        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    };

    const isTimelineActive = () => container.classList.contains('timeline-active');

    const animate = (timestamp) => {
        rafId = null;

        if (!container.isConnected || prefersReducedMotion(reducedMotionMedia) || isTimelineActive()) {
            stopMomentum();
            return;
        }

        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (maxScrollTop <= 0) {
            stopMomentum();
            return;
        }

        if (!lastTimestamp) {
            lastTimestamp = timestamp;
            rafId = requestAnimationFrame(animate);
            return;
        }

        const deltaTime = Math.max(0.5, timestamp - lastTimestamp);
        lastTimestamp = timestamp;

        const frameScaledFriction = Math.pow(FRICTION_PER_FRAME, deltaTime / BASE_FRAME_MS);
        velocityPxPerMs *= frameScaledFriction;

        if (Math.abs(velocityPxPerMs) < MIN_VELOCITY_PX_PER_MS) {
            stopMomentum();
            return;
        }

        const unclampedStep = velocityPxPerMs * deltaTime;
        const step = Math.max(-MAX_STEP_PX, Math.min(MAX_STEP_PX, unclampedStep));

        const prevTop = container.scrollTop;
        const nextTop = Math.max(0, Math.min(maxScrollTop, prevTop + step));
        container.scrollTop = nextTop;

        const hitBoundary = nextTop === prevTop
            || (nextTop === 0 && step < 0)
            || (nextTop === maxScrollTop && step > 0);

        if (hitBoundary) {
            stopMomentum();
            return;
        }

        rafId = requestAnimationFrame(animate);
    };

    const startMomentum = () => {
        if (rafId !== null) return;
        lastTimestamp = 0;
        rafId = requestAnimationFrame(animate);
    };

    const onUserInteraction = () => {
        stopMomentum();
    };

    const onWheel = (event) => {
        if (event.defaultPrevented) return;
        if (event.ctrlKey) return;
        if (prefersReducedMotion(reducedMotionMedia) || isTimelineActive()) {
            stopMomentum();
            return;
        }

        const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (maxScrollTop <= 0) {
            stopMomentum();
            return;
        }

        const previousVelocity = velocityPxPerMs;
        stopMomentum();

        const deltaPx = normalizeDeltaPx(event, container);
        if (deltaPx === 0) return;

        const impulsePxPerMs = deltaPx / BASE_FRAME_MS;
        velocityPxPerMs = (previousVelocity * (1 - VELOCITY_BLEND)) + (impulsePxPerMs * VELOCITY_BLEND);

        if (Math.abs(velocityPxPerMs) < MIN_VELOCITY_PX_PER_MS) return;
        startMomentum();
    };

    const onReducedMotionChanged = () => {
        if (prefersReducedMotion(reducedMotionMedia)) {
            stopMomentum();
        }
    };

    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('pointerdown', onUserInteraction, { passive: true });
    container.addEventListener('touchstart', onUserInteraction, { passive: true });

    if (reducedMotionMedia) {
        if (typeof reducedMotionMedia.addEventListener === 'function') {
            reducedMotionMedia.addEventListener('change', onReducedMotionChanged);
        } else if (typeof reducedMotionMedia.addListener === 'function') {
            reducedMotionMedia.addListener(onReducedMotionChanged);
        }
    }

    return () => {
        stopMomentum();

        container.removeEventListener('wheel', onWheel);
        container.removeEventListener('pointerdown', onUserInteraction);
        container.removeEventListener('touchstart', onUserInteraction);

        if (reducedMotionMedia) {
            if (typeof reducedMotionMedia.removeEventListener === 'function') {
                reducedMotionMedia.removeEventListener('change', onReducedMotionChanged);
            } else if (typeof reducedMotionMedia.removeListener === 'function') {
                reducedMotionMedia.removeListener(onReducedMotionChanged);
            }
        }
    };
}
