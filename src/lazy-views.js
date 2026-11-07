/**
 * The chart views are most of this extension's code and most sessions never open
 * one. Each loads on first use. Until then it cannot be mounted, so asking whether
 * it is mounted, updating it or tearing it down has nothing to do.
 */

function lazyView(importModule, label) {
    let module = null;
    let loading = null;
    let mountRequest = 0;
    let pendingSetup = new Map();

    const load = () => {
        loading ??= importModule().then(loaded => {
            module = loaded;
            for (const [name, args] of pendingSetup) loaded[name](...args);
            pendingSetup = new Map();
            return loaded;
        }).catch(error => {
            loading = null; // A later attempt can retry after a network failure.
            console.error(`[chat_manager] Could not load the ${label} view:`, error);
            globalThis.toastr?.error?.(`Could not load the ${label} view.`);
            throw error;
        });
        return loading;
    };

    return {
        /** Answer from the loaded view, or with what an unloaded view would say. */
        query: (name, unloaded) => (...args) => (module ? module[name](...args) : unloaded),
        /** Do nothing unless the view has loaded. */
        ifLoaded: name => (...args) => (module ? module[name](...args) : undefined),
        /** Remember the latest settings until the view loads. */
        setup: name => (...args) => {
            if (module) return module[name](...args);
            pendingSetup.set(name, args);
            return undefined;
        },
        /** Mount once loaded, unless a newer mount or a teardown came first. */
        mount: name => (...args) => {
            const request = ++mountRequest;
            if (module) return module[name](...args);
            return load().then(loaded => (request === mountRequest ? loaded[name](...args) : undefined)).catch(() => {});
        },
        /** Teardown also cancels a mount that is still loading. */
        unmount: name => (...args) => {
            mountRequest++;
            return module ? module[name](...args) : undefined;
        },
        /** Load if needed, then act. */
        act: name => (...args) => (module ? module[name](...args) : load().then(loaded => loaded[name](...args)).catch(() => {})),
    };
}

const icicle = lazyView(() => import('./icicle-view.js'), 'graph');
export const mountIcicle = icicle.mount('mountIcicle');
export const unmountIcicle = icicle.unmount('unmountIcicle');
export const updateIcicleData = icicle.ifLoaded('updateIcicleData');
export const focusMessageInIcicle = icicle.act('focusMessageInIcicle');
export const isIcicleMounted = icicle.query('isIcicleMounted', false);
export const setIcicleCallbacks = icicle.setup('setIcicleCallbacks');
export const invalidateIcicleEmbeddings = icicle.ifLoaded('invalidateIcicleEmbeddings');
export const setThreadFocus = icicle.setup('setThreadFocus');

const semanticMap = lazyView(() => import('./semantic-map-view.js'), 'semantic map');
export const mountSemanticMap = semanticMap.mount('mountSemanticMap');
export const unmountSemanticMap = semanticMap.unmount('unmountSemanticMap');
export const updateSemanticMapData = semanticMap.ifLoaded('updateSemanticMapData');
export const focusMessageInSemanticMap = semanticMap.act('focusMessageInSemanticMap');
export const isSemanticMapMounted = semanticMap.query('isSemanticMapMounted', false);
export const setSemanticMapCallbacks = semanticMap.setup('setSemanticMapCallbacks');
export const invalidateSemanticMapEmbeddings = semanticMap.ifLoaded('invalidateSemanticMapEmbeddings');

const graph = lazyView(() => import('./graph-view.js'), 'graph');
export const mountGraphView = graph.mount('mountGraphView');
export const unmountGraphView = graph.unmount('unmountGraphView');
export const updateGraphViewData = graph.ifLoaded('updateGraphViewData');
export const isGraphViewMounted = graph.query('isGraphViewMounted', false);
export const setGraphViewCallbacks = graph.setup('setGraphViewCallbacks');
export const setGraphScope = graph.setup('setGraphScope');
export const invalidateGraphEmbeddings = graph.ifLoaded('invalidateGraphEmbeddings');

const stats = lazyView(() => import('./stats-view.js'), 'stats');
export const mountStatsView = stats.mount('mountStatsView');
export const unmountStatsView = stats.unmount('unmountStatsView');
export const updateStatsView = stats.ifLoaded('updateStatsView');
export const isStatsMounted = stats.query('isStatsMounted', false);
export const setStatsCallbacks = stats.setup('setStatsCallbacks');
