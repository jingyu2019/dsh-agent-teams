/** Read-only release visibility. Registry discovery never grants compatibility. */
import { pathToFileURL } from 'node:url'
import { policy, requiredHostPeers, validatePolicy } from './compatibility.mjs'

const exactVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(value) && value.trim() === value

export function inspectUpgradeStatus({ hostTags, pluginManifest }, support = policy) {
  const supported = validatePolicy(support)
  if (!hostTags || !exactVersion(hostTags.latest)
      || !exactVersion(hostTags.next)) throw new Error('Registry must return exact latest/next host identities')
  if (pluginManifest?.name !== '@nanmicoder/dsh-agent-teams' || !exactVersion(pluginManifest.version)) throw new Error('Registry plugin identity mismatch')
  const channels = Object.fromEntries(['latest', 'next'].filter(tag => hostTags[tag]).map(tag => [tag, hostTags[tag]]))
  const unverifiedChannels = Object.entries(channels).filter(([, version]) => !supported.includes(version)).map(([channel, version]) => ({ channel, version }))
  // This project publishes exact enumerations. An unfamiliar/wide declaration
  // requires review; do not guess semver support or execute downloaded code.
  const fields = Object.hasOwn(pluginManifest.engines ?? {}, 'dsh')
    ? { 'engines.dsh': pluginManifest.engines.dsh }
    : Object.fromEntries([
      ...requiredHostPeers.filter(name => name.startsWith('@deepseek-ai/dsh-')),
      ...Object.keys(pluginManifest.peerDependencies ?? {}).filter(name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')),
    ].map(name => [name, pluginManifest.peerDependencies?.[name]]))
  const ranges = Object.entries(fields).map(([name, value]) => ({ name, versions: typeof value === 'string' ? value.split('||').map(v => v.trim()) : [] }))
  const unrecognizedDeclarations = ranges.filter(({ versions }) => !versions.length || !versions.every(exactVersion) || new Set(versions).size !== versions.length).map(({ name }) => name)
  const unpublishedSupport = unrecognizedDeclarations.length ? null : supported.filter(version => !ranges.every(range => range.versions.includes(version)))
  return {
    needsAttention: unverifiedChannels.length > 0 || unrecognizedDeclarations.length > 0 || unpublishedSupport?.length > 0,
    hostChannels: channels,
    pluginChannel: 'latest', pluginVersion: pluginManifest.version,
    unverifiedChannels, unpublishedSupport, unrecognizedDeclarations,
    limits: ['Compares declarations only; does not prove runtime compatibility or publish anything.', 'Checks host latest/next and plugin latest; other tags and untagged releases require an explicit audit.'],
  }
}

export async function fetchUpgradeStatus(fetcher = fetch, support = policy) {
  async function read(path) {
    const response = await fetcher(`https://registry.npmjs.org/${path}`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Registry request failed: ${path}: HTTP ${response.status}`)
    return response.json()
  }
  const [hostTags, pluginManifest] = await Promise.all([
    read('-/package/@deepseek-ai%2Fdsh/dist-tags'),
    read('@nanmicoder%2Fdsh-agent-teams/latest'),
  ])
  return inspectUpgradeStatus({ hostTags, pluginManifest }, support)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/upgrade-status.mjs')
  const result = await fetchUpgradeStatus()
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2))
  process.exitCode = result.needsAttention ? 1 : 0
}
