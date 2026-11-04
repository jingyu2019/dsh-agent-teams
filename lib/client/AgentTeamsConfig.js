import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function AgentTeamsConfig({ view, form, t }) {
    const value = form?.state.value;
    const maxMembers = typeof value?.maxMembers === 'number' ? value.maxMembers : 8;
    const save = async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const parsed = Number(data.get('maxMembers'));
        if (!Number.isSafeInteger(parsed) || parsed < 1)
            return;
        const revision = form?.state.revision;
        if (revision === undefined)
            return;
        await form?.mutate([{ op: 'set', path: ['maxMembers'], value: parsed }], revision);
    };
    if (view === 'summary')
        return _jsx("span", { children: t('config.summary', { count: maxMembers }) });
    if (!form || form.state.status !== 'ready')
        return _jsx("p", { children: t('config.unavailable') });
    return _jsxs("form", { onSubmit: save, children: [_jsxs("label", { children: [t('config.maxMembers'), _jsx("input", { name: "maxMembers", type: "number", min: 1, step: 1, defaultValue: maxMembers, disabled: !form.state.writable })] }), _jsx("p", { children: t('config.maxMembersHint') }), _jsx("button", { type: "submit", disabled: !form.state.writable || form.state.revision === undefined, children: t('config.save') })] });
}
