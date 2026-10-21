<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  AlarmClock,
  CircleCheck,
  Coin,
  MagicStick,
  Star,
  Tickets,
  WarningFilled,
} from '@element-plus/icons-vue'
import { SCORE_ROLES, type ScoreRole } from '@/config/score'
import { chatStream } from '@/services/agent'
import ZentaoTasksCard from '@/components/ZentaoTasksCard.vue'
import {
  buildCoachPrompt,
  fetchScoreRange,
  findSelf,
  type ScorePerson,
  type ScoreRangeResponse,
} from '@/services/score'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const RANGE_KEY = 'score:dashboard-range'

/** 结束日期是否勾选「截至当日」：勾上后跟随当天滚动 */
const endToday = ref(false)

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function defaultRange(): [string, string] {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - 6)
  return [fmt(start), fmt(end)]
}

/**
 * 读取上次选择的日期范围。
 * endToday 标记存了「截至当日」，重开时结束日期用新的当天；
 * 否则恢复上次手选的固定起止日期。
 */
function loadRange(): [string, string] {
  try {
    const raw = localStorage.getItem(RANGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      if (saved?.start) {
        if (saved.endToday) {
          endToday.value = true
          return [saved.start, fmt(new Date())]
        }
        if (saved.end) return [saved.start, saved.end]
      }
    }
  } catch {
    // 数据损坏时回落到默认范围
  }
  return defaultRange()
}

const role = ref<ScoreRole>('dev')
const range = ref<[string, string]>(loadRange())
const loading = ref(false)
const resp = ref<ScoreRangeResponse | null>(null)
const self = ref<ScorePerson | null>(null)

/** 勾选「截至当日」：结束日期锁为今天并重新查询 */
function onEndTodayToggle(v: boolean) {
  if (v) range.value = [range.value[0], fmt(new Date())]
  query()
}

function onRangeChange(val: [string, string] | null) {
  // 勾着「截至当日」又手动把结束日期改成别的日子 → 取消勾选
  if (val && endToday.value && val[1] !== fmt(new Date())) endToday.value = false
  query()
}

function saveRange() {
  const [start, end] = range.value
  localStorage.setItem(RANGE_KEY, JSON.stringify({ start, end, endToday: endToday.value }))
}

async function query() {
  loading.value = true
  saveRange()
  try {
    const [start, end] = range.value
    resp.value = await fetchScoreRange(role.value, start, end)
    pickSelf()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '绩效数据加载失败')
  } finally {
    loading.value = false
  }
}

function pickSelf() {
  const username = auth.session?.user?.username as string | undefined
  const found = findSelf(resp.value?.people ?? [], username, auth.displayName)
  self.value = found ?? null
}

/** 首次加载自动探测人员类型：依次尝试 dev/test/other，谁匹配到当前用户就用谁 */
async function init() {
  loading.value = true
  const [start, end] = range.value
  const username = auth.session?.user?.username as string | undefined

  const results = await Promise.allSettled(
    SCORE_ROLES.map((r) => fetchScoreRange(r.value, start, end)),
  )
  loading.value = false

  for (const [i, r] of results.entries()) {
    if (r.status !== 'fulfilled') continue
    if (findSelf(r.value.people, username, auth.displayName)) {
      role.value = SCORE_ROLES[i].value
      resp.value = r.value
      pickSelf()
      return
    }
  }
  // 都没匹配到：展示第一个成功的请求，提示未匹配
  const first = results.find((r) => r.status === 'fulfilled')
  if (first && first.status === 'fulfilled') {
    resp.value = first.value
    pickSelf()
  } else {
    ElMessage.error('绩效服务不可达')
  }
}

onMounted(init)

// ---- AI 分析 ----
const analysis = ref('')
const analyzing = ref(false)

async function analyze() {
  if (!self.value || !resp.value || analyzing.value) return
  analyzing.value = true
  analysis.value = ''
  try {
    await chatStream(buildCoachPrompt(resp.value, self.value), (_d, acc) => {
      analysis.value = acc
    })
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : 'AI 分析失败')
  } finally {
    analyzing.value = false
  }
}

// ---- 展示辅助 ----
const roleLabel = computed(() => SCORE_ROLES.find((r) => r.value === role.value)?.label ?? '')

const gradeType = computed(() => {
  const g = self.value?.grade ?? ''
  if (g.startsWith('A')) return 'success'
  if (g.startsWith('B')) return 'primary'
  return 'warning'
})

const avatarText = computed(() => (self.value?.name ?? auth.displayName).charAt(0))

const tiles = computed(() => {
  const p = self.value
  if (!p) return []
  return [
    { label: '已领取任务', value: p.assigned_task, icon: Tickets, color: '#3370ff' },
    { label: '完成任务', value: p.done_task, sub: `高优 ${p.high_pri}`, icon: CircleCheck, color: '#00b96b' },
    { label: '消耗工时', value: p.consumed, sub: `结算 ${p.settled_hours}h`, icon: AlarmClock, color: '#ff8800' },
    { label: '任务积分', value: p.task_point, sub: `任务贡献 ${p.task_contribution}`, icon: Coin, color: '#7c6cf0' },
    { label: 'Bug', value: p.bug_total, sub: `严重 ${p.bug_serious} · 致命 ${p.bug_fatal}`, icon: WarningFilled, color: p.bug_total > 0 ? '#f54a45' : '#00b96b' },
    { label: '主观分', value: p.subj, sub: '满分 100', icon: Star, color: '#0fc6c2' },
  ]
})

const attendance = computed(() => {
  const p = self.value
  if (!p) return []
  const rows = [
    { label: '合作社考勤', value: p.attend_hz },
    { label: '指纹机考勤', value: p.attend_fp },
    { label: '实际出勤', value: p.attend_max },
  ]
  return rows.map((r) => ({
    ...r,
    pct: p.attend_bench > 0 ? Math.min(100, Math.round((r.value / p.attend_bench) * 100)) : 0,
  }))
})

function attendStatus(value: number): 'success' | 'warning' | 'exception' {
  const p = self.value
  if (!p || p.attend_bench <= 0) return 'success'
  const ratio = value / p.attend_bench
  if (ratio >= 1) return 'success'
  if (ratio >= 0.9) return 'warning'
  return 'exception'
}

const outputs = computed(() => {
  const p = self.value
  if (!p) return []
  return [
    { label: '代码提交', value: p.commit },
    { label: 'MR', value: p.mr },
    { label: '代码行数', value: p.loc, sub: `+${p.addition} / -${p.deletion}` },
    { label: '需求', value: p.req },
    { label: '评审', value: p.review },
    { label: '新增任务', value: p.new_task },
    { label: '加班工时', value: p.overflow_hours },
    { label: '出勤天数', value: p.workdays },
  ]
})
</script>

<template>
  <div class="dashboard">
    <!-- 工具条 -->
    <div class="toolbar">
      <el-tag size="large" effect="plain" class="role-tag">{{ roleLabel }}</el-tag>
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
        :clearable="false"
        @change="onRangeChange"
      />
      <el-checkbox v-model="endToday" label="截至当日" @change="onEndTodayToggle" />
      <el-button type="primary" :loading="loading" @click="query">查询</el-button>
    </div>

    <div v-if="self && resp" v-loading="loading" class="content">
      <!-- Hero：总分 / 等级 / 排名 -->
      <div class="hero">
        <div class="hero-left">
          <div class="hero-avatar">{{ avatarText }}</div>
          <div>
            <div class="hero-name">
              {{ self.name }}
              <el-tag size="small" :type="gradeType" effect="dark" class="grade-tag">
                {{ self.grade }}
              </el-tag>
            </div>
            <div class="hero-sub">
              {{ resp.dept_filter }} · {{ roleLabel }} · {{ resp.start }} ~ {{ resp.end }} · 模型
              {{ resp.model }}
            </div>
          </div>
        </div>
        <div class="hero-right">
          <div class="hero-score">
            <span class="score-num">{{ self.total }}</span>
            <span class="score-label">总分</span>
          </div>
          <div class="hero-rank">排名第 {{ self.rank }} / {{ resp.pool_people }} 人</div>
        </div>
      </div>

      <!-- KPI 指标块 -->
      <div class="tiles">
        <div v-for="t in tiles" :key="t.label" class="tile">
          <div class="tile-icon" :style="{ background: t.color + '1a', color: t.color }">
            <el-icon :size="20"><component :is="t.icon" /></el-icon>
          </div>
          <div class="tile-num">{{ t.value }}</div>
          <div class="tile-label">{{ t.label }}</div>
          <div v-if="t.sub" class="tile-sub">{{ t.sub }}</div>
        </div>
      </div>

      <!-- 考勤 + 研发产出 -->
      <el-row :gutter="22">
        <el-col :span="14">
          <el-card shadow="never" class="panel">
            <template #header>
              <div class="panel-head">
                <span>考勤情况</span>
                <span class="bench">基准线 {{ self.attend_bench }}h</span>
              </div>
            </template>
            <div v-for="a in attendance" :key="a.label" class="attend-row">
              <span class="attend-label">{{ a.label }}</span>
              <el-progress
                :percentage="a.pct"
                :status="attendStatus(a.value)"
                :stroke-width="10"
                class="attend-bar"
              />
              <span class="attend-value">{{ a.value }}h</span>
            </div>
            <div class="attend-foot">
              <el-tag v-if="self.leave_days > 0" type="info" size="small">
                休假 {{ self.leave_days }} 天
              </el-tag>
              <el-tag v-if="self.late > 0" type="warning" size="small">
                迟到 {{ self.late }} 次
              </el-tag>
              <el-tag size="small">预算工时 {{ self.attend_budget }}h</el-tag>
            </div>
          </el-card>
        </el-col>
        <el-col :span="10">
          <el-card shadow="never" class="panel">
            <template #header>研发产出</template>
            <div class="output-grid">
              <div v-for="o in outputs" :key="o.label" class="output-item">
                <div class="output-value">{{ o.value }}</div>
                <div class="output-label">{{ o.label }}</div>
                <div v-if="o.sub" class="output-sub">{{ o.sub }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- AI 提升分析 -->
      <el-card shadow="never" class="panel ai-panel">
        <template #header>
          <div class="panel-head">
            <span class="ai-title">
              <el-icon :size="16" class="ai-icon"><MagicStick /></el-icon>
              AI 提升建议
            </span>
            <el-button
              type="primary"
              size="small"
              :loading="analyzing"
              @click="analyze"
            >
              <el-icon v-if="!analyzing"><MagicStick /></el-icon>
              {{ analyzing ? '分析中…' : analysis ? '重新分析' : '开始分析' }}
            </el-button>
          </div>
        </template>
        <div v-if="analysis" class="ai-result">{{ analysis }}</div>
        <div v-else class="ai-empty">
          点击「开始分析」，AI 将结合积分规则与你在 {{ resp.start }} ~ {{ resp.end }}
          的数据，给出快速提升积分排名的建议
        </div>
      </el-card>

      <!-- 禅道任务 -->
      <ZentaoTasksCard />
    </div>

    <el-card v-else-if="!loading" shadow="never" class="panel empty">
      <el-empty :description="`该时间段内未匹配到「${auth.displayName}」的${roleLabel}绩效数据`" />
    </el-card>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 10px;
  padding: 10px 14px;
}

.role-tag {
  font-weight: 600;
}

/* ---- Hero ---- */
.hero {
  border-radius: 12px;
  padding: 30px 34px;
  background: linear-gradient(120deg, #1d39c4 0%, #3370ff 55%, #6aa5ff 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 6px 20px rgba(51, 112, 255, 0.28);
}

.hero-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.hero-avatar {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.22);
  border: 2px solid rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 26px;
  font-weight: 600;
}

.hero-name {
  font-size: 20px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
}

.grade-tag {
  font-weight: 700;
}

.hero-sub {
  margin-top: 6px;
  font-size: 13px;
  opacity: 0.85;
}

.hero-right {
  text-align: right;
}

.score-num {
  font-size: 44px;
  font-weight: 700;
  line-height: 1;
}

.score-label {
  font-size: 13px;
  opacity: 0.85;
  margin-left: 6px;
}

.hero-rank {
  margin-top: 8px;
  font-size: 13px;
  opacity: 0.9;
}

/* ---- KPI tiles ---- */
.tiles {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 20px;
}

.tile {
  background: #fff;
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 10px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition:
    box-shadow 0.2s,
    transform 0.2s;
}

.tile:hover {
  transform: translateY(-2px);
}

.tile:hover {
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
}

.tile-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
}

.tile-num {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
}

.tile-label {
  font-size: 13px;
  color: #606266;
}

.tile-sub {
  font-size: 12px;
  color: #a8abb2;
}

/* ---- panels ---- */
.panel {
  border-radius: 10px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bench {
  font-size: 12px;
  color: #909399;
}

.attend-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}

.attend-label {
  width: 80px;
  font-size: 13px;
  color: #606266;
}

.attend-bar {
  flex: 1;
}

.attend-value {
  width: 56px;
  text-align: right;
  font-weight: 600;
  font-size: 13px;
}

.attend-foot {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.output-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px 12px;
}

.output-item {
  text-align: center;
}

.output-value {
  font-size: 20px;
  font-weight: 700;
}

.output-label {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}

.output-sub {
  font-size: 11px;
  color: #b5b9c0;
}

.empty {
  padding: 40px 0;
}

/* ---- AI 分析 ---- */
.ai-panel {
  border: 1px solid var(--el-color-primary-light-8);
  background: linear-gradient(180deg, #f8faff 0%, #fff 60%);
}

.ai-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ai-icon {
  color: var(--el-color-primary);
}

.ai-result {
  white-space: pre-wrap;
  line-height: 1.9;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.ai-empty {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  padding: 12px 0;
}
</style>
