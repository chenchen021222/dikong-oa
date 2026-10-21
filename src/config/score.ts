/**
 * 绩效积分数据服务配置
 *
 * 数据源：内网绩效服务（单独放这里方便改地址，全局只有这一处）
 * 接口形态：GET {base}/api/score/{role}/range?start=YYYY-MM-DD&end=YYYY-MM-DD
 *   role = dev(开发人员) | test(测试人员) | other(其他人员)
 * 返回：该时间段内全员积分明细 + 汇总字段，前端按当前登录人过滤出自己。
 */
export const SCORE_API_BASE = 'http://192.168.101.127:15050'

export type ScoreRole = 'dev' | 'test' | 'other'

/** 人员类型 → 接口路径段（如后端实际路径不同，改这里即可） */
export const SCORE_ROLES: { value: ScoreRole; label: string; path: string }[] = [
  { value: 'dev', label: '开发人员', path: 'dev' },
  { value: 'test', label: '测试人员', path: 'test' },
  { value: 'other', label: '其他人员', path: 'other' },
]

/**
 * 登录账号 → 绩效系统账号映射（过渡期预览用）。
 * 绩效数据 account 形如 dwzhouchenji；本地 admin 登录匹配不到时按此映射查。
 * 接入统一账号体系后可删除。
 */
export const SCORE_ACCOUNT_ALIAS: Record<string, string> = {
  admin: 'dwzhouchenji',
  liujiahao: 'dwliujiahao',
}

/**
 * 积分计算规则（喂给 AI 做提升分析的背景知识，规则变了改这里）
 */
export const SCORE_RULES = [
  '单任务价值 = 预估工时 × 难度系数(pri1-2=1.6 / pri3-4=1.0) × 质量 × 效率(是否按期交付)',
  '任务积分 = 结算工时 × 难度 × 质量 × 效率；结算工时按出勤预算内足额计算、高优先级优先，超出预算部分按阶梯衰减 ×0.3 / 0.2 / 0.1',
  '综合得分 = 任务积分 × 70% + 主观评价 × 30%',
  'Bug 会扣分，严重/致命权重更高；合作社考勤与指纹机考勤影响结算工时，进而影响积分',
].join('\n')
