import { agentConfig, hasAgentKey } from '@/config/agent'

/**
 * DeepSeek 智能体服务
 * OpenAI 兼容协议，支持普通对话与 SSE 流式输出。
 */

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AgentToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AgentMessage {
  role: AgentRole
  content: string
  /** assistant 消息携带的工具调用请求 */
  tool_calls?: AgentToolCall[]
  /** tool 消息对应的调用 id */
  tool_call_id?: string
}

/** OpenAI 兼容的 function 工具定义 */
export interface AgentToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatOptions {
  /** 覆盖默认模型，如切到 deepseek-reasoner */
  model?: string
  temperature?: number
  maxTokens?: number
  /** 额外系统提示词，拼接在默认 systemPrompt 之后 */
  extraSystemPrompt?: string
  signal?: AbortSignal
}

interface ChatCompletionResponse {
  choices: {
    message: { content: string | null; tool_calls?: AgentToolCall[] }
    finish_reason: string
  }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

function buildMessages(messages: AgentMessage[], opts?: ChatOptions): AgentMessage[] {
  const system = opts?.extraSystemPrompt
    ? `${agentConfig.systemPrompt}\n${opts.extraSystemPrompt}`
    : agentConfig.systemPrompt
  return [{ role: 'system', content: system }, ...messages]
}

function buildBody(messages: AgentMessage[], stream: boolean, opts?: ChatOptions) {
  return {
    model: opts?.model ?? agentConfig.model,
    messages: buildMessages(messages, opts),
    temperature: opts?.temperature ?? agentConfig.temperature,
    max_tokens: opts?.maxTokens ?? agentConfig.maxTokens,
    stream,
  }
}

async function postChat(body: unknown, signal?: AbortSignal): Promise<Response> {
  if (!hasAgentKey()) throw new Error('未配置 VITE_DEEPSEEK_API_KEY')
  const res = await fetch(`${agentConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agentConfig.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error(`DeepSeek 请求失败: ${res.status} ${await res.text()}`)
  return res
}

/** 非流式对话，返回完整回复文本 */
export async function chat(messages: AgentMessage[], opts?: ChatOptions): Promise<string> {
  const res = await postChat(buildBody(messages, false, opts), opts?.signal)
  const data: ChatCompletionResponse = await res.json()
  const content = data.choices[0]?.message.content
  if (content == null) throw new Error('DeepSeek 返回内容为空')
  return content
}

/**
 * 流式对话：每收到一段增量文本回调 onDelta，返回完整回复。
 * 后续接 UI 时用它做打字机效果。
 */
export async function chatStream(
  messages: AgentMessage[],
  onDelta: (delta: string, full: string) => void,
  opts?: ChatOptions,
): Promise<string> {
  const res = await postChat(buildBody(messages, true, opts), opts?.signal)
  if (!res.body) throw new Error('DeepSeek 响应无数据流')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 以空行分隔事件，逐条解析 data: {...}
    const events = buffer.split('\n\n')
    buffer = events.pop() ?? ''
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return full
        try {
          const delta: string = JSON.parse(payload).choices?.[0]?.delta?.content ?? ''
          if (delta) {
            full += delta
            onDelta(delta, full)
          }
        } catch {
          // 忽略不完整的 JSON 分片
        }
      }
    }
  }
  return full
}

/** 带工具的单轮请求：返回模型消息（可能含 tool_calls） */
export async function chatOnce(
  messages: AgentMessage[],
  tools?: AgentToolDef[],
  opts?: ChatOptions,
): Promise<{ content: string; tool_calls?: AgentToolCall[] }> {
  const body = {
    ...buildBody(messages, false, opts),
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
  }
  const res = await postChat(body, opts?.signal)
  const data: ChatCompletionResponse = await res.json()
  const msg = data.choices[0]?.message
  if (!msg) throw new Error('DeepSeek 返回内容为空')
  return { content: msg.content ?? '', tool_calls: msg.tool_calls }
}

export interface AgentStepEvent {
  type: 'text' | 'tool'
  text?: string
  toolName?: string
  toolArgs?: Record<string, unknown>
}

/**
 * 工具调用循环：模型每轮决定调哪个工具，执行结果回喂，直到模型不再调用工具。
 * onStep 用于 UI 实时展示智能体在做什么。
 */
export async function runToolAgent(options: {
  messages: AgentMessage[]
  tools: AgentToolDef[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  onStep?: (e: AgentStepEvent) => void
  maxSteps?: number
  signal?: AbortSignal
  /** 任务级附加系统提示词 */
  extraSystemPrompt?: string
}): Promise<string> {
  const { messages, tools, callTool, onStep, maxSteps = 40, signal, extraSystemPrompt } = options
  const msgs = [...messages]

  for (let i = 0; i < maxSteps; i++) {
    const msg = await chatOnce(msgs, tools, { signal, extraSystemPrompt })
    msgs.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls })
    if (msg.content) onStep?.({ type: 'text', text: msg.content })
    if (!msg.tool_calls?.length) return msg.content

    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch {
        // 参数 JSON 解析失败按空调用处理
      }
      onStep?.({ type: 'tool', toolName: tc.function.name, toolArgs: args })
      let result: string
      try {
        result = await callTool(tc.function.name, args)
      } catch (e) {
        result = `错误: ${e instanceof Error ? e.message : String(e)}`
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }
  return '已达到最大操作步数，任务中止'
}
