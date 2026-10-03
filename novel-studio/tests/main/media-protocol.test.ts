/**
 * Novel Studio · `ns-media://` 协议的 Range 支持（真机反馈：「CV 音导入后无法播放」）
 * ============================================================================
 * 两层都要测：
 *   1. `parseByteRange` 的纯逻辑（含多区间/越界/后缀区间这些边界）；
 *   2. 真正注册进去的 handler 返回什么 —— 200/206/416 与 `Content-Range`。
 *
 * 为什么值这个测试：`<audio>` 播放**必须能 seek**。导入的整段 WAV 有上百 MB，
 * 服务端不支持 Range 时浏览器定位不到中间位置，表现就是「放不出来」。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import {
  MEDIA_SCHEME,
  parseByteRange,
  registerMediaProtocol,
} from '../../src/main/bootstrap/window-manager.ts'
import { resolveProjectPath } from '../../src/main/infra/fs/paths.ts'
import type { ElectronLike } from '../../src/main/infra/electron/types.ts'

type Handler = (request: { url: string; headers?: { get(name: string): string | null } }) => Promise<Response>

const PROJECT_ID = 'default'
const REL_PATH = 'imports/clip.wav'
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))

let root = ''
let handler: Handler | null = null

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-media-'))
  // 目录要先建出来（resolveProjectPath 只做字符串校验 + 逃逸断言，不建目录）
  mkdirSync(join(root, PROJECT_ID, 'imports'), { recursive: true })
  writeFileSync(join(root, PROJECT_ID, REL_PATH), BYTES)
})

after(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 假 electron：只捕获注册进来的 handler */
function fakeElectron(): ElectronLike {
  return {
    protocol: {
      handle: (scheme: string, h: unknown) => {
        assert.equal(scheme, MEDIA_SCHEME)
        handler = h as Handler
      },
      registerSchemesAsPrivileged: () => undefined,
    },
  } as unknown as ElectronLike
}

async function request(
  range: string | null,
  relPath: string = REL_PATH,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  assert.ok(handler, 'handler 必须先注册')
  const response = await handler({
    url: `${MEDIA_SCHEME}://${PROJECT_ID}/${relPath}`,
    headers: { get: (name: string) => (name.toLowerCase() === 'range' ? range : null) },
  })
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  }
}

describe('parseByteRange', () => {
  it('没有 Range → null（整段 200）', () => {
    assert.equal(parseByteRange(null, 100), null)
    assert.equal(parseByteRange('', 100), null)
    assert.equal(parseByteRange(undefined, 100), null)
  })

  it('闭区间 / 开区间 / 后缀区间', () => {
    assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 })
    assert.deepEqual(parseByteRange('bytes=500-', 1000), { start: 500, end: 999 })
    assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 })
    assert.deepEqual(parseByteRange('bytes=0-9999', 1000), { start: 0, end: 999 }, 'end 越界要钳到文件末尾')
  })

  it('不可满足 / 不支持的形式 → invalid（回 416，让客户端退回整段请求）', () => {
    for (const header of ['bytes=1000-', 'bytes=5-1', 'bytes=-0', 'items=0-1', 'bytes=0-1,3-4', 'bytes=-', 'bytes=']) {
      assert.equal(parseByteRange(header, 1000), 'invalid', header)
    }
  })
})

describe('ns-media handler', () => {
  it('注册即可用：整段请求返回 200 + content-length + accept-ranges', async () => {
    registerMediaProtocol({
      electron: fakeElectron(),
      projectRoot: root,
      resolve: (projectId, relPath) => resolveProjectPath(projectId, relPath, root),
    })
    const full = await request(null)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    assert.equal(full.headers.get('content-length'), String(BYTES.length))
    assert.equal(full.headers.get('content-type'), 'audio/wav')
    assert.equal(full.body.length, BYTES.length)
    assert.ok(full.body.equals(BYTES))
  })

  it('Range 请求返回 206 + content-range，且只回请求的那一段', async () => {
    const part = await request('bytes=100-199')
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), `bytes 100-199/${BYTES.length}`)
    assert.equal(part.headers.get('content-length'), '100')
    assert.ok(part.body.equals(BYTES.subarray(100, 200)))
  })

  it('不可满足的 Range 返回 416 + content-range: bytes */size', async () => {
    const bad = await request('bytes=99999-')
    assert.equal(bad.status, 416)
    assert.equal(bad.headers.get('content-range'), `bytes */${BYTES.length}`)
  })

  it('项目外的相对路径不会成功返回（逃逸校验仍然生效）', async () => {
    // URL 解析会把 `..` 归一化掉，但无论走到哪一步都不能是「200 + 项目外的文件」：
    // resolveProjectPath 命中逃逸会抛 PATH_ESCAPE_BLOCKED，落在项目内则 stat 报 ENOENT。
    await assert.rejects(() => request(null, '../secret.wav'))
    await assert.rejects(() => request(null, 'sub/../../secret.wav'))
  })
})
