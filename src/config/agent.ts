/**
 * 智能体（LLM）配置
 *
 * 当前接入 DeepSeek，接口为 OpenAI 兼容协议（/chat/completions）。
 * 密钥来源（优先级从高到低）：
 *   1. 环境变量 VITE_DEEPSEEK_API_KEY（.env.local，不入库）
 *   2. 本地文件 agent.local.ts（不入库，复制自 agent.local.example.ts）
 *
 *   VITE_DEEPSEEK_BASE_URL  接口地址，默认 https://api.deepseek.com
 *   VITE_DEEPSEEK_MODEL     模型名，deepseek-chat | deepseek-reasoner
 */

import { agentSecrets } from './agent.local'

export interface AgentConfig {
  baseUrl: string
  model: string
  apiKey: string
  temperature: number
  /** 注入到每次会话开头的系统提示词 */
  systemPrompt: string
  /** 单次回复最大 token 数 */
  maxTokens: number
}

export const agentConfig: AgentConfig = {
  baseUrl: import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  model: import.meta.env.VITE_DEEPSEEK_MODEL ?? 'deepseek-chat',
  apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY || agentSecrets.deepseekApiKey,
  temperature: 0.7,
  maxTokens: 4096,
  systemPrompt:
    '你是 DiKong OA 系统内置的智能办公助手「小迪」。' +
    '你可以帮助用户处理审批、考勤、日程、文档等企业办公相关问题。' +
    '回答使用简体中文，简洁、专业、可执行。',
}

export function hasAgentKey(): boolean {
  return agentConfig.apiKey.length > 0
}
