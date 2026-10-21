<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Lock, User } from '@element-plus/icons-vue'
import { providers } from '@/config/auth'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const username = ref('')
const password = ref('')

async function submitLocal() {
  if (await auth.loginLocal(username.value, password.value)) {
    router.replace((route.query.redirect as string) ?? '/')
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card">
      <div class="brand">
        <h1>DiKong OA</h1>
        <p>企业办公平台</p>
      </div>

      <el-alert
        v-if="auth.error"
        :title="auth.error"
        type="error"
        show-icon
        :closable="false"
        class="login-error"
      />

      <el-form @submit.prevent="submitLocal">
        <el-form-item>
          <el-input v-model="username" placeholder="账号" :prefix-icon="User" size="large" />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="password"
            type="password"
            placeholder="密码"
            show-password
            :prefix-icon="Lock"
            size="large"
            @keyup.enter="submitLocal"
          />
        </el-form-item>
        <el-button
          type="primary"
          size="large"
          class="login-btn"
          :loading="auth.loggingIn"
          native-type="submit"
        >
          账号登录
        </el-button>
      </el-form>

      <el-divider class="divider">或使用企业 SSO</el-divider>

      <el-button
        v-for="p in providers"
        :key="p.id"
        size="large"
        class="login-btn"
        :loading="auth.loggingIn"
        @click="auth.login(p.id)"
      >
        {{ p.name }}
      </el-button>

      <p class="hint">本地账号验证存储于本机 SQLite 数据库</p>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(ellipse at 20% 20%, rgba(106, 165, 255, 0.35), transparent 55%),
    linear-gradient(135deg, #101b3c 0%, #1d39c4 60%, #3370ff 100%);
}

.login-card {
  width: 380px;
  text-align: center;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(13, 20, 43, 0.35);
}

.brand h1 {
  margin: 0 0 4px;
  font-size: 28px;
  color: #303133;
}

.brand p {
  margin: 0 0 24px;
  color: #909399;
}

.login-error {
  margin-bottom: 16px;
  text-align: left;
}

.login-btn {
  width: 100%;
  margin: 0 0 12px;
}

.divider {
  margin: 20px 0 16px;
}

.hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: #909399;
}
</style>
