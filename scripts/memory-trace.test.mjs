import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMemoryTraceArgs, sampleProcessRss, traceProcess } from './memory-trace.mjs'

test('memory trace argument parser is bounded and explicit', () => {
  assert.deepEqual(parseMemoryTraceArgs(['--pid', '42', '--samples', '3', '--interval-ms', '5']), {
    pid: 42, samples: 3, intervalMs: 5, out: undefined, maxRssMb: undefined,
  })
  assert.throws(() => parseMemoryTraceArgs([]), /--pid is required/)
  assert.throws(() => parseMemoryTraceArgs(['--pid', '0']), /positive integer/)
  assert.throws(() => parseMemoryTraceArgs(['--pid', '42', '--samples', '0']), /positive integer/)
  assert.throws(() => parseMemoryTraceArgs(['--pid', '42', '--interval-ms', '-1']), /non-negative integer/)
  assert.throws(() => parseMemoryTraceArgs(['--wat', '1']), /unknown argument/)
})

test('memory trace samples a live process without reading application data', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
  try {
    const first = await sampleProcessRss(child.pid)
    assert.equal(first.pid, child.pid)
    assert.ok(first.rssBytes > 0)
    assert.ok(first.elapsed.length > 0)
    const emitted = []
    const result = await traceProcess({ pid: child.pid, samples: 3, intervalMs: 5 }, sample => emitted.push(sample))
    assert.equal(emitted.length, 3)
    assert.equal(result.samples, 3)
    assert.ok(result.peakRssBytes >= emitted[0].rssBytes)
  } finally {
    child.kill('SIGTERM')
  }
})

test('memory trace rejects an RSS limit without adding data readers', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
  try {
    const first = await sampleProcessRss(child.pid)
    await assert.rejects(
      traceProcess({
        pid: child.pid,
        samples: 1,
        intervalMs: 0,
        maxRssMb: first.rssBytes / (1024 * 1024) - 0.01,
      }, () => {}),
      /exceeds --max-rss-mb/,
    )
  } finally {
    child.kill('SIGTERM')
  }
})
