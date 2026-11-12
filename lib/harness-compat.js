import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import * as dshSession from '@deepseek-ai/dsh-session';
import { SubagentError } from '@deepseek-ai/dsh-subagent';
import { BUILTIN_DENY_TOOLS, resolveMemberToolFilter } from "./tool-policies.js";
/**
 * Exact protocol exported by dsh-subagent/internal in Alpha.5 and rc.1.
 * That subpath does not exist in Alpha.2, so importing it statically prevents
 * the plugin from loading there. This small adapter uses the same process-
 * stable symbol and call signature as upstream queueHostSubagentPrompt.
 * Source: packages/subagent/subagent/src/internal.ts at dsh-v0.1.2-rc.1.
 */
const hostPromptQueue = Symbol.for('dsh.subagent.queuePrompt');
// 0.1.5 keeps queueHostSubagentPrompt but replaces its symbol with this
// delivery-mode-aware implementation (packages/subagent/subagent/src/internal.ts).
const hostPromptDeliver = Symbol.for('dsh.subagent.deliverPrompt');
const agentRuns = new WeakMap();
/** Bind the exact live Agent object to its run/activation. */
export function bindAgentRun(agent, binding) {
    agentRuns.set(agent, binding);
}
/** Resolve an AgentTeams run without falling back to member name or latest task. */
export function boundAgentRun(agent) {
    return agentRuns.get(agent);
}
/** Drop process-local correlation once the exact lease is released. */
export function unbindAgentRun(agent) {
    agentRuns.delete(agent);
}
/** Record a route-owned diagnostic only through the exact live Agent binding. */
export function recordBoundAgentDiagnostic(agent, diagnostic) {
    const binding = agentRuns.get(agent);
    if (binding === undefined)
        return false;
    binding.recordDiagnostic?.(diagnostic);
    return true;
}
export function usesManagedActivations(runtime) {
    return typeof runtime.startActivation === 'function';
}
export async function startMember(runtime, spec) {
    const host = runtime;
    if (typeof host.startActivation === 'function') {
        const { persona: _persona, toolFilter: _filter, ...request } = spec.request;
        // Dual shape: rc.1 startActivation/startLocal consume `request.parent`,
        // `request.prompt`, `request.agentOptions`; rc.2 reads those at the top
        // level (its startActivation checks `spec.parent.id` and startLocalNamed
        // submits `spec.prompt`). Keeping both means one code path serves both
        // published generations, guardSubagentCreation still finds request.parent,
        // and no version probe is needed. rc.2 ignores the extra `request` key
        // (no object-key validation on the local start path).
        const activation = await host.startActivation.call(runtime, { ...spec, ...request, request, delivery: 'parent' });
        // The lifecycle pair is canonical; result/dispose remain exact fallback
        // handles for a missing end. Never discard their rejection unobserved.
        void activation.result.catch(() => undefined);
        return {
            childId: activation.childId,
            managed: true,
            ...activation.messageId === undefined ? {} : { messageId: activation.messageId },
            result: activation.result,
            ...activation.dispose === undefined ? {} : { dispose: activation.dispose },
        };
    }
    if (typeof host.startContinuable !== 'function')
        return unsupported('missing member creation API');
    const created = await host.startContinuable.call(runtime, spec);
    return { ...created, managed: false };
}
/** Wrap every available creation API, restoring only this plugin's own methods. */
export function guardSubagentCreation(ctx, check) {
    const runtime = ctx.subagents;
    ctx.effect(() => {
        const disposers = [];
        for (const key of ['start', 'startContinuable', 'startActivation']) {
            const original = runtime[key];
            if (typeof original !== 'function')
                continue;
            const descriptor = Object.getOwnPropertyDescriptor(runtime, key);
            const guarded = async (...args) => {
                const request = key === 'start' ? args[1] : args[0].request;
                check(request.parent);
                return Reflect.apply(original, ctx.subagents, args);
            };
            Object.defineProperty(runtime, key, { value: guarded, writable: true, configurable: true });
            disposers.push(() => {
                if (Object.getOwnPropertyDescriptor(runtime, key)?.value !== guarded)
                    return;
                if (descriptor === undefined)
                    Reflect.deleteProperty(runtime, key);
                else
                    Object.defineProperty(runtime, key, descriptor);
            });
        }
        return () => { for (const dispose of disposers)
            dispose(); };
    }, 'agent-teams: member delegation budget');
}
function boundary(runtime) {
    return runtime;
}
function unsupported(detail) {
    throw new Error(`agent-teams: unsupported Harness subagent contract (${detail}); use an explicitly tested Harness version and a coherent dependency installation`);
}
/**
 * 0.2.2-rc.2 retired the process-stable deliverPrompt symbol from the
 * SubagentRuntime service and routed host-authored turns through
 * manager.deliverPrompt(childId, content, { source, signal, delivery })
 * (dsh-subagent 0.2.2-rc.2 lib/index.js:1768, :3197). That replacement drops
 * the parent Agent, which the retired-member guard needs to locate the team's
 * durable state directory, and routing through runtime.prompt() would mint a
 * kind:"user" source and lose AgentTeams attribution. Re-expose the audited
 * Deliver(parent, ...) shape as a stateless, idempotent adapter on the runtime:
 * requireManager() is resolved at call time so the live manager survives HMR
 * swaps, and keeping parent lets guardSubagentDelivery wrap and restore this
 * exact method while queue, steer and setup consumers stay unchanged.
 */
export function installModernDelivery(runtime) {
    const host = boundary(runtime);
    if (typeof host[hostPromptDeliver] === 'function')
        return;
    if (typeof host.followup === 'function')
        return;
    if (typeof host[hostPromptQueue] === 'function')
        return;
    const modern = runtime;
    if (typeof modern.requireManager !== 'function')
        return;
    const compat = async (_parent, childId, content, source, signal, delivery) => {
        const manager = modern.requireManager?.();
        if (manager === undefined || typeof manager.deliverPrompt !== 'function')
            return unsupported('missing 0.2.2 host FIFO delivery');
        return manager.deliverPrompt(childId, content, { source, signal, delivery });
    };
    Object.defineProperty(host, hostPromptDeliver, { value: compat, writable: true, configurable: true });
}
/**
 * Registered subagent provider names for an actionable diagnostic. 0.2.2-rc.2
 * removed the public SubagentRuntime.list() accessor (its lib/types/index.d.ts
 * no longer declares it) but the service still owns the provider registry as a
 * live insertion-ordered Map, so read its keys as the same names. Fall back to
 * an empty list on any host whose shape is unknown rather than throwing here.
 */
export function listedProviderNames(runtime) {
    const host = runtime;
    if (typeof host.list === 'function')
        return host.list();
    if (host.providers !== undefined && typeof host.providers.keys === 'function')
        return [...host.providers.keys()];
    return [];
}
/** Package identity a released plugin-wrapper source names on older hosts. */
export const AGENT_TEAMS_PLUGIN_NAME = '@nanmicoder/dsh-agent-teams';
/**
 * First stored format generation whose migration edges admit producer-owned
 * source kinds. The released v2→v3 payload audit validates every message source
 * against a closed list of released kinds, so a stored format older than this
 * must carry a released source or the whole session becomes unreadable once a
 * newer host opens it (#160).
 */
export const RELEASED_SOURCE_VOCABULARY_VERSION = 3;
/**
 * Stored format generation observed on a live session, when the host exposes it.
 *
 * The module constant is only a fallback: a plugin can resolve a *nested*
 * `@deepseek-ai/dsh-session` copy that belongs to a different host generation
 * than the process loading it (a profile whose lockfile pins the DSH package
 * line, a Desktop shell with an embedded core, a duplicated store). That copy
 * then reports the wrong generation — 0 on a v4 host — which selects the
 * retired `plugin` wrapper and makes every durable AgentTeams message fail the
 * host's own admission check (#236). The live session header belongs to the
 * host that persists the message, so it outranks the resolved module.
 */
export function observedSessionFormatVersion(subject) {
    const version = subject?.session?.header?.version;
    return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : undefined;
}
/**
 * Stored session format generation of the running host; 0 when neither the live
 * session nor the resolved module exposes one.
 * @param observed - a live session observation; preferred over the module constant.
 */
export function hostSessionFormatVersion(observed) {
    if (typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0)
        return observed;
    const version = dshSession.SESSION_FORMAT_VERSION;
    return typeof version === 'number' && Number.isSafeInteger(version) && version >= 0 ? version : 0;
}
/**
 * Source for one AgentTeams-authored message on the running host.
 *
 * Current hosts mint producer-owned kinds: the Harness documents message
 * sources as a merge-extensible vocabulary without a catch-all, so this plugin
 * declares its own. Hosts that still store a pre-v3 generation are a different
 * contract — their released v2→v3 migration rejects any source outside the
 * released vocabulary, which is exactly how a plugin kind written on an older
 * supported host poisons its session log for every later host. On those hosts
 * the released plugin wrapper is used instead; the goal and profile already
 * travel in the message text.
 * @param modern - the producer-owned source to use where the host admits it.
 * @param observed - the live session's stored format generation, when callers
 * have the owning agent at hand. Never trust the resolved module alone: on a
 * host whose profile pins another DSH line it reports a retired generation and
 * the v4 writer rejects the wrapper (#236).
 * @returns a source accepted by the running host and by its migration chain.
 */
export function agentTeamsSource(modern, observed) {
    if (hostSessionFormatVersion(observed) >= RELEASED_SOURCE_VOCABULARY_VERSION)
        return modern;
    // Released-format hosts persist plugin-authored messages as this wrapper; the
    // current vocabulary retired it, so the cast stays confined to this branch
    // and `modern` is the only shape a current host ever sees.
    return { kind: 'plugin', plugin: AGENT_TEAMS_PLUGIN_NAME };
}
/**
 * 0.1.6 moved startup admission to serial agent/created. Older created events
 * have no source and precede session-start; ignore those until the old hook.
 * Keep the removed event's type confined to this audited compatibility seam.
 */
export function onAgentReady(ctx, listener) {
    const stopCreated = ctx.on('agent/created', payload => {
        if ('source' in payload)
            listener(payload.agent, true);
        return undefined;
    });
    const legacy = ctx;
    const stopLegacy = legacy.on('agent/session-start', ({ agent }) => listener(agent, false));
    return () => { stopCreated(); stopLegacy(); };
}
/** Read child-owned history, excluding any descriptor inherited from a parent. */
export function sessionOwnEvents(session) {
    const current = session;
    if (typeof current.ownEvents === 'function')
        return current.ownEvents.call(session);
    const legacy = session;
    if (!Array.isArray(legacy.events))
        return unsupported('missing ownEvents/legacy session log');
    return legacy.events.slice(legacy.header.seedLength ?? 0);
}
/** Legacy hosts log each chunk separately; current hosts embed the committed stream. */
export function outputLimitTurn(event) {
    const record = event;
    if (record.type === 'assistant/chunk') {
        const { chunk, turn } = record.data;
        return chunk.type === 'finish' && chunk.reason.kind === 'max-tokens' ? turn : undefined;
    }
    if (record.type === 'assistant/message' && record.data.stream?.some(item => item.type === 'chunk' && item.chunk.type === 'finish' && item.chunk.reason.kind === 'max-tokens')) {
        return record.data.turn;
    }
}
/** Install before the first request, including cold resume, with HMR cleanup. */
export function installContinuableMemberSetup(ctx, setup) {
    installModernDelivery(ctx.subagents);
    const runtime = boundary(ctx.subagents);
    if (typeof runtime.registerContinuableSetup === 'function') {
        // Upstream owns this registration with this.ctx.effect. Cordis resolves
        // that ctx to the accessing plugin, so its disposal revokes installations
        // even while the subagents service and child Agents remain live.
        runtime.registerContinuableSetup.call(ctx.subagents, (childCtx) => {
            if (childCtx.agent === undefined)
                return unsupported('legacy setup lacks child Agent');
            return setup(childCtx, childCtx.agent);
        });
        return;
    }
    if ((typeof runtime[hostPromptQueue] !== 'function' && typeof runtime[hostPromptDeliver] !== 'function') || typeof runtime.sendMessage !== 'function') {
        return unsupported('missing continuable setup and modern host queue');
    }
    const installed = new WeakSet();
    const active = new Set();
    ctx.effect(() => {
        const attach = (agent, vetoable) => {
            if (installed.has(agent))
                return;
            // Deliberately synchronous: awaiting here loses the first-request race.
            let teardown;
            try {
                teardown = setup(agent.ctx, agent);
            }
            catch (error) {
                if (vetoable)
                    throw error;
                // session-start is a notification: Harness logs a thrown listener and
                // still admits the first prompt. Reject request assembly explicitly so
                // a malformed saved route cannot silently execute on a default model.
                const failure = new Error(`agent-teams: member initialization failed: ${String(error)}`, { cause: error });
                ctx.logger.warn(failure.message);
                teardown = agent.ctx.on('agent/request', () => { throw failure; });
            }
            installed.add(agent);
            let disposed = false;
            const dispose = () => {
                if (disposed)
                    return;
                disposed = true;
                active.delete(dispose);
                installed.delete(agent);
                teardown();
            };
            active.add(dispose);
            // Listeners contributed to agent.ctx already follow its lifetime. Also
            // release our bookkeeping and remove them if this plugin is reloaded.
            try {
                agent.ctx.effect(() => dispose, 'agent-teams: child compatibility setup');
            }
            catch (error) {
                dispose();
                throw error;
            }
        };
        const stop = onAgentReady(ctx, attach);
        const cleanup = () => {
            stop();
            for (const dispose of [...active])
                dispose();
        };
        try {
            // Reloads keep Agents alive but dispose the previous plugin's setup.
            // Subscribe first, then hydrate the live registry; attach is idempotent.
            for (const agent of ctx.agents.list())
                attach(agent, false);
        }
        catch (error) {
            cleanup();
            throw error;
        }
        return cleanup;
    }, 'agent-teams: member lifecycle compatibility');
}
/** Queue a distinct host-authored turn; never substitute model-message steer. */
export async function queueMemberPrompt(runtime, parent, childId, content, signal) {
    const host = boundary(runtime);
    const source = agentTeamsSource({ kind: 'agent-teams' }, observedSessionFormatVersion(parent));
    if (typeof host.followup === 'function') {
        return host.followup.call(runtime, parent, childId, content, { source, signal });
    }
    const deliver = host[hostPromptDeliver];
    if (typeof deliver === 'function')
        return deliver.call(runtime, parent, childId, content, source, signal, 'queue');
    const queue = host[hostPromptQueue];
    if (typeof queue !== 'function')
        return unsupported('missing host FIFO delivery');
    return queue.call(runtime, parent, childId, content, source, signal);
}
/** Coordination joins the nearest step, including waking an idle/cold child. */
export async function steerMemberPrompt(runtime, parent, childId, content, signal, live) {
    const host = boundary(runtime);
    const source = agentTeamsSource({ kind: 'agent-teams' }, observedSessionFormatVersion(live ?? parent));
    const deliver = host[hostPromptDeliver];
    if (typeof deliver === 'function')
        return deliver.call(runtime, parent, childId, content, source, signal, 'steer');
    if (typeof host.sendMessage === 'function')
        return host.sendMessage.call(runtime, parent, childId, content, { signal });
    if (typeof host.followup === 'function') {
        if (live === undefined)
            return queueMemberPrompt(runtime, parent, childId, content, signal);
        if (live.id !== childId || live.session.header.parentSession !== parent.id)
            throw new Error('invalid member steering authority');
        signal.throwIfAborted();
        const message = createUserMessage({ content, source });
        live.steer(message);
        return message.id;
    }
    return unsupported('missing step-boundary message delivery');
}
/** Guard all resumable delivery paths, preserving the native service receiver. */
export function guardSubagentDelivery(ctx, isRetired) {
    const runtime = ctx.subagents;
    installModernDelivery(runtime);
    const host = boundary(runtime);
    const legacy = host.followup;
    const queue = host[hostPromptQueue];
    const deliver = host[hostPromptDeliver];
    const send = host.sendMessage;
    if (typeof legacy !== 'function' && ((typeof queue !== 'function' && typeof deliver !== 'function') || typeof send !== 'function')) {
        return unsupported('cannot install complete retired-member guard');
    }
    ctx.effect(() => {
        const descriptors = new Map([
            ['followup', Object.getOwnPropertyDescriptor(host, 'followup')],
            [hostPromptQueue, Object.getOwnPropertyDescriptor(host, hostPromptQueue)],
            [hostPromptDeliver, Object.getOwnPropertyDescriptor(host, hostPromptDeliver)],
            ['sendMessage', Object.getOwnPropertyDescriptor(host, 'sendMessage')],
        ]);
        let active = true;
        const check = async (sender, targetId) => {
            if (active && await isRetired(sender, targetId)) {
                throw new SubagentError(`AgentTeams member "${targetId}" was retired and cannot be resumed`, 'NOT_RESUMABLE');
            }
        };
        const guardedLegacy = async (parent, childId, content, options) => {
            await check(parent, childId);
            return legacy.call(runtime, parent, childId, content, options);
        };
        const guardedQueue = async (parent, childId, content, source, signal) => {
            await check(parent, childId);
            return queue.call(runtime, parent, childId, content, source, signal);
        };
        const guardedSend = async (sender, targetId, content, options) => {
            await check(sender, targetId);
            return send.call(runtime, sender, targetId, content, options);
        };
        const guardedDeliver = async (parent, childId, content, source, signal, delivery) => {
            await check(parent, childId);
            return deliver.call(runtime, parent, childId, content, source, signal, delivery);
        };
        if (typeof legacy === 'function')
            host.followup = guardedLegacy;
        if (typeof queue === 'function')
            host[hostPromptQueue] = guardedQueue;
        if (typeof deliver === 'function')
            host[hostPromptDeliver] = guardedDeliver;
        if (typeof send === 'function')
            host.sendMessage = guardedSend;
        // Cordis wraps method reads in fresh Proxies. Compare the actual own
        // descriptor to restore only our contribution, including prototype methods.
        const restore = (key, installed) => {
            if (Object.getOwnPropertyDescriptor(host, key)?.value !== installed)
                return;
            const original = descriptors.get(key);
            if (original === undefined)
                Reflect.deleteProperty(host, key);
            else
                Object.defineProperty(host, key, original);
        };
        return () => {
            active = false;
            if (typeof legacy === 'function')
                restore('followup', guardedLegacy);
            if (typeof queue === 'function')
                restore(hostPromptQueue, guardedQueue);
            if (typeof deliver === 'function')
                restore(hostPromptDeliver, guardedDeliver);
            if (typeof send === 'function')
                restore('sendMessage', guardedSend);
        };
    }, 'agent-teams: retired member guard');
}
/**
 * Names the host's `tools.restrict()` would admit for this agent's layer
 * chain, or undefined when the host does not expose its registry view.
 * restrict() rejects unknown names with a hard error, so the spawn path must
 * check entries against this view before forwarding them. Source:
 * dsh-tools view()/restrict() in 0.1.5-rc.1; older Harness generations lack
 * the surface and keep the verbatim list.
 */
export function restrictableToolNames(agent) {
    const tools = agent?.ctx?.tools;
    if (typeof tools?.view !== 'function')
        return undefined;
    try {
        const names = tools.view.call(tools, agent.ctx)?.restrictableNames;
        return names instanceof Set ? names : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Member `toolFilter` for one spawn. Captain-only names are registered by
 * this plugin itself and always resolvable; the depth-related entries name
 * HOST tools and are only known under some compositions, so they must be
 * resolved against the running host's registry: the delegation tool name is
 * host configuration (dsh-tool-subagent `toolName`, default `subagent`,
 * renamed per composition, e.g. `subagent_fork` in web-style profiles), and
 * forwarding a name the host dropped aborts every member spawn (#163, #164).
 * Depth enforcement itself does not depend on these names —
 * installMemberDelegationGuard bounds descendant creation by parent chain.
 *
 * This is the legacy filter of a member without a configured tool policy; a
 * selected policy resolves through `resolveMemberToolFilter` instead (#59).
 */
export function memberToolFilter(maxDepth, knownTools) {
    return resolveMemberToolFilter(undefined, { maxDepth, knownTools });
}
/**
 * Names a `tools.restrict()` rejection reported as unknown, or an empty list
 * for every other failure. The host names the offenders verbatim
 * (`tools.restrict() names unknown global tool "x"; known global tools: …`);
 * only that report may relax a filter (#164, #166).
 */
function unknownToolNames(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('unknown global tool'))
        return [];
    return [...message.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}
/**
 * Start one member, dropping only the built-in filter names the host reports
 * as unknown and retrying.
 *
 * Resolving the filter against the registry view ({@link memberToolFilter})
 * only covers hosts that expose one. A rejected filter still leaves the member
 * without a session for the lifetime of the team, so the start must survive the
 * cases that resolution cannot see — no registry view, a name that is known but
 * not restrictable, a composition that mounted differently than expected. The
 * host names the offenders in its rejection, so the relaxable ones are removed
 * and the start retried.
 *
 * Only `relaxableDeny` names may be dropped, and only from `deny`. The default
 * is exactly the built-in captain-only and depth entries (#163/#164); a name an
 * owner-declared tool policy contributed is never removed, because silently
 * spawning a member with a different filter than the owner declared is contract
 * drift, not recovery. Dropping a denied name the host does not register
 * changes nothing; dropping an allowed name would loosen the policy, so `allow`
 * is never relaxed and the four required coordination tools can never be
 * removed.
 * @param start - performs one start attempt for the given `toolFilter`.
 * @param filter - the filter to attempt first.
 * @param relaxableDeny - built-in deny names the retry may drop.
 * @returns the started member.
 */
export async function startMemberWithLenientFilter(start, filter, relaxableDeny = BUILTIN_DENY_TOOLS) {
    const current = {
        ...filter.allow === undefined ? {} : { allow: [...filter.allow] },
        deny: [...filter.deny],
    };
    for (;;) {
        try {
            return await start(current);
        }
        catch (error) {
            const unknown = unknownToolNames(error);
            if (unknown.length === 0)
                throw error;
            const droppable = unknown.filter(name => relaxableDeny.includes(name) && current.deny.includes(name));
            if (droppable.length === 0)
                throw error;
            current.deny = current.deny.filter(name => !droppable.includes(name));
        }
    }
}
/** Targeted teardown of the selected member activations across host generations. */
export async function drainMemberChildren(runtime, parent, ids) {
    const host = runtime;
    const drain = host.drainChildren ?? host.drainContinuableChildren;
    if (typeof drain === 'function') {
        await drain.call(runtime, parent, ids);
        return;
    }
    // 0.2.2-rc.2 retired both targeted drain methods: members now share one
    // activation tree rooted at the captain and SubagentManager exposes no public
    // per-child teardown (only drainDescendants, which stops the WHOLE tree).
    // The exact equivalent of the old drainChildren is the manager's process-local
    // resident Map plus disposeRoots: it closes admission (dispose -> close sets
    // activation.closing synchronously before any await), cancels the turn,
    // flushes final state, releases the slot and emits subagent/end, for the
    // selected activations ONLY. Sibling activations stay resident, so an
    // update_member route change never stops another member. Resolve the manager
    // lazily through the same requireManager() seam as modern delivery; a manager
    // that is not bound yet means no resident activations exist (rc.1 no-op), so
    // a CONTINUATION_UNAVAILABLE throw is best-effort cleanup, not a failure.
    const modern = runtime;
    if (typeof modern.requireManager !== 'function')
        return unsupported('missing targeted child drain');
    let manager;
    try {
        manager = modern.requireManager();
    }
    catch {
        return;
    }
    if (manager === undefined || typeof manager.resident?.get !== 'function' || typeof manager.disposeRoots !== 'function') {
        return unsupported('missing 0.2.2 targeted activation teardown');
    }
    const resident = manager.resident;
    const targets = [];
    for (const childId of new Set(ids)) {
        const activation = resident.get(childId);
        if (activation !== undefined)
            targets.push(activation);
    }
    await manager.disposeRoots(targets, 'selected activation(s)');
}
/**
 * Build the route channel for one child.
 * @param agent - the child Agent; 0.2.2+ exposes `model.select`.
 * @param ref - the selection ref older hosts read. Kept current on every host:
 *   it is the authority on rc.5 and inert metadata on 0.2.2+.
 */
export function memberSelectionChannel(agent, ref) {
    const controller = agent?.model;
    const select = typeof controller?.select === 'function' ? controller.select.bind(controller) : undefined;
    const current = typeof controller?.current === 'function' ? controller.current.bind(controller) : undefined;
    return {
        route: () => current?.() ?? ref.current,
        apply: route => {
            ref.current = route;
            ref.assembled = route;
            select?.(route);
        },
        redirectsInStepRetry: select === undefined,
    };
}
/**
 * Install the model-selection boundary for one child on either host generation.
 * @param agentCtx - the child's scoped context.
 * @param agent - the child Agent.
 * @param initial - the provider/model the child starts on.
 */
export function installMemberSelection(agentCtx, agent, initial) {
    const ref = { current: initial, assembled: undefined };
    const channel = memberSelectionChannel(agent, ref);
    const install = installModelSelection;
    // 0.2.2+ ignores a second argument, so passing it would still "work" while
    // hiding that the host owns the route now; the branch states which contract
    // we are calling instead of relying on that tolerance.
    const dispose = channel.redirectsInStepRetry ? install(agentCtx, ref) : install(agentCtx);
    // On rc.5 the ref *is* the route record, so seeding it above already tells the
    // host which route this activation starts on. On 0.2.2 the Agent's projection
    // is the record, and seeding only the ref leaves the two generations
    // disagreeing about who publishes the starting route: `ref.current` becomes
    // inert metadata while the projection keeps whatever it had. Publish it too.
    if (!channel.redirectsInStepRetry)
        channel.apply(initial);
    return { ref, channel, dispose };
}
