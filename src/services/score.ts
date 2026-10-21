import {
  SCORE_ACCOUNT_ALIAS,
  SCORE_API_BASE,
  SCORE_RULES,
  type ScoreRole,
} from '@/config/score'
import { isTauri } from './auth'
import type { AgentMessage } from './agent'

/** 单人积分明细（字段与后端返回一一对应） */
export interface ScorePerson {
  account: string
  name: string
  role: string
  rank: number
  grade: string
  total: number
  subj: number
  task_point: number
  task_contribution: number
  // 任务
  assigned_task: number
  done_task: number
  done_total: number
  new_task: number
  high_pri: number
  req: number
  review: number
  // 工时
  consumed: number
  settled_hours: number
  overflow_hours: number
  // 考勤
  attend_bench: number
  attend_budget: number
  attend_fp: number
  attend_hz: number
  attend_max: number
  workdays: number
  leave_days: number
  late: number
  early: number
  // Bug / 代码
  bug_total: number
  bug_serious: number
  bug_fatal: number
  commit: number
  mr: number
  loc: number
  addition: number
  deletion: number
  [key: string]: unknown
}

export interface ScoreRangeResponse {
  dept_filter: string
  start: string
  end: string
  month: string
  model: string
  pool_people: number
  people: ScorePerson[]
  total_point: number
  total_done: number
  total_commit: number
  [key: string]: unknown
}

// Web 开发环境走 vite 代理避免跨域；Tauri / 生产环境走管理员电脑的代理绕过 webview 限制
const PROXY_SCORE = 'http://192.168.8.86:8619/score-api'
const base =
  import.meta.env.DEV && !isTauri ? '/score-api' : PROXY_SCORE

export async function fetchScoreRange(
  role: ScoreRole,
  start: string,
  end: string,
): Promise<ScoreRangeResponse> {
  let res: Response
  try {
    res = await fetch(`${base}/api/score/${role}/range?start=${start}&end=${end}`, {
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    throw new Error(
      '无法连接绩效服务，请确认网络可访问 192.168.101.127:15050 或联系管理员',
    )
  }
  if (!res.ok) throw new Error(`绩效接口返回错误: ${res.status}`)
  return res.json()
}

/**
 * 在全员数据中匹配当前登录人：
 * 登录账号 → 别名映射 → 账号本身 → 显示名 依次尝试。
 */
export function findSelf(
  people: ScorePerson[],
  username?: string,
  displayName?: string,
): ScorePerson | undefined {
  const keys = new Set<string>()
  if (username) {
    keys.add(username)
    const alias = SCORE_ACCOUNT_ALIAS[username]
    if (alias) keys.add(alias)
  }
  if (displayName) keys.add(displayName)
  return people.find((p) => keys.has(p.account) || keys.has(p.name))
}

/**
 * 构建「AI 提升建议」的 prompt：积分规则 + 本人数据 + 与上一名的分差。
 */
export function buildCoachPrompt(resp: ScoreRangeResponse, p: ScorePerson): AgentMessage[] {
  const ahead = resp.people.find((x) => x.rank === p.rank - 1)
  const gap = ahead ? +(ahead.total - p.total + 0.1).toFixed(1) : null

  const data = {
    姓名: p.name,
    排名: `${p.rank}/${resp.pool_people}`,
    等级: p.grade,
    综合得分: p.total,
    任务积分: p.task_point,
    任务贡献: p.task_contribution,
    主观评价: p.subj,
    已领取任务: p.assigned_task,
    完成任务: p.done_task,
    高优任务: p.high_pri,
    新增任务: p.new_task,
    需求: p.req,
    评审: p.review,
    消耗工时: p.consumed,
    结算工时: p.settled_hours,
    加班工时: p.overflow_hours,
    合作社考勤: p.attend_hz,
    指纹机考勤: p.attend_fp,
    实际出勤: p.attend_max,
    出勤基准线: p.attend_bench,
    出勤预算: p.attend_budget,
    出勤天数: p.workdays,
    休假天数: p.leave_days,
    Bug: `${p.bug_total}(严重${p.bug_serious}/致命${p.bug_fatal})`,
    代码提交: p.commit,
    MR: p.mr,
    代码行数: p.loc,
  }

  return [
    {
      role: 'user',
      content:
        `你是 DiKong OA 的绩效教练。请根据积分规则分析员工 ${resp.start} ~ ${resp.end} 的积分数据，` +
        `给出快速提升积分排名的建议。\n\n` +
        `【积分规则】\n${SCORE_RULES}\n\n` +
        `【我的数据】\n${JSON.stringify(data, null, 2)}\n\n` +
        (gap ? `距上一名还差 ${gap} 分。` : '当前排名第 1。') +
        `\n要求：先指出最拖分的 1~2 个指标，再按见效快慢给出 3~5 条可执行建议，` +
        `每条不超过 40 字，用「•」分点输出，不要标题、不要客套话。`,
    },
  ]
}
