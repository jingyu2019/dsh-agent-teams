import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

type Props = PluginConfigViewProps & PropsLocale<'agentTeams'>

export function AgentTeamsConfig({ view, form, t }: Props) {
  const value = form?.state.value
  const maxMembers = typeof value?.maxMembers === 'number' ? value.maxMembers : 8
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const parsed = Number(data.get('maxMembers'))
    if (!Number.isSafeInteger(parsed) || parsed < 1) return
    const revision = form?.state.revision
    if (revision === undefined) return
    await form?.mutate([{ op: 'set', path: ['maxMembers'], value: parsed }], revision)
  }
  if (view === 'summary') return <span>{t('config.summary', { count: maxMembers })}</span>
  if (!form || form.state.status !== 'ready') return <p>{t('config.unavailable')}</p>
  return <form onSubmit={save}>
    <label>
      {t('config.maxMembers')}
      <input name="maxMembers" type="number" min={1} step={1} defaultValue={maxMembers} disabled={!form.state.writable} />
    </label>
    <p>{t('config.maxMembersHint')}</p>
    <button type="submit" disabled={!form.state.writable || form.state.revision === undefined}>{t('config.save')}</button>
  </form>
}

