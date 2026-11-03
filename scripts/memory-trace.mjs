#!/usr/bin/env node
/**
 * Credential-free OS-level memory sampler for AgentTeams/Harness OOM reports.
 *
 * This intentionally reads only process metadata: PID, RSS, elapsed time and
 * liveness. It never opens session files, prompts, messages or credentials.
 */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const run = promisify(execFile)

export function parseMemoryTraceArgs(argv) {
  const options = { pid: undefined, samples: 60, intervalMs: 1000, out: undefined, maxRssMb: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (!['--pid', '--samples', '--interval-ms', '--out', '--max-rss-mb'].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`)
    }
    const raw = argv[++index]
    if (raw === undefined) throw new Error(`missing value for ${arg}`)
    if (arg === '--pid') {
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('--pid must be a positive integer')
      options.pid = Number(raw)
    } else if (arg === '--samples') {
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('--samples must be a positive integer')
      options.samples = Number(raw)
    } else if (arg === '--interval-ms') {
      if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error('--interval-ms must be a non-negative integer')
      options.intervalMs = Number(raw)
    } else if (arg === '--max-rss-mb') {
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('--max-rss-mb must be a positive integer')
      options.maxRssMb = Number(raw)
    } else options.out = raw
  }
  if (options.pid === undefined) throw new Error('--pid is required')
  if (options.samples > 100000) throw new Error('--samples is too large')
  if (options.intervalMs > 86_400_000) throw new Error('--interval-ms is too large')
  return options
}

export async function sampleProcessRss(pid) {
  const startedAt = Date.now()
  try {
    let rssBytes, elapsed
    if (process.platform === 'win32') {
      const command = `$p = Get-Process -Id ${pid} -ErrorAction Stop; Write-Output $p.WorkingSet64; Write-Output ([DateTime]::Now - $p.StartTime).ToString()`
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
      const [rssText, elapsedText] = stdout.trim().split(/\r?\n/u)
      rssBytes = Number(rssText)
      elapsed = elapsedText?.trim() ?? ''
    } else {
      const [{ stdout: rssText }, { stdout: elapsedText }] = await Promise.all([
        run('ps', ['-o', 'rss=', '-p', String(pid)]),
        run('ps', ['-o', 'etime=', '-p', String(pid)]),
      ])
      const rssKiB = Number(rssText.trim())
      rssBytes = rssKiB * 1024
      elapsed = elapsedText.trim()
    }
    if (!Number.isFinite(rssBytes) || rssBytes < 0) throw new Error(`invalid RSS for pid ${pid}`)
    return { at: new Date().toISOString(), pid, rssBytes, elapsed, sampleMs: Date.now() - startedAt }
  } catch (error) {
    if (error?.code !== 1) throw error
    const dead = Object.assign(new Error(`process ${pid} is not live`), { code: 'PROCESS_NOT_LIVE' })
    throw dead
  }
}

export async function traceProcess(options, emit = sample => process.stdout.write(JSON.stringify(sample) + '\n')) {
  let peakRssBytes = 0
  for (let index = 0; index < options.samples; index++) {
    const sample = await sampleProcessRss(options.pid)
    peakRssBytes = Math.max(peakRssBytes, sample.rssBytes)
    emit(sample)
    if (options.maxRssMb !== undefined && sample.rssBytes > options.maxRssMb * 1024 * 1024) {
      throw Object.assign(new Error(`RSS ${sample.rssBytes} exceeds --max-rss-mb ${options.maxRssMb}`), { code: 'RSS_LIMIT' })
    }
    if (index + 1 < options.samples && options.intervalMs > 0) {
      await new Promise(resolve => setTimeout(resolve, options.intervalMs))
    }
  }
  return { samples: options.samples, peakRssBytes }
}

export function memoryTraceHelp() {
  return `Usage: dsh-agent-teams-memory-trace --pid <pid> [options]

Samples only OS process metadata and never reads sessions, prompts or secrets.

Options:
  --pid <pid>       Running DSH/Node process id (required)
  --samples <n>     Number of samples (default: 60)
  --interval-ms <n> Delay between samples (default: 1000; 0 allowed)
  --out <file>      Write JSONL to a file instead of stdout
  --max-rss-mb <n>  Exit non-zero when RSS exceeds this limit
  -h, --help        Show this help
`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseMemoryTraceArgs(process.argv.slice(2))
    if (options.help) { process.stdout.write(memoryTraceHelp()); process.exit(0) }
    const sink = options.out === undefined ? undefined : createWriteStream(options.out, { flags: 'wx' })
    const emit = sink === undefined ? undefined : sample => sink.write(JSON.stringify(sample) + '\n')
    try {
      const result = await traceProcess(options, emit)
      if (sink !== undefined) await new Promise((resolve, reject) => { sink.end(resolve); sink.on('error', reject) })
      process.stderr.write(JSON.stringify({ ok: true, pid: options.pid, ...result }) + '\n')
    } finally {
      if (sink !== undefined && !sink.closed) sink.destroy()
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code }) + '\n')
    process.exitCode = 1
  }
}
