<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '@/stores/auth'
import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  type AccountRow,
} from '@/services/users'

const auth = useAuthStore()
const router = useRouter()
const rows = ref<AccountRow[]>([])
const loading = ref(false)
const saving = ref(false)
const dialog = ref(false)
const editingId = ref<number | null>(null)

const form = reactive({
  username: '',
  password: '',
  displayName: '',
  phone: '',
  email: '',
  role: 'user' as 'admin' | 'user',
})

function token() {
  return auth.session?.tokens.access_token ?? ''
}

function resetForm() {
  form.username = ''
  form.password = ''
  form.displayName = ''
  form.phone = ''
  form.email = ''
  form.role = 'user'
}

async function load() {
  loading.value = true
  try {
    rows.value = await listAccounts(token())
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载用户失败')
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  resetForm()
  dialog.value = true
}

function openEdit(row: AccountRow) {
  editingId.value = row.id
  form.username = row.username
  form.password = ''
  form.displayName = row.display_name ?? ''
  form.phone = row.phone ?? ''
  form.email = row.email ?? ''
  form.role = row.role === 'admin' ? 'admin' : 'user'
  dialog.value = true
}

function validate(): string | null {
  if (form.phone && !/^1[3-9]\d{9}$/.test(form.phone)) return '手机号格式不正确'
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return '邮箱格式不正确'
  if (!editingId.value) {
    if (!/^[A-Za-z0-9_]{2,32}$/.test(form.username)) return '用户名需为 2-32 位字母、数字或下划线'
    if (form.password.length < 6) return '密码至少 6 位'
  } else if (form.password && form.password.length < 6) {
    return '新密码至少 6 位，留空则不修改'
  }
  if (!form.displayName.trim()) return '请填写姓名'
  return null
}

async function afterChange(saved?: AccountRow) {
  const selfId = Number(auth.session?.user?.id)
  if (saved && saved.id === selfId) {
    await auth.refreshMe()
    if (!auth.isAdmin) {
      ElMessage.warning('当前账号已不再是管理员')
      router.replace({ name: 'home' })
      return
    }
  }
  await load()
}

async function save() {
  const message = validate()
  if (message) {
    ElMessage.warning(message)
    return
  }
  saving.value = true
  try {
    const saved = editingId.value
      ? await updateAccount(token(), {
          id: editingId.value,
          displayName: form.displayName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          role: form.role,
          password: form.password,
        })
      : await createAccount(token(), {
          username: form.username.trim(),
          password: form.password,
          displayName: form.displayName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          role: form.role,
        })
    dialog.value = false
    ElMessage.success(editingId.value ? '账号已更新' : '账号已创建')
    await afterChange(saved)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function toggleAdmin(row: AccountRow) {
  const next = row.role === 'admin' ? 'user' : 'admin'
  const action = next === 'admin' ? '设为管理员' : '取消管理员'
  try {
    await ElMessageBox.confirm(`确定将「${row.username}」${action}？`, '授权账号', {
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    const saved = await updateAccount(token(), {
      id: row.id,
      displayName: row.display_name ?? '',
      phone: row.phone ?? '',
      email: row.email ?? '',
      role: next,
    })
    ElMessage.success(next === 'admin' ? '已授予管理员' : '已取消管理员')
    await afterChange(saved)
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '授权失败')
  }
}

async function remove(row: AccountRow) {
  try {
    await ElMessageBox.confirm(
      `删除后「${row.username}」将无法登录，关联的会话和禅道缓存一并清除。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '删除', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  try {
    await deleteAccount(token(), row.id)
    ElMessage.success('账号已删除')
    await load()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
}

function isSelf(row: AccountRow) {
  return row.id === Number(auth.session?.user?.id)
}

onMounted(load)
</script>

<template>
  <div class="users">
    <div class="toolbar">
      <div>
        <h2>用户管理</h2>
        <p>新增、编辑、删除账号，以及授予或取消管理员权限。密码只在创建或重置时填写，列表中不显示。</p>
      </div>
      <el-button type="primary" @click="openCreate">新增账号</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" class="table">
      <el-table-column prop="username" label="用户名" min-width="120" />
      <el-table-column prop="display_name" label="姓名" min-width="120" />
      <el-table-column prop="phone" label="手机" min-width="130" />
      <el-table-column prop="email" label="邮箱" min-width="180" />
      <el-table-column label="权限" width="110">
        <template #default="{ row }">
          <el-tag :type="row.role === 'admin' ? 'primary' : 'info'" effect="plain">
            {{ row.role === 'admin' ? '管理员' : '普通用户' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="created_at" label="创建时间" min-width="170" />
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="toggleAdmin(row)">
            {{ row.role === 'admin' ? '取消管理员' : '设为管理员' }}
          </el-button>
          <el-button link type="danger" :disabled="isSelf(row)" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialog"
      :title="editingId ? '编辑账号' : '新增账号'"
      width="480px"
      destroy-on-close
    >
      <el-form label-width="88px">
        <el-form-item label="用户名">
          <el-input v-model="form.username" :disabled="!!editingId" placeholder="字母、数字或下划线" />
        </el-form-item>
        <el-form-item :label="editingId ? '新密码' : '密码'">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            :placeholder="editingId ? '留空则不修改' : '至少 6 位'"
          />
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="form.displayName" />
        </el-form-item>
        <el-form-item label="手机">
          <el-input v-model="form.phone" maxlength="11" />
        </el-form-item>
        <el-form-item label="邮箱">
          <el-input v-model="form.email" />
        </el-form-item>
        <el-form-item label="授权">
          <el-radio-group v-model="form.role">
            <el-radio value="user">普通用户</el-radio>
            <el-radio value="admin">管理员</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.users {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toolbar h2 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
}

.toolbar p {
  margin: 0;
  color: #646a73;
  font-size: 13px;
}

.table {
  border-radius: 12px;
  overflow: hidden;
}
</style>
