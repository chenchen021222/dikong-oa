<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import {
  getMailSettings,
  saveMailSettings,
  sendMailNow,
  type MailSettings,
  type MailUser,
} from '@/services/mail'
import { syncZentaoCred } from '@/services/zentao'

const auth = useAuthStore()
const loading = ref(false)
const saving = ref(false)
const sending = ref(false)
const users = ref<MailUser[]>([])
const selected = ref<number[]>([])
const smtpReady = ref(false)
const smtpFrom = ref('')
const lastAutoDate = ref('')
const lastResult = ref<MailSettings['lastResult']>(null)

const form = reactive({
  time: '09:00',
  weekdaysOnly: true,
  includeOverdue: true,
  includeDueToday: true,
  sendEmpty: false,
  mode: 'manual' as 'auto' | 'manual',
})

const readyCount = computed(
  () => users.value.filter((user) => selected.value.includes(user.id) && canSend(user)).length,
)
const selectedCount = computed(() => selected.value.length)

function token() {
  return auth.session?.tokens.access_token ?? ''
}

function canSend(user: MailUser) {
  return Boolean(user.email?.trim() && user.zentaoBound)
}

function apply(data: MailSettings) {
  form.mode = data.mode
  form.time = data.time || '09:00'
  form.weekdaysOnly = data.weekdaysOnly
  form.includeOverdue = data.includeOverdue
  form.includeDueToday = data.includeDueToday
  form.sendEmpty = data.sendEmpty
  users.value = data.users
  selected.value = data.userIds.slice()
  smtpReady.value = data.smtpReady
  smtpFrom.value = data.smtpFrom
  lastAutoDate.value = data.lastAutoDate
  lastResult.value = data.lastResult
}

function draft() {
  return {
    mode: form.mode,
    time: form.time,
    weekdaysOnly: form.weekdaysOnly,
    includeOverdue: form.includeOverdue,
    includeDueToday: form.includeDueToday,
    sendEmpty: form.sendEmpty,
    userIds: selected.value.slice(),
  }
}

async function load() {
  loading.value = true
  try {
    apply(await getMailSettings(token()))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载设置失败')
  } finally {
    loading.value = false
  }
}

function validate(): string | null {
  if (!/^\d{2}:\d{2}$/.test(form.time)) return '请填写发送时间'
  if (!form.includeOverdue && !form.includeDueToday) return '请至少选择一种提醒内容'
  if (form.mode === 'auto' && !selected.value.length) return '自动发送需要先勾选收件人'
  return null
}

async function save(quiet = false) {
  const message = validate()
  if (message) {
    ElMessage.warning(message)
    return false
  }
  saving.value = true
  try {
    apply(await saveMailSettings(token(), draft()))
    if (!quiet) ElMessage.success(form.mode === 'auto' ? '已保存，到点后会自动发送' : '设置已保存')
    return true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
    return false
  } finally {
    saving.value = false
  }
}

async function sendNow() {
  if (!selected.value.length) {
    ElMessage.warning('请先勾选收件人')
    return
  }
  if (!smtpReady.value) {
    ElMessage.warning('邮件服务器尚未配置，暂时无法发信')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将按当前设置向已勾选的 ${selectedCount.value} 人发送禅道任务提醒。没有邮箱或未绑定禅道的人会被跳过。`,
      '立即发送',
      { type: 'warning', confirmButtonText: '发送' },
    )
  } catch {
    return
  }
  const saved = await save(true)
  if (!saved) return
  sending.value = true
  try {
    apply(await sendMailNow(token()))
    const result = lastResult.value
    if (!result) return
    if (result.failed) ElMessage.warning(`已发送 ${result.sent} 封，失败 ${result.failed} 人`)
    else ElMessage.success(`已发送 ${result.sent} 封，跳过 ${result.skipped} 人`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发送失败')
  } finally {
    sending.value = false
  }
}

function toggle(id: number, checked: boolean | string | number) {
  const on = checked === true
  selected.value = on
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((item) => item !== id)
}

function toggleAll(checked: boolean | string | number) {
  selected.value = checked === true ? users.value.map((user) => user.id) : []
}

function statusText(status: string) {
  if (status === 'sent') return '已发送'
  if (status === 'failed') return '失败'
  return '跳过'
}

onMounted(async () => {
  const userId = auth.session?.user?.id
  await syncZentaoCred(
    token(),
    typeof userId === 'string' || typeof userId === 'number' ? userId : undefined,
  ).catch(() => {})
  await load()
})
</script>

<template>
  <div v-loading="loading" class="settings">
    <div class="toolbar">
      <div>
        <h2>系统设置</h2>
        <p>配置禅道任务提醒邮件。只有管理员可以看到本页。</p>
      </div>
    </div>

    <el-alert
      v-if="!smtpReady"
      type="warning"
      show-icon
      :closable="false"
      title="邮件服务器尚未配置，可以先保存收件人和时间，但现在还不能真正发出邮件。"
    />
    <el-alert
      v-else
      type="info"
      show-icon
      :closable="false"
      :title="`发信账号：${smtpFrom}`"
    />

    <el-card shadow="never">
      <template #header>提醒内容与时间</template>
      <el-form label-width="108px">
        <el-form-item label="发送时间">
          <el-time-picker
            v-model="form.time"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="选择时间"
            :clearable="false"
          />
          <span class="hint">按北京时间。若保存时今天的时间点已过，则从下一次开始；服务中断不超过 3 小时会补发一次。</span>
        </el-form-item>
        <el-form-item label="发送日期">
          <el-switch v-model="form.weekdaysOnly" active-text="仅工作日" inactive-text="每天都发" />
        </el-form-item>
        <el-form-item label="提醒内容">
          <el-checkbox v-model="form.includeOverdue">已超时任务</el-checkbox>
          <el-checkbox v-model="form.includeDueToday">今日到期任务</el-checkbox>
        </el-form-item>
        <el-form-item label="空邮件">
          <el-switch
            v-model="form.sendEmpty"
            active-text="没有待提醒任务也发送"
            inactive-text="没有待提醒任务则不发送"
          />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <template #header>
        收件人
        <span class="header-extra">已选 {{ selectedCount }} 人，其中 {{ readyCount }} 人现在可以收到</span>
      </template>
      <p class="card-tip">邮件发到用户资料里的邮箱。禅道账号要由本人登录后写入服务器；对方用绑定过的浏览器打开本系统，这里才会变成可发送。</p>
      <el-table :data="users" class="table">
        <el-table-column width="54">
          <template #header>
            <el-checkbox
              :model-value="users.length > 0 && selectedCount === users.length"
              :indeterminate="selectedCount > 0 && selectedCount < users.length"
              @change="toggleAll"
            />
          </template>
          <template #default="{ row }">
            <el-checkbox :model-value="selected.includes(row.id)" @change="toggle(row.id, $event)" />
          </template>
        </el-table-column>
        <el-table-column prop="display_name" label="姓名" min-width="120" />
        <el-table-column prop="username" label="用户名" min-width="120" />
        <el-table-column prop="email" label="邮箱" min-width="200">
          <template #default="{ row }">{{ row.email || '—' }}</template>
        </el-table-column>
        <el-table-column label="状态" min-width="180">
          <template #default="{ row }">
            <el-tag v-if="canSend(row)" type="success" effect="plain">可发送</el-tag>
            <el-tag v-if="!row.email" type="warning" effect="plain">无邮箱</el-tag>
            <el-tag v-if="!row.zentaoBound" type="warning" effect="plain">未绑定禅道</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never">
      <template #header>发送方式</template>
      <el-radio-group v-model="form.mode" class="mode">
        <el-radio value="auto" border>自动定时发送</el-radio>
        <el-radio value="manual" border>手动发送</el-radio>
      </el-radio-group>
      <p class="card-tip">
        <template v-if="form.mode === 'auto'">
          保存后，{{ form.weekdaysOnly ? '每个工作日' : '每天' }} {{ form.time }} 向已勾选的用户发送。
          <template v-if="lastAutoDate">今天已经自动发送过。</template>
        </template>
        <template v-else>不会自动发信，需要在本页点击「立即发送」。</template>
      </p>
      <div class="actions">
        <el-button :loading="saving" @click="save">保存设置</el-button>
        <el-button type="primary" :loading="sending" :disabled="!smtpReady" @click="sendNow">
          立即发送
        </el-button>
      </div>
    </el-card>

    <el-card v-if="lastResult" shadow="never">
      <template #header>
        上次发送 · {{ lastResult.at }} · {{ lastResult.trigger === 'auto' ? '自动' : '手动' }}
        · 成功 {{ lastResult.sent }} / 跳过 {{ lastResult.skipped }} / 失败 {{ lastResult.failed }}
      </template>
      <el-table :data="lastResult.lines" class="table">
        <el-table-column prop="name" label="用户" min-width="120" />
        <el-table-column prop="email" label="邮箱" min-width="200" />
        <el-table-column label="结果" width="100">
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'sent' ? 'success' : row.status === 'failed' ? 'danger' : 'info'"
              effect="plain"
            >
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="detail" label="说明" min-width="220" />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
}

.toolbar p,
.card-tip,
.hint {
  margin: 0;
  color: #646a73;
  font-size: 13px;
}

.hint {
  margin-left: 12px;
}

.header-extra {
  margin-left: 12px;
  color: #646a73;
  font-size: 13px;
  font-weight: 400;
}

.mode {
  display: flex;
  gap: 12px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.table {
  border-radius: 12px;
  overflow: hidden;
}

.card-tip {
  margin-bottom: 12px;
}
</style>
