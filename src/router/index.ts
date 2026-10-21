import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LoginView from '@/views/LoginView.vue'
import AuthCallback from '@/views/AuthCallback.vue'
import AppLayout from '@/layouts/AppLayout.vue'
import HomeView from '@/views/HomeView.vue'
import ProfileView from '@/views/ProfileView.vue'
import UsersView from '@/views/UsersView.vue'

const router = createRouter({
  // 打包进 Tauri 时使用 hash 模式避免文件协议路由问题；
  // 这里用 history 模式 + tauri.conf.json 中 frontendDist 适配即可
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    { path: '/auth/callback', name: 'callback', component: AuthCallback, meta: { public: true } },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', name: 'home', component: HomeView, meta: { title: '工作台' } },
        { path: 'profile', name: 'profile', component: ProfileView, meta: { title: '个人中心' } },
        {
          path: 'users',
          name: 'users',
          component: UsersView,
          meta: { title: '用户管理', admin: true },
        },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  await auth.ensureFreshToken().catch(() => null)
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  if (auth.session?.providerId === 'local') await auth.refreshMe().catch(() => null)
  if (to.meta.admin && !auth.isAdmin) return { name: 'home' }
  // 本地账号首次登录先完善资料（手机号 + 邮箱），否则一律拦到个人中心
  if (
    auth.session?.providerId === 'local' &&
    !auth.isProfileComplete &&
    to.name !== 'profile'
  ) {
    return { name: 'profile', query: { complete: '1' } }
  }
  return true
})

export default router
