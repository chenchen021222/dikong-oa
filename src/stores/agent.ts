import { ref } from 'vue'
import { defineStore } from 'pinia'
import { chatStream, type AgentMessage } from '@/services/agent'

export interface ChatItem extends AgentMessage {
  /** 流式输出中为 true */
  pending?: boolean
}

export const useAgentStore = defineStore('agent', () => {
  const messages = ref<ChatItem[]>([])
  const sending = ref(false)
  const error = ref<string | null>(null)

  /** 发送一条用户消息并流式接收回复 */
  async function send(content: string): Promise<void> {
    if (!content.trim() || sending.value) return
    sending.value = true
    error.value = null
    messages.value.push({ role: 'user', content })
    messages.value.push({ role: 'assistant', content: '', pending: true })

    const history = messages.value
      .filter((m) => !m.pending)
      .map(({ role, content: c }) => ({ role, content: c }))

    try {
      const full = await chatStream(history, (_delta, acc) => {
        const last = messages.value[messages.value.length - 1]
        if (last?.pending) last.content = acc
      })
      const last = messages.value[messages.value.length - 1]
      if (last) {
        last.content = full
        last.pending = false
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      messages.value = messages.value.filter((m) => !m.pending)
    } finally {
      sending.value = false
    }
  }

  function clear() {
    messages.value = []
    error.value = null
  }

  return { messages, sending, error, send, clear }
})
