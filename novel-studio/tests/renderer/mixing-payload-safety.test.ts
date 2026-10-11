/**
 * 混音/导出 · IPC 载荷安全与元数据空值（防回归，源码级）
 * ============================================================================
 * 两条真机事故（都在同一次会话里，日志 2026-10-04.log）：
 *
 * 1. ipc.mix:save.transportFailed → 「Error: An object could not be cloned.」
 *    根因：{ ...current, isDefault: true } 只是**浅**拷贝，tracks[].music 这些嵌套对象
 *    仍然是 Vue 的 Proxy —— 结构化克隆不能序列化 Proxy。
 *    （docs/91 §5.2.5 是同一个坑，导入路径当时已按 cloneForIpc 修好，这条路径漏了。）
 *
 * 2. export:preCheck.invalidPayload：「载荷校验失败：params.metadata.artist 不能为空字符串（共 2 处）」
 *    —— artist: ''（书籍没有作者）与 coverPath: null（清除封面）被 schema 拒收，
 *    于是导出向导【元数据与封面】点「下一步」直接报错。
 *
 * store 依赖 @/ 别名，测试环境（node --experimental-strip-types）解析不了，
 * 所以这里做**源码级**断言，与 audio-import-ipc-safety.test.ts 同一套做法。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 剥掉块注释与行注释（注释里会引用「错误写法」本身，必须先剥再断言） */
function strip(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

describe('混音 · mix:save 载荷必须可结构化克隆', () => {
  it('mix.store 的重命名路径经过 cloneForIpc', () => {
    const src = strip(readFileSync(join(ROOT, 'src/renderer/src/features/mixing/stores/mix.store.ts'), 'utf8'))
    assert.match(src, /cloneForIpc\(/, '没有 cloneForIpc：浅拷贝留下的 Proxy 会让 IPC 抛 DataCloneError')
    assert.match(
      src,
      /'mix:save',\s*\{[^}]*mixProject:\s*cloneForIpc\(/,
      'mix:save 的 mixProject 必须先 cloneForIpc',
    )
  })

  it('MixProjectSelector 的「设为默认」两处 payload 都 cloneForIpc（深拷贝）', () => {
    const src = strip(
      readFileSync(join(ROOT, 'src/renderer/src/features/mixing/components/MixProjectSelector.vue'), 'utf8'),
    )
    const calls = src.match(/'mix:save',\s*\{[^}]*\}/g) ?? []
    assert.equal(calls.length, 2, '这个组件里有 2 处 mix:save（当前方案 / 其它方案）')
    for (const call of calls) {
      assert.match(call, /mixProject:\s*cloneForIpc\(/, 'payload 未 clone：' + call.slice(0, 60))
    }
  })
})

describe('导出元数据 · 空值不能变成非法载荷', () => {
  const src = strip(readFileSync(join(ROOT, 'src/renderer/src/features/mixing/stores/export.store.ts'), 'utf8'))

  it('patchMetadata 把文本空串归一到「未设置」，封面 null 保留', () => {
    const fn = src.slice(src.indexOf('function patchMetadata'), src.indexOf('拉取 MP3 的 VBR 质量档'))
    assert.ok(fn.length > 0, '找到 patchMetadata')
    assert.match(fn, /delete next\[key\]/, '空串要删键，而不是留在状态里（真机：artist 空串被 schema 拒收）')
    assert.match(fn, /key !== 'coverPath'/, 'coverPath 的 null 是有意义的（明确不要封面），不该被删')
  })

  it('initFromSettings 不再给 artist/album/narrator 写空串', () => {
    const from = src.indexOf('function initFromSettings')
    const seg = src.slice(from, src.indexOf('overwrite:', from))
    assert.ok(seg.length > 0, '找到 initFromSettings 的 metadata 段')
    assert.doesNotMatch(seg, /author \?\? ''/, '★ 空作者写空串就是真机报错的来源')
    assert.match(seg, /nonEmptyText\(book\?\.author\)/, '改用 nonEmptyText：空值直接不写键')
  })
})
