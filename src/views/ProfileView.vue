<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

// 完善资料模式下，两项都补齐后自动进入工作台
function maybeDone() {
  if (route.query.complete === '1' && auth.isProfileComplete) router.replace({ name: 'home' })
}

const username = computed(() => (auth.session?.user?.username as string) ?? '—')
const phone = computed(() => (auth.session?.user?.phone as string) ?? '')
const email = computed(() => (auth.session?.user?.email as string) ?? '')
// 登录后被路由守卫引导过来完善资料
const mustComplete = computed(
  () => route.query.complete === '1' && !auth.isProfileComplete,
)
const providerName = computed(() =>
  auth.session?.providerId === 'local' ? '本地账号' : (auth.session?.providerId ?? '—'),
)
const canChangePassword = computed(() => auth.session?.providerId === 'local')
const avatarText = computed(() => auth.displayName.charAt(0).toUpperCase())

// 昵称编辑
const editing = ref(false)
const draftName = ref('')
const saving = ref(false)

function startEdit() {
  draftName.value = auth.displayName
  editing.value = true
}

async function saveName() {
  const name = draftName.value.trim()
  if (!name) {
    ElMessage.warning('昵称不能为空')
    return
  }
  saving.value = true
  try {
    await auth.updateDisplayName(name)
    editing.value = false
    ElMessage.success('昵称已更新')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

// 手机号绑定
const editingPhone = ref(false)
const draftPhone = ref('')
const savingPhone = ref(false)

function startEditPhone() {
  draftPhone.value = phone.value
  editingPhone.value = true
}

async function savePhone() {
  const p = draftPhone.value.trim()
  if (p && !/^1[3-9]\d{9}$/.test(p)) {
    ElMessage.warning('手机号格式不正确')
    return
  }
  savingPhone.value = true
  try {
    await auth.updatePhone(p)
    editingPhone.value = false
    ElMessage.success(p ? '手机号已绑定' : '已解绑手机号')
    maybeDone()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingPhone.value = false
  }
}

// 邮箱绑定
const editingEmail = ref(false)
const draftEmail = ref('')
const savingEmail = ref(false)

function startEditEmail() {
  draftEmail.value = email.value
  editingEmail.value = true
}

async function saveEmail() {
  const m = draftEmail.value.trim()
  if (m && !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(m)) {
    ElMessage.warning('邮箱格式不正确')
    return
  }
  savingEmail.value = true
  try {
    await auth.updateEmail(m)
    editingEmail.value = false
    ElMessage.success(m ? '邮箱已绑定' : '已解绑邮箱')
    maybeDone()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingEmail.value = false
  }
}

// 完善资料模式：缺失的字段直接展开编辑
if (mustComplete.value) {
  if (!phone.value) editingPhone.value = true
  if (!email.value) editingEmail.value = true
}

// 修改密码
const pwdDialog = ref(false)
const pwdForm = ref({ old: '', next: '', confirm: '' })
const pwdLoading = ref(false)

async function submitPassword() {
  const { old, next, confirm } = pwdForm.value
  if (!old || !next) {
    ElMessage.warning('请填写完整')
    return
  }
  if (next !== confirm) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }
  pwdLoading.value = true
  try {
    await auth.changePassword(old, next)
    pwdDialog.value = false
    pwdForm.value = { old: '', next: '', confirm: '' }
    ElMessage.success('密码已修改')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '修改失败')
  } finally {
    pwdLoading.value = false
  }
}
</script>

<template>
  <div class="profile">
    <el-alert
      v-if="mustComplete"
      type="warning"
      :closable="false"
      title="请先完善个人信息"
      description="首次使用需要绑定手机号和邮箱，完善后才能进入工作台。"
      class="complete-alert"
    />
    <el-card shadow="never" class="card">
      <template #header>基本信息</template>
      <div class="info-row">
        <div class="avatar-lg">{{ avatarText }}</div>
        <div class="info-main">
          <div class="name-line">
            <template v-if="editing">
              <el-input
                v-model="draftName"
                size="small"
                maxlength="20"
                class="name-input"
                @keyup.enter="saveName"
              />
              <el-button size="small" type="primary" :loading="saving" @click="saveName">
                保存
              </el-button>
              <el-button size="small" @click="editing = false">取消</el-button>
            </template>
            <template v-else>
              <span class="display-name">{{ auth.displayName }}</span>
              <el-button size="small" text type="primary" @click="startEdit">编辑</el-button>
            </template>
          </div>
          <el-descriptions :column="1" size="small" class="desc">
            <el-descriptions-item label="登录账号">{{ username }}</el-descriptions-item>
            <el-descriptions-item label="登录方式">{{ providerName }}</el-descriptions-item>
            <el-descriptions-item label="手机号">
              <template v-if="editingPhone">
                <el-input
                  v-model="draftPhone"
                  size="small"
                  maxlength="11"
                  placeholder="11 位手机号"
                  class="phone-input"
                  @keyup.enter="savePhone"
                />
                <el-button size="small" type="primary" :loading="savingPhone" @click="savePhone">
                  保存
                </el-button>
                <el-button size="small" @click="editingPhone = false">取消</el-button>
              </template>
              <template v-else>
                {{ phone || '未绑定' }}
                <el-button size="small" text type="primary" @click="startEditPhone">
                  {{ phone ? '修改' : '绑定' }}
                </el-button>
              </template>
            </el-descriptions-item>
            <el-descriptions-item label="邮箱">
              <template v-if="editingEmail">
                <el-input
                  v-model="draftEmail"
                  size="small"
                  placeholder="name@example.com"
                  class="email-input"
                  @keyup.enter="saveEmail"
                />
                <el-button size="small" type="primary" :loading="savingEmail" @click="saveEmail">
                  保存
                </el-button>
                <el-button size="small" @click="editingEmail = false">取消</el-button>
              </template>
              <template v-else>
                {{ email || '未绑定' }}
                <el-button size="small" text type="primary" @click="startEditEmail">
                  {{ email ? '修改' : '绑定' }}
                </el-button>
              </template>
            </el-descriptions-item>
          </el-descriptions>
        </div>
      </div>
    </el-card>

    <el-card v-if="canChangePassword" shadow="never" class="card">
      <template #header>账号安全</template>
      <div class="security-row">
        <div>
          <div class="sec-title">登录密码</div>
          <div class="sec-desc">定期修改密码可以保护账号安全</div>
        </div>
        <el-button @click="pwdDialog = true">修改密码</el-button>
      </div>
    </el-card>

    <el-dialog v-model="pwdDialog" title="修改密码" width="420px">
      <el-form label-width="80px">
        <el-form-item label="原密码">
          <el-input v-model="pwdForm.old" type="password" show-password />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input v-model="pwdForm.next" type="password" show-password />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input v-model="pwdForm.confirm" type="password" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdDialog = false">取消</el-button>
        <el-button type="primary" :loading="pwdLoading" @click="submitPassword">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.profile {
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.info-row {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.avatar-lg {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.info-main {
  flex: 1;
}

.name-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}

.name-input {
  width: 200px;
}

.complete-alert {
  margin-bottom: 4px;
}

.phone-input,
.email-input {
  width: 180px;
  margin-right: 8px;
}

.display-name {
  font-size: 18px;
  font-weight: 600;
}

.desc {
  margin-top: 12px;
}

.security-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sec-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.sec-desc {
  color: #909399;
  font-size: 13px;
}
</style>
