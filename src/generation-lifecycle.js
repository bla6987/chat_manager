/**
 * Follow the host's foreground generation state without relying on ENDED alone.
 * Generate can return before showing its stop button (and therefore emit no
 * ENDED). The host publishes its actual UI lifecycle on body[data-generating].
 */
export function initEmbeddingGenerationLifecycle({ eventSource, eventTypes, setActive, getContext, body = document.body }) {
    let reconcileTimer = null;
    const hostIsGenerating = () => {
        const processor = getContext?.()?.streamingProcessor;
        return body?.dataset?.generating === 'true'
            || Boolean(processor && !processor.isFinished && !processor.isStopped);
    };
    const reconcile = () => {
        if (reconcileTimer !== null) clearTimeout(reconcileTimer);
        reconcileTimer = null;
        setActive(hostIsGenerating());
    };
    const cancelReconcile = () => {
        if (reconcileTimer !== null) clearTimeout(reconcileTimer);
        reconcileTimer = null;
    };
    const afterCommands = (_type, _options, dryRun = false) => {
        if (dryRun) return;
        cancelReconcile();
        // Protect immediate prompt preparation, then release pre-request exits.
        // A later host transition to generating suspends work again via observer.
        setActive(true);
        reconcileTimer = setTimeout(reconcile, 250);
    };
    const release = () => {
        cancelReconcile();
        setActive(false);
    };
    const startedEvent = eventTypes.GENERATION_AFTER_COMMANDS || eventTypes.GENERATION_STARTED;
    if (startedEvent) eventSource.on(startedEvent, afterCommands);
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], release);
    }
    const observer = new MutationObserver(reconcile);
    if (body) observer.observe(body, { attributes: true, attributeFilter: ['data-generating'] });
    reconcile();
    return () => {
        cancelReconcile();
        observer.disconnect();
        if (startedEvent) eventSource.removeListener?.(startedEvent, afterCommands);
        for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) {
            if (eventTypes[name]) eventSource.removeListener?.(eventTypes[name], release);
        }
        setActive(false);
    };
}
