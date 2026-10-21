<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { completeLogin } from '@/services/auth'
import { useAuthStore } from '@/stores/auth'

// Web 模式下 IdP 会重定向到本站 /auth/callback，由这里完成 code 换 token
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    const session = await completeLogin(location.href)
    auth.onLoginResult(session)
    router.replace((route.query.redirect as string) ?? '/')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    auth.onLoginResult(null, e instanceof Error ? e : undefined)
  }
})
</script>

<template>
  <div class="callback-page">
    <el-result v-if="error" icon="error" title="登录失败" :sub-title="error">
      <template #extra>
        <el-button type="primary" @click="router.replace('/login')">返回登录</el-button>
      </template>
    </el-result>
    <div v-else v-loading="true" class="loading-box">正在完成登录…</div>
  </div>
</template>

<style scoped>
.callback-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.loading-box {
  width: 240px;
  height: 120px;
}
</style>
