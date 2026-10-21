/**
 * 禅道（ZenTao）服务配置
 *
 * 禅道 REST API v1：{base}/api.php/v1
 * 认证：POST /tokens 用账号密码换 token，后续请求 Header 携带 `Token: <token>`
 *
 * 「我的地盘」数据入口：
 *   GET /user?fields=task&type=assignedTo   指派给我的任务
 *   GET /user?fields=bug&type=assignedTo    指派给我的 Bug
 *   GET /user?fields=story&type=assignedTo  指派给我的需求
 */
export const ZENTAO_API_BASE = 'http://172.24.7.129:31225' // 禅道内网服务地址

export const ZENTAO_API_PREFIX = '/api.php/v1'

/** 我的地盘支持的列表类型 */
export type ZentaoWorkMode = 'task' | 'bug' | 'story' | 'todo'

export const ZENTAO_WORK_MODES: { value: ZentaoWorkMode; label: string }[] = [
  { value: 'task', label: '任务' },
  { value: 'bug', label: 'Bug' },
  { value: 'story', label: '需求' },
  { value: 'todo', label: '待办' },
]
