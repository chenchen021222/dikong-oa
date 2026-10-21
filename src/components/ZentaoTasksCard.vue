<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, Link, Loading, MagicStick, Refresh, SwitchButton } from '@element-plus/icons-vue'
import { ZENTAO_API_BASE } from '@/config/zentao'
import { isTauri } from '@/services/auth'
import { runToolAgent } from '@/services/agent'
import { useAuthStore } from '@/stores/auth'
import {
  ZENTAO_AGENT_PROMPT,
  ZENTAO_AGENT_TOOLS,
  fetchMyWork,
  isOverdue,
  loadCachedTasks,
  loadZentaoConfig,
  loadZentaoCred,
  overdueDays,
  saveTasksToDb,
  saveZentaoConfig,
  saveZentaoCred,
  zentaoLogin,
  zentaoToolExecutor,
  ztCloseWindow,
  type ZentaoConfig,
  type ZentaoItem,
} from '@/services/zentao'

const auth = useAuthStore()
const sessionToken = computed(() => auth.session?.tokens.access_token ?? '')

const tasks = ref<ZentaoItem[]>([])
const loading = ref(false)

/** 已绑定的禅道凭据（存本机 SQLite） */
const cred = ref<ZentaoConfig | null>(null)
const bindAccount = ref('')
const bindPassword = ref('')

// 交互式流程状态：idle 未连接 → running 智能体执行中 → ready 已读取
const phase = ref<'idle' | 'running' | 'ready'>('idle')
const FLAG_KEY = 'zentao:interactive'

const REFRESH_MS = 5 * 60 * 1000 // 任务自动刷新间隔
let refreshTimer: ReturnType<typeof setInterval> | undefined

const STATUS_MAP: Record<
  string,
  { label: string; type: 'info' | 'primary' | 'success' | 'warning' | 'danger' }
> = {
  wait: { label: '未开始', type: 'info' },
  doing: { label: '进行中', type: 'primary' },
  done: { label: '已完成', type: 'success' },
  pause: { label: '已暂停', type: 'warning' },
  cancel: { label: '已取消', type: 'info' },
  closed: { label: '已关闭', type: 'info' },
  delay: { label: '已延期', type: 'danger' },
}

const PRI_COLORS: Record<string, string> = {
  '1': 'danger',
  '2': 'warning',
  '3': 'primary',
  '4': 'info',
}

const overdueCount = computed(() => tasks.value.filter(isOverdue).length)
const sortedTasks = computed(() =>
  [...tasks.value].sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a))),
)

/** 智能体执行日志（相同步骤合并计数） */
const agentSteps = ref<{ text: string; n: number }[]>([])
const agentSummary = ref('')
let agentAbort: AbortController | null = null

const TOOL_LABELS: Record<string, (a: Record<string, unknown>) => string> = {
  open_zentao_window: (a) => (a?.visible ? '弹出禅道登录窗口，等你登录' : '静默打开禅道页面'),
  auto_login_zentao: () => '用已绑定账号自动登录禅道',
  check_zentao_login: () => '检查禅道登录状态',
  read_my_zentao_tasks: () => '读取指派给你的任务',
  close_zentao_window: () => '关闭禅道窗口',
  wait_seconds: (a) => `等待 ${a?.seconds ?? 5} 秒后重新检查`,
}

function pushStep(text: string) {
  const last = agentSteps.value[agentSteps.value.length - 1]
  if (last && last.text === text) last.n += 1
  else agentSteps.value.push({ text, n: 1 })
}

/**
 * 点「连接禅道」→ 交给智能体接管：
 * 它自己开窗口探测登录态、必要时弹窗等用户登录、读任务、关窗口，最后汇报结果。
 */
async function connectInteractive() {
  if (phase.value === 'running') return
  phase.value = 'running'
  loading.value = true
  agentSteps.value = []
  agentSummary.value = ''
  agentAbort = new AbortController()

  try {
    agentSummary.value = await runToolAgent({
      messages: [
        { role: 'user', content: '帮我连接禅道，读取指派给我的任务，并检查是否有超时任务' },
      ],
      tools: ZENTAO_AGENT_TOOLS,
      callTool: zentaoToolExecutor((items) => {
        tasks.value = items
        saveTasksToDb(sessionToken.value, items)
      }, cred.value),
      extraSystemPrompt: ZENTAO_AGENT_PROMPT,
      maxSteps: 60,
      signal: agentAbort.signal,
      onStep: (e) => {
        if (e.type === 'tool') pushStep(TOOL_LABELS[e.toolName ?? '']?.(e.toolArgs ?? {}) ?? e.toolName!)
      },
    })
    phase.value = 'ready'
    localStorage.setItem(FLAG_KEY, '1')
  } catch (e) {
    phase.value = 'idle'
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== '禅道窗口未打开' && !agentAbort.signal.aborted) {
      ElMessage.error(msg || '禅道连接失败')
    }
    ztCloseWindow()
  } finally {
    loading.value = false
    agentAbort = null
  }
}

function cancelAgent() {
  agentAbort?.abort()
  phase.value = 'idle'
  ztCloseWindow()
}

/** 绑定禅道账号密码（存本机 SQLite）后连接 */
async function bindAndConnect() {
  const account = bindAccount.value.trim()
  if (!account || !bindPassword.value) {
    ElMessage.warning('请填写禅道账号和密码')
    return
  }
  cred.value = { account, password: bindPassword.value }
  await saveZentaoCred(sessionToken.value, cred.value)
  bindPassword.value = ''
  connectInteractive()
}

async function unbind() {
  cred.value = null
  await saveZentaoCred(sessionToken.value, null)
}

function disconnect() {
  localStorage.removeItem(FLAG_KEY)
  cred.value = null
  saveZentaoCred(sessionToken.value, null)
  saveZentaoConfig(null)
  tasks.value = []
  agentSummary.value = ''
  phase.value = 'idle'
  ztCloseWindow()
}

// ---- Web 预览兜底：账号密码直连 ----
const config = ref(loadZentaoConfig())
const account = ref(config.value?.account ?? '')
const password = ref('')
const token = ref('')
const connecting = ref(false)

async function connectWeb() {
  if (!account.value || !password.value) {
    ElMessage.warning('请填写禅道账号和密码')
    return
  }
  connecting.value = true
  try {
    token.value = await zentaoLogin(account.value, password.value)
    const cfg = { account: account.value, password: password.value }
    saveZentaoConfig(cfg)
    config.value = loadZentaoConfig()
    password.value = ''
    await loadTasksWeb()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '禅道连接失败')
  } finally {
    connecting.value = false
  }
}

async function loadTasksWeb() {
  if (!token.value) return
  loading.value = true
  try {
    tasks.value = await fetchMyWork(token.value, 'task')
    phase.value = 'ready'
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '禅道数据加载失败')
  } finally {
    loading.value = false
  }
}

function refresh() {
  if (isTauri) connectInteractive()
  else loadTasksWeb()
}

onMounted(async () => {
  if (isTauri) {
    // 先读本机缓存的任务（上次抓取入库的数据），界面秒开
    const cached = await loadCachedTasks(sessionToken.value)
    if (cached.length) {
      tasks.value = cached
      phase.value = 'ready'
    }
    cred.value = await loadZentaoCred(sessionToken.value)
    // 连过一次的会话 cookie 仍在 webview 里 / 有凭据可自动登录 → 静默重读
    if (localStorage.getItem(FLAG_KEY)) connectInteractive()
    // 定时自动刷新，保持任务数据实时
    refreshTimer = setInterval(() => {
      if (phase.value === 'ready') connectInteractive()
    }, REFRESH_MS)
    return
  }
  const cfg = config.value
  if (!cfg || !ZENTAO_API_BASE) return
  try {
    token.value = await zentaoLogin(cfg.account, cfg.password)
    await loadTasksWeb()
  } catch {
    config.value = null
  }
})

onUnmounted(() => clearInterval(refreshTimer))
</script>

<template>
  <el-card shadow="never" class="panel zentao-panel">
    <template #header>
      <div class="panel-head">
        <span class="zt-title">
          <el-icon :size="16" class="zt-icon"><Connection /></el-icon>
          禅道任务
          <el-tag v-if="overdueCount > 0" type="danger" size="small" effect="dark">
            {{ overdueCount }} 个超时
          </el-tag>
        </span>
        <div v-if="phase === 'ready'" class="zt-actions">
          <el-button size="small" text :icon="Refresh" :loading="loading" @click="refresh">
            刷新
          </el-button>
          <el-button size="small" text type="danger" :icon="SwitchButton" @click="disconnect">
            断开
          </el-button>
        </div>
      </div>
    </template>

    <template v-if="!ZENTAO_API_BASE">
      <div class="zt-empty">
        尚未配置禅道服务地址，请在 <code>src/config/zentao.ts</code> 中填写
        <code>ZENTAO_API_BASE</code>
      </div>
    </template>

    <template v-else-if="isTauri">
      <!-- 桌面端：智能体接管连接 -->
      <div v-if="phase === 'idle'" class="zt-idle">
        <template v-if="cred">
          <span class="zt-hint">
            已绑定 <b>{{ cred.account }}</b>，智能体可自动登录
            <el-button size="small" text type="danger" @click="unbind">解绑</el-button>
          </span>
          <el-button type="primary" :icon="MagicStick" @click="connectInteractive">
            连接禅道
          </el-button>
        </template>
        <template v-else>
          <div class="zt-bind">
            <span class="zt-hint">绑定禅道账号后，智能体可自动登录读取任务</span>
            <div class="zt-bind-form">
              <el-input v-model="bindAccount" placeholder="禅道账号" class="zt-input" />
              <el-input
                v-model="bindPassword"
                type="password"
                show-password
                placeholder="禅道密码"
                class="zt-input"
                @keyup.enter="bindAndConnect"
              />
              <el-button type="primary" :icon="MagicStick" @click="bindAndConnect">
                绑定并连接
              </el-button>
              <el-button text @click="connectInteractive">暂不绑定</el-button>
            </div>
          </div>
        </template>
      </div>
      <div v-else-if="phase === 'running'" class="zt-running">
        <div class="zt-status">
          <el-icon class="is-loading"><Loading /></el-icon>
          智能体执行中…
          <el-button size="small" text @click="cancelAgent">取消</el-button>
        </div>
        <ul class="zt-steps">
          <li v-for="(s, i) in agentSteps" :key="i">
            {{ s.text }}<span v-if="s.n > 1" class="zt-step-n"> ×{{ s.n }}</span>
          </li>
        </ul>
      </div>
    </template>

    <template v-else>
      <!-- Web 预览：账号密码直连 -->
      <div v-if="phase !== 'ready'" class="zt-login">
        <el-input v-model="account" placeholder="禅道账号" class="zt-input" />
        <el-input
          v-model="password"
          type="password"
          show-password
          placeholder="禅道密码"
          class="zt-input"
          @keyup.enter="connectWeb"
        />
        <el-button type="primary" :icon="Link" :loading="connecting" @click="connectWeb">
          连接禅道
        </el-button>
      </div>
    </template>

    <!-- 任务列表 -->
    <div v-if="phase === 'ready'" v-loading="loading" class="zt-list">
      <div v-if="agentSummary" class="zt-summary">{{ agentSummary }}</div>
      <el-empty v-if="!loading && tasks.length === 0" description="没有指派给你的任务" />
      <div
        v-for="t in sortedTasks"
        :key="t.id"
        class="zt-row"
        :class="{ overdue: isOverdue(t) }"
      >
        <el-tag
          size="small"
          :type="PRI_COLORS[String(t.pri)] ?? 'info'"
          effect="plain"
          class="zt-pri"
        >
          P{{ t.pri ?? '?' }}
        </el-tag>
        <span class="zt-name" :title="t.name">#{{ t.id }} {{ t.name }}</span>
        <el-tag
          v-if="t.status && STATUS_MAP[t.status]"
          size="small"
          :type="STATUS_MAP[t.status].type"
          effect="light"
        >
          {{ STATUS_MAP[t.status].label }}
        </el-tag>
        <span v-if="isOverdue(t)" class="zt-overdue">超时 {{ overdueDays(t) }} 天</span>
        <span class="zt-deadline" :class="{ 'is-overdue': isOverdue(t) }">
          截止 {{ t.deadline && t.deadline !== '0000-00-00' ? t.deadline : '—' }}
        </span>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.zt-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.zt-icon {
  color: var(--el-color-primary);
}

.zt-idle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.zt-bind {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.zt-bind-form {
  display: flex;
  gap: 10px;
  align-items: center;
}

.zt-hint {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.zt-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  padding: 8px 0;
}

.zt-steps {
  margin: 0;
  padding: 4px 0 4px 24px;
  list-style: none;
}

.zt-steps li {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  line-height: 1.9;
}

.zt-step-n {
  color: var(--el-color-primary);
}

.zt-summary {
  margin-bottom: 10px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-8);
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
}

.zt-login {
  display: flex;
  gap: 10px;
  align-items: center;
}

.zt-input {
  width: 180px;
}

.zt-empty {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.zt-empty code {
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 4px;
}

.zt-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.zt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.zt-row:last-child {
  border-bottom: none;
}

.zt-row.overdue {
  background: var(--el-color-danger-light-9);
  border-left: 3px solid var(--el-color-danger);
}

.zt-pri {
  flex-shrink: 0;
}

.zt-name {
  flex: 1;
  font-size: 13px;
  color: var(--el-text-color-regular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zt-overdue {
  color: var(--el-color-danger);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.zt-deadline {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  flex-shrink: 0;
}

.zt-deadline.is-overdue {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
