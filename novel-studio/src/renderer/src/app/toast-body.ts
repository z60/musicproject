/**
 * Novel Studio · toast / modal 正文渲染器
 * ============================================================================
 * 设计依据：docs/22 §7 展示策略
 *   · warning → Toast 3 秒 + **可展开详情**
 *   · error   → Toast 5 秒 + 重试按钮
 *   · fatal   → Modal，不可自动关闭，展示错误编号
 *
 * 为什么不用字符串 message：
 *   error-bus 需要「同一条提示被合并时更新标题（已发生 N 次）」以及
 *   「明细可展开、动作按钮多枚」。字符串拼不出这些结构，而这个组件把
 *   `state` 当作响应式对象读取，因此 `handle.update({...})` 会就地刷新提示，
 *   不会新开一条 toast（这正是批量任务防刷屏的关键，docs/22 §7）。
 *
 * 本文件用纯渲染函数（无模板）实现，因此不引入额外的 .vue 文件与样式作用域问题。
 */

import { computed, defineComponent, h, ref, type PropType } from 'vue'

export interface ToastAction {
  label: string
  handler: () => void
}

export interface ToastState {
  title: string
  detail: string
  hint: string
}

export const ToastBody = defineComponent({
  name: 'NsToastBody',
  props: {
    /** 响应式状态：标题/正文/建议由 error-bus 更新 */
    state: { type: Object as PropType<ToastState>, required: true },
    /** 仅开发模式展示（堆栈、技术说明） */
    devText: { type: String as PropType<string | null>, default: null },
    actions: { type: Array as PropType<ToastAction[]>, default: () => [] },
    /** fatal 场景展示错误编号（docs/22 §7：报障要能口述编号） */
    code: { type: String as PropType<string | null>, default: null },
  },
  setup(props) {
    const expanded = ref(false)
    const hasDetail = computed(() => Boolean(props.state.detail && props.state.detail.length > 0))

    return () => {
      const children: ReturnType<typeof h>[] = []

      if (props.state.title) {
        children.push(h('div', {
          class: 'ns-toast__title',
          style: { fontWeight: '600', fontSize: '14px', lineHeight: '1.5', color: 'var(--ns-text-primary, #303133)' },
        }, props.state.title))
      }

      if (hasDetail.value) {
        children.push(h('div', {
          class: 'ns-toast__detail',
          style: {
            marginTop: '4px',
            fontSize: '12px',
            lineHeight: '1.6',
            color: 'var(--ns-text-regular, #606266)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          },
        }, props.state.detail))
      }

      if (props.state.hint) {
        children.push(h('div', {
          class: 'ns-toast__hint',
          style: { marginTop: '4px', fontSize: '12px', lineHeight: '1.6', color: 'var(--ns-text-secondary, #909399)' },
        }, props.state.hint))
      }

      if (props.code) {
        children.push(h('div', {
          class: 'ns-toast__code',
          style: { marginTop: '6px', fontSize: '12px', color: 'var(--ns-text-secondary, #909399)' },
        }, ['错误编号：', h('code', {
          style: {
            padding: '1px 6px',
            borderRadius: '4px',
            background: 'var(--ns-fill-light, #f5f7fa)',
            fontFamily: 'ui-monospace, Consolas, monospace',
          },
        }, props.code)]))
      }

      if (props.actions.length) {
        children.push(h('div', {
          class: 'ns-toast__actions',
          style: { display: 'flex', gap: '8px', marginTop: '8px' },
        }, props.actions.map(action => h('button', {
          type: 'button',
          class: 'ns-toast__action',
          style: {
            padding: '3px 10px',
            border: '1px solid var(--ns-primary, #409eff)',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--ns-primary, #409eff)',
            fontSize: '12px',
            cursor: 'pointer',
          },
          onClick: () => action.handler(),
        }, action.label))))
      }

      if (props.devText) {
        children.push(h('div', {
          class: 'ns-toast__dev',
          style: { marginTop: '8px' },
        }, [
          h('button', {
            type: 'button',
            style: {
              padding: '0',
              border: 'none',
              background: 'transparent',
              color: 'var(--ns-text-secondary, #909399)',
              fontSize: '11px',
              textDecoration: 'underline',
              cursor: 'pointer',
            },
            onClick: () => { expanded.value = !expanded.value },
          }, expanded.value ? '收起开发信息' : '展开开发信息'),
          expanded.value
            ? h('pre', {
                style: {
                  maxHeight: '200px',
                  marginTop: '6px',
                  marginBottom: '0',
                  padding: '8px',
                  overflow: 'auto',
                  borderRadius: '4px',
                  background: 'var(--ns-fill-light, #f5f7fa)',
                  fontSize: '11px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                },
              }, props.devText)
            : null,
        ]))
      }

      return h('div', { class: 'ns-toast' }, children)
    }
  },
})

export default ToastBody
