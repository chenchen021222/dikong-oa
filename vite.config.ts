import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import localDbApi from './vite.local-db'
import { SCORE_API_BASE } from './src/config/score'
import { ZENTAO_API_BASE } from './src/config/zentao'

export default defineConfig({
  plugins: [vue(), localDbApi()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri dev 要求固定端口
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Web 开发环境经代理访问内网绩效服务（15050），避免跨域；生产环境走管理员电脑代理
      '/score-api': {
        target: SCORE_API_BASE,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/score-api/, ''),
      },
      // 禅道同理；地址见 src/config/zentao.ts，未配置时不挂代理
      ...(ZENTAO_API_BASE
        ? {
            '/zentao-api': {
              target: ZENTAO_API_BASE,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/zentao-api/, ''),
            },
          }
        : {}),
    },
  },
})
