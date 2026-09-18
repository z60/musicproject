/**
 * 渲染进程 · 交给 IPC 前把数据拍平成「可结构化克隆」的纯数据
 * ============================================================================
 * Electron 的 `ipcRenderer.invoke` 用**结构化克隆**序列化参数，而 Vue 的
 * `reactive` / `ref` 拿到的是 **Proxy** —— Proxy 不能被结构化克隆，直接抛：
 *
 *     DataCloneError: #<Object> could not be cloned.
 *
 * 实测（Node 的 `structuredClone` 与 Electron IPC 是同一套 V8 序列化）：
 *
 *     结构化克隆  reactive({...})            → ❌ DataCloneError
 *     结构化克隆  ref([...]).value            → ❌ DataCloneError
 *     结构化克隆  reactive 数组 .filter(...)   → ❌ DataCloneError（元素本身也是 Proxy）
 *     结构化克隆  toRaw(x) / JSON 往返        → ✅
 *
 * 真机事故（docs/91 §5.2.5）：导入向导的提交载荷里带着响应式**草稿数组**，
 * 点「开始导入」就报
 * `发生了未预期的错误 / 错误编号：「-」/ 原因链：Error: An object could not be cloned.`
 * 导出路径**早就**踩过同一个坑并加了这层处理（本函数原在 export.store.ts 里），
 * 导入路径当时漏了 —— 而且因为它一直被项目上下文的死锁挡在前面（§5.2.4），
 * 从没真正调用过 IPC，所以这个缺陷一直没暴露。
 *
 * ⚠️ **只在具体的 IPC 载荷上做，不要挪进 `shared/lib/ipc.ts` 的 `call()` 里统一做。**
 * 本仓库的音频路径用 MessagePort **转移 ArrayBuffer** 做零拷贝
 * （`useRecorder.ts`「硬性约束 2」），而 JSON 往返会把 `Uint8Array` / `Float32Array`
 * 变成 `{"0":…,"1":…}` 这种对象 —— **静默毁掉音频数据，比抛错糟糕得多**。
 * 所以：知道载荷是纯业务数据的地方才调用本函数。
 *
 * 本文件**不 import 任何东西**（连 vue 都不 import）：它要能被 `tests/renderer`
 * 以 `node --experimental-strip-types` 直接加载 —— 测试运行器不解析 `@/` 别名。
 */

/**
 * 深拷贝成纯数据（JSON 往返）。
 *
 * 适用前提：载荷本身是 JSON 可表达的业务数据（草稿、设置、导出参数…）。
 * **不适用**二进制 / `Date` / `Map` / `Set`：那些请原样传递，不要经过这里。
 */
export function cloneForIpc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
