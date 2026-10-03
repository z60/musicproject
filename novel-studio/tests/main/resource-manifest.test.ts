/**
 * 测试 · 随包资源清单（`resources/models/models.json`）的解析与消费
 * ============================================================================
 * 设计依据：docs/02 §5.1 / §5.2、docs/03 §2、docs/21 §16；缺陷记录 docs/91 §5.2.51 ④
 *
 * ### 这份测试要钉住什么（每一条都对应一个真实出现过的「静默失效」）
 *   1. `models` 段是**按类型分组的对象**（whisper / embedding），不是数组 ——
 *      旧实现只认数组，于是模型清单恒为空、设置页永远「没有模型」；
 *   2. 仓库里**真实的那份清单**必须能解析出登记项（用真文件跑，不用手写 fixture：
 *      上一版解析器的 fixture 就是照着错误假设手写的，测过了也照样坏）；
 *   3. `binaries[]` 必须**真的被消费**：候选路径由它派生，`requiredFilters` 由它提供；
 *   4. 清单缺失/损坏时**不抛异常**（lite 构建里没有这个文件，应用照样要启动）。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'

import { resolveFfmpegCandidates } from '../../src/main/capabilities.ts'
import {
  binaryCandidates,
  buildModelStatuses,
  findBinary,
  parseResourceManifest,
  readResourceManifest,
  resolveManifestPath,
} from '../../src/main/resource-manifest.ts'
import { REQUIRED_FILTERS } from '../../src/shared/ffmpeg/parse.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

/** 仓库里真实的那份清单（`resources/models/models.json`） */
const REAL_RESOURCE_DIR = join(ROOT, 'resources')

/** 临时目录工厂（与 bootstrap-wiring.test.ts 同一做法） */
async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ns-manifest-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 形态兼容
// ---------------------------------------------------------------------------

describe('清单解析：models 段的两种真实形态', () => {
  it('分组对象（当前文件的形态）→ 逐组展开，kind 跟随组名', () => {
    const m = parseResourceManifest({
      version: 1,
      models: {
        whisper: [
          { id: 'whisper-base', kind: 'whisper', file: 'whisper/ggml-base.bin', sizeBytes: 142_000_000, sha256: null },
        ],
        embedding: [
          {
            id: 'bge-small-zh-v1.5',
            kind: 'embedding',
            file: 'embedding/bge-small-zh-v1.5/model.onnx',
            sizeBytes: null,
            sha256: 'abc',
          },
        ],
      },
    })
    assert.equal(m.models.length, 2)
    assert.deepEqual(
      m.models.map((x) => [x.id, x.kind, x.file]),
      [
        ['whisper-base', 'whisper', 'whisper/ggml-base.bin'],
        ['bge-small-zh-v1.5', 'embedding', 'embedding/bge-small-zh-v1.5/model.onnx'],
      ],
    )
    assert.equal(m.models[0]?.sizeBytes, 142_000_000)
    assert.equal(m.models[1]?.sha256, 'abc')
  })

  it('扁平数组 → 用条目自己的 kind', () => {
    const m = parseResourceManifest({
      models: [
        { id: 'a', kind: 'embedding', file: 'x/a.onnx' },
        { id: 'b', kind: 'whisper', file: 'y/b.bin' },
      ],
    })
    assert.deepEqual(m.models.map((x) => x.kind), ['embedding', 'whisper'])
  })

  it('顶层就是数组 → 也认（历史形态）', () => {
    const m = parseResourceManifest([{ id: 'a', kind: 'whisper', file: 'a.bin' }])
    assert.equal(m.models.length, 1)
  })

  it('缺 id / file 的条目被丢弃，而不是变成一条空模型', () => {
    const m = parseResourceManifest({
      models: { whisper: [{ id: 'no-file' }, { file: 'no-id.bin' }, { id: 'ok', file: 'ok.bin' }] },
    })
    assert.deepEqual(m.models.map((x) => x.id), ['ok'])
  })

  it('垃圾输入 / 缺段 → 空清单，不抛异常', () => {
    for (const bad of [null, undefined, 42, 'nope', {}, { models: 7 }, { models: { whisper: 'x' } }]) {
      const m = parseResourceManifest(bad)
      assert.deepEqual(m.models, [])
      assert.deepEqual(m.binaries, [])
    }
  })
})

// ---------------------------------------------------------------------------
// 真实文件（回归：解析器 fixture 不能是「自己想象的格式」）
// ---------------------------------------------------------------------------

describe('清单解析：仓库自带的真实文件', () => {
  it('resources/models/models.json 能解析出登记的模型与 ffmpeg 二进制', async () => {
    const read = await readResourceManifest(REAL_RESOURCE_DIR)
    assert.equal(read.ok, true, `读取失败：${read.error}`)
    // 旧实现（只认数组）在这里会得到 0 条 —— 这条断言就是那个缺陷的回归
    assert.ok(read.manifest.models.length >= 3, `期望至少 3 条模型登记，实际 ${read.manifest.models.length}`)
    const ids = read.manifest.models.map((m) => m.id)
    assert.ok(ids.includes('whisper-base'), `缺少 whisper-base：${ids.join(', ')}`)
    assert.ok(ids.includes('bge-small-zh-v1.5'), `缺少 embedding 模型：${ids.join(', ')}`)

    const ffmpeg = findBinary(read.manifest, 'ffmpeg')
    assert.ok(ffmpeg, 'binaries 段必须登记 ffmpeg')
    assert.equal(ffmpeg?.file, 'bin/ffmpeg{ext}')
    assert.ok(
      (ffmpeg?.requiredFilters.length ?? 0) >= REQUIRED_FILTERS.length,
      '清单登记的必需滤镜不应少于代码内置的那一组',
    )
  })

  it('清单缺失 / 不是 JSON → ok:false 且空清单（lite 构建必须能启动）', async () => {
    await withTempDirAsync(async (dir) => {
      const missing = await readResourceManifest(dir)
      assert.equal(missing.ok, false)
      assert.equal(missing.error, 'manifest-missing')
      assert.deepEqual(missing.manifest.models, [])

      mkdirSync(join(dir, 'models'), { recursive: true })
      writeFileSync(join(dir, 'models', 'models.json'), '{ 这不是 JSON', 'utf8')
      const broken = await readResourceManifest(dir)
      assert.equal(broken.ok, false)
      assert.equal(broken.error, 'manifest-invalid-json')
    })
  })
})

// ---------------------------------------------------------------------------
// 路径模板与候选顺序
// ---------------------------------------------------------------------------

describe('binaries 段：路径模板', () => {
  it('{ext} 按平台展开', () => {
    assert.equal(
      resolveManifestPath('bin/ffmpeg{ext}', { resourceDir: 'C:\\app\\resources', platform: 'win32' }),
      join('C:\\app\\resources', 'bin', 'ffmpeg.exe'),
    )
    assert.equal(
      resolveManifestPath('bin/ffmpeg{ext}', { resourceDir: '/app/resources', platform: 'linux' }),
      join('/app/resources', 'bin', 'ffmpeg'),
    )
  })

  it('旧文档的 {platform}/{arch} 模板仍然能解析（将来真要分层只需改清单）', () => {
    assert.equal(
      resolveManifestPath('bin/{platform}/{arch}/ffmpeg{ext}', {
        resourceDir: '/res',
        platform: 'win32',
        arch: 'x64',
      }),
      join('/res', 'bin', 'win32', 'x64', 'ffmpeg.exe'),
    )
  })

  it('没有登记该 id → 没有候选（调用方退回代码兜底）', () => {
    const empty = parseResourceManifest({ binaries: [] })
    assert.deepEqual(binaryCandidates(empty, 'ffmpeg', { resourceDir: '/res', platform: 'linux' }), [])
    const registered = parseResourceManifest({ binaries: [{ id: 'ffmpeg', file: 'bin/ffmpeg{ext}' }] })
    assert.equal(
      binaryCandidates(registered, 'FFMPEG', { resourceDir: '/res', platform: 'linux' }).length,
      1,
      'id 匹配应当大小写不敏感',
    )
  })
})

describe('ffmpeg 候选顺序：用户指定 > 随包（清单）> 代码兜底 > PATH', () => {
  it('四条按序出现，且清单项与兜底项同路径时只留一条', () => {
    const manifest = parseResourceManifest({ binaries: [{ id: 'ffmpeg', file: 'bin/ffmpeg{ext}' }] })
    const c = resolveFfmpegCandidates({
      resourceDir: '/res',
      settingsFfmpegPath: '/opt/ffmpeg/bin/ffmpeg',
      manifest,
      platform: 'linux',
    })
    assert.equal(c[0], '/opt/ffmpeg/bin/ffmpeg')
    assert.equal(c[1], join('/res', 'bin', 'ffmpeg'))
    // 兜底项与清单项是同一条路径 → 去重后不会重复出现（否则白跑两遍探测超时）
    assert.equal(c.filter((p) => p === join('/res', 'bin', 'ffmpeg')).length, 1)
    assert.equal(c[c.length - 1], 'ffmpeg')
  })

  it('清单缺失时只剩「代码兜底 + PATH」——探测不能因为清单没了就失效', () => {
    const c = resolveFfmpegCandidates({ resourceDir: 'C:\\app\\resources', platform: 'win32' })
    // PATH 兜底那一条也带平台后缀（`ffmpegCandidates` 的既有语义：Windows 上是 ffmpeg.exe）
    assert.deepEqual(c, [join('C:\\app\\resources', 'bin', 'ffmpeg.exe'), 'ffmpeg.exe'])
  })
})

// ---------------------------------------------------------------------------
// 模型就位校验
// ---------------------------------------------------------------------------

describe('模型就位校验（存在 + 体积；不算 SHA-256）', () => {
  it('存在且体积符合 → ok；体积不符 / 缺失 → 各自给出可读原因', async () => {
    await withTempDirAsync(async (dir) => {
      mkdirSync(join(dir, 'whisper'), { recursive: true })
      writeFileSync(join(dir, 'whisper', 'ggml-base.bin'), Buffer.alloc(16))

      const statuses = await buildModelStatuses(
        [
          { id: 'ok', kind: 'whisper', file: 'whisper/ggml-base.bin', sizeBytes: 16, sha256: null },
          { id: 'wrong-size', kind: 'whisper', file: 'whisper/ggml-base.bin', sizeBytes: 99, sha256: null },
          { id: 'missing', kind: 'embedding', file: 'embedding/nope.onnx', sizeBytes: null, sha256: null },
        ],
        dir,
      )

      assert.equal(statuses[0]?.ok, true)
      assert.equal(statuses[0]?.exists, true)
      assert.equal(statuses[0]?.message, null)
      assert.equal(statuses[0]?.actualSha256, null, '启动期不算 SHA-256（那是用户显式动作）')

      assert.equal(statuses[1]?.ok, false)
      assert.match(String(statuses[1]?.message), /体积|大小/)

      assert.equal(statuses[2]?.ok, false)
      assert.equal(statuses[2]?.exists, false)
      assert.match(String(statuses[2]?.message), /不存在/)
    })
  })

  it('未登记体积（sizeBytes=null）时不做体积校验 —— 登记表还没填实也要能用', async () => {
    await withTempDirAsync(async (dir) => {
      writeFileSync(join(dir, 'm.bin'), Buffer.alloc(3))
      const [s] = await buildModelStatuses(
        [{ id: 'm', kind: 'whisper', file: 'm.bin', sizeBytes: null, sha256: null }],
        dir,
      )
      assert.equal(s?.ok, true)
    })
  })
})
