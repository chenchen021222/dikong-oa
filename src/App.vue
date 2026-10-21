<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { initDesktopAuth, isTauri } from '@/services/auth'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

let unlisten: (() => void) | undefined

onMounted(async () => {
  if (!isTauri) return
  // 注册深链回调：SSO 完成后浏览器跳回 dikong://auth/callback
  unlisten = await initDesktopAuth((session, error) => {
    auth.onLoginResult(session, error)
    if (session) router.replace('/')
  })
})

onUnmounted(() => unlisten?.())
</script>

<template>
  <router-view />
</template>
