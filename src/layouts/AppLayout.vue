<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowDown,
  Bell,
  Calendar,
  Checked,
  Document,
  Setting,
  SwitchButton,
  User,
  UserFilled,
} from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const pageTitle = computed(() => (route.meta.title as string) ?? '工作台')
const activeMenu = computed(() => {
  if (route.name === 'users') return 'users'
  if (route.name === 'home') return 'dashboard'
  return ''
})
const avatarText = computed(() => auth.displayName.charAt(0).toUpperCase())

const menuRoutes: Record<string, string> = {
  dashboard: '/',
  users: '/users',
}

function onMenuSelect(index: string) {
  const target = menuRoutes[index]
  if (target) router.push(target)
  else ElMessage.info('模块建设中，敬请期待')
}

function onUserCommand(command: string) {
  if (command === 'profile') router.push('/profile')
  else if (command === 'logout') {
    auth.logout()
    router.replace('/login')
  }
}
</script>

<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="logo">
        <span class="logo-mark">地</span>
        <span class="logo-text">DiKong OA</span>
      </div>
      <el-menu :default-active="activeMenu" class="menu" @select="onMenuSelect">
        <el-menu-item index="dashboard">
          <el-icon><Checked /></el-icon>工作台
        </el-menu-item>
        <el-menu-item index="approval">
          <el-icon><Document /></el-icon>审批中心
        </el-menu-item>
        <el-menu-item index="attendance">
          <el-icon><Calendar /></el-icon>考勤管理
        </el-menu-item>
        <el-menu-item v-if="auth.isAdmin" index="users">
          <el-icon><UserFilled /></el-icon>用户管理
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon>系统设置
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">
        <span class="page-title">{{ pageTitle }}</span>
        <div class="header-right">
          <el-badge :value="3" class="notify">
            <el-icon :size="18"><Bell /></el-icon>
          </el-badge>
          <el-dropdown trigger="click" @command="onUserCommand">
            <span class="user-entry">
              <span class="avatar">{{ avatarText }}</span>
              {{ auth.displayName }}
              <el-icon :size="12"><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile" :icon="User">个人中心</el-dropdown-item>
                <el-dropdown-item command="logout" :icon="SwitchButton" divided>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.aside {
  background: linear-gradient(180deg, #111c3e 0%, #0c142b 100%);
  display: flex;
  flex-direction: column;
}

.logo {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #fff;
}

.logo-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, #3370ff, #6aa5ff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
  box-shadow: 0 2px 8px rgba(51, 112, 255, 0.4);
}

.logo-text {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.menu {
  border-right: none;
  background: transparent;
  padding: 8px;
}

.menu :deep(.el-menu-item) {
  height: 44px;
  margin-bottom: 4px;
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.62);
  transition: all 0.2s;
}

.menu :deep(.el-menu-item:hover) {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}

.menu :deep(.el-menu-item.is-active) {
  color: #fff;
  background: var(--el-color-primary);
  box-shadow: 0 2px 8px rgba(51, 112, 255, 0.35);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.page-title {
  font-size: 16px;
  font-weight: 600;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
}

.notify {
  cursor: pointer;
}

.user-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  outline: none;
}

.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.main {
  background: var(--el-bg-color-page);
  padding: 24px;
}
</style>
