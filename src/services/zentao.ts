import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ZENTAO_API_BASE, ZENTAO_API_PREFIX, type ZentaoWorkMode } from '@/config/zentao'
import { isTauri, useRemoteDb, webDb } from './auth'
import type { AgentToolDef } from './agent'

/** 禅道任务/事项（字段以实际返回为准，这里列常用的） */
export interface ZentaoItem {
  id: number
  name: string
  pri?: number | string
  status?: string
  deadline?: string
  estimate?: number
  consumed?: number
  left?: number
  assignedTo?: { account?: string; realname?: string } | string
  execution?: { id?: number; name?: string } | number
  project?: { id?: number; name?: string } | number
  [key: string]: unknown
}

const LEGACY_CFG_KEY = 'zentao:config'

export interface ZentaoConfig {
  account: string
  password: string
}

function userCfgKey(userId?: string | number) {
  if (userId == null || userId === '') return null
  return `zentao:config:${userId}`
}

function readCfg(key: string): ZentaoConfig | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ZentaoConfig
    return parsed?.account && parsed?.password ? parsed : null
  } catch {
    return null
  }
}

/** 浏览器里的禅道账号按登录用户分开存，避免后登录的人覆盖前人的绑定 */
export function loadZentaoConfig(userId?: string | number): ZentaoConfig | null {
  const key = userCfgKey(userId)
  if (key) {
    const own = readCfg(key)
    if (own) return own
  }
  return readCfg(LEGACY_CFG_KEY)
}

export function saveZentaoConfig(cfg: ZentaoConfig | null, userId?: string | number) {
  const key = userCfgKey(userId)
  if (key) {
    if (cfg?.account && cfg?.password) localStorage.setItem(key, JSON.stringify(cfg))
    else localStorage.removeItem(key)
  }
  localStorage.removeItem(LEGACY_CFG_KEY)
}

// ---- 凭据存储：单机走本机 SQLite（Tauri invoke / vite 中间件）----
// 配了 DATA_API_BASE 时统一走远程数据服务（见 src/config/server.ts）
const CRED_KEY = 'zentao_cred'
const useInvoke = () => isTauri && !useRemoteDb

function parseCred(raw: string | null | undefined): ZentaoConfig | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ZentaoConfig
    if (!parsed?.account || !parsed?.password) return null
    return parsed
  } catch {
    return null
  }
}

/** 只读服务器（或桌面端数据库）里的禅道凭据，不看浏览器本地缓存 */
export async function loadServerZentaoCred(token: string): Promise<ZentaoConfig | null> {
  try {
    const raw = useInvoke()
      ? await invoke<string | null>('get_user_setting', { token, key: CRED_KEY })
      : (await webDb<{ value: string | null }>(`/setting?token=${encodeURIComponent(token)}&key=${CRED_KEY}`)).value
    return parseCred(raw)
  } catch {
    return null
  }
}

export async function loadZentaoCred(token: string, userId?: string | number): Promise<ZentaoConfig | null> {
  const remote = await loadServerZentaoCred(token)
  return remote ?? loadZentaoConfig(userId)
}

async function writeServerCred(token: string, cfg: ZentaoConfig | null) {
  const value = cfg ? JSON.stringify(cfg) : ''
  if (useInvoke()) {
    await invoke('set_user_setting', { token, key: CRED_KEY, value })
  } else {
    await webDb('/setting', { token, key: CRED_KEY, value })
  }
}

export async function saveZentaoCred(
  token: string,
  cfg: ZentaoConfig | null,
  userId?: string | number,
): Promise<void> {
  await writeServerCred(token, cfg)
  saveZentaoConfig(cfg, userId)
}

/** 把当前登录用户浏览器里的禅道账号补写到他自己的服务器记录。 */
export async function syncZentaoCred(token: string, userId?: string | number): Promise<void> {
  if (!token) return
  const remote = await loadServerZentaoCred(token)
  if (remote) {
    saveZentaoConfig(remote, userId)
    return
  }
  const key = userCfgKey(userId)
  const local = (key ? readCfg(key) : null) ?? readCfg(LEGACY_CFG_KEY)
  if (!local) return
  await saveZentaoCred(token, local, userId)
}

// ---- 任务缓存入库 ----
export async function saveTasksToDb(token: string, items: ZentaoItem[]): Promise<void> {
  if (useInvoke()) await invoke('save_zentao_tasks', { token, tasks: items }).catch(() => {})
  else await webDb('/tasks', { token, tasks: items }).catch(() => {})
}

export async function loadCachedTasks(token: string): Promise<ZentaoItem[]> {
  try {
    return useInvoke()
      ? await invoke<ZentaoItem[]>('list_zentao_tasks', { token })
      : await webDb<ZentaoItem[]>(`/tasks?token=${token}`)
  } catch {
    return []
  }
}

function ensureBase() {
  if (!ZENTAO_API_BASE) {
    throw new Error('未配置禅道地址，请填写 src/config/zentao.ts 中的 ZENTAO_API_BASE')
  }
}

/** 从「我的地盘」响应中防御式提取列表 */
function extractItems(data: unknown, mode: string): ZentaoItem[] {
  const box = (data as Record<string, unknown>)?.[mode] ?? data
  if (Array.isArray(box)) return box
  const plural = (box as Record<string, unknown>)?.[`${mode}s`]
  if (Array.isArray(plural)) return plural
  const list = (box as Record<string, unknown>)?.list
  if (Array.isArray(list)) return list
  return []
}

// 已完结状态：英文 code + 中文标签（老版禅道页面解析出来的是中文）
const CLOSED_STATUSES = new Set(['done', 'closed', 'cancel', '已完成', '已关闭', '已取消'])

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 是否超时：有截止时间、今天已过、且状态未完成 */
export function isOverdue(item: ZentaoItem): boolean {
  const dl = item.deadline
  if (!dl || dl === '0000-00-00') return false
  if (item.status && CLOSED_STATUSES.has(item.status)) return false
  return dl < todayStr()
}

/** 超时天数（未超时返回 0） */
export function overdueDays(item: ZentaoItem): number {
  if (!isOverdue(item)) return 0
  const ms = new Date(todayStr()).getTime() - new Date(item.deadline!).getTime()
  return Math.floor(ms / 86400000)
}

// ================= 方式一：REST token 直连（Web 预览用） =================

// Web 开发环境走 vite 代理避免跨域；Tauri / 生产环境直连
const base = import.meta.env.DEV && !isTauri ? '/zentao-api' : ZENTAO_API_BASE

/** 账号密码换 token */
export async function zentaoLogin(account: string, password: string): Promise<string> {
  ensureBase()
  const res = await fetch(`${base}${ZENTAO_API_PREFIX}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  })
  const text = await res.text()
  let data: { token?: string; error?: string } = {}
  try {
    data = JSON.parse(text)
  } catch {
    // 代理没生效时拿到的是 index.html
    throw new Error(`禅道接口未连通（${res.status}），请检查代理或服务地址`)
  }
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `禅道登录失败: ${res.status}`)
  }
  return data.token
}

/** 拉取「我的地盘」列表（token 方式） */
export async function fetchMyWork(
  token: string,
  mode: ZentaoWorkMode = 'task',
  limit = 100,
): Promise<ZentaoItem[]> {
  ensureBase()
  const res = await fetch(
    `${base}${ZENTAO_API_PREFIX}/user?fields=${mode}&type=assignedTo&limit=${limit}`,
    { headers: { Token: token } },
  )
  if (!res.ok) throw new Error(`禅道请求失败: ${res.status}`)
  return extractItems(await res.json(), mode)
}

// ============ 方式二：交互式（Tauri 桌面端，复用禅道页面登录态） ============

/** 打开禅道窗口：visible=false 静默探测，true 显示给用户登录 */
export async function ztOpenWindow(visible: boolean): Promise<void> {
  ensureBase()
  await invoke('zentao_open', { url: ZENTAO_API_BASE, visible })
}

export async function ztCloseWindow(): Promise<void> {
  await invoke('zentao_close').catch(() => {})
}

/** 在禅道窗口执行脚本，等待其 emit 事件回传结果 */
async function evalAndWait<T>(script: string, eventName: string, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      un.then((u) => u())
      reject(new Error('禅道页面无响应'))
    }, timeoutMs)
    const un = listen<T>(eventName, (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      un.then((u) => u())
      resolve(e.payload)
    })
    invoke('zentao_eval', { script }).catch((e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      un.then((u) => u())
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

// 在禅道页面上下文执行：先调 REST /user（新版），失败则看页面 DOM 是否还是登录页（老版）
const CHECK_JS = `(()=>{const emit=(o)=>window.__TAURI__.event.emit('dk:zt-check',o)
fetch('${ZENTAO_API_PREFIX}/user',{headers:{Accept:'application/json'}})
.then(r=>r.json())
.then(d=>emit({logged:!!(d&&d.account&&!d.error),via:'api'}))
.catch(()=>{try{
const html=document.documentElement?document.documentElement.innerHTML:''
const loading=document.readyState!=='complete'||html.length<1000
const loginPage=/f=login/.test(location.href)||/type=["']password["']/.test(html)||/name=["']account["']/.test(html)
emit({logged:!loading&&!loginPage,via:'dom',url:location.href,loading})
}catch(e){emit({logged:false,via:'dom',error:String(e)})}})})()`

/** 检查禅道窗口当前是否已登录（超时也视为未登录） */
export async function ztCheckLoggedIn(): Promise<boolean> {
  try {
    const r = await evalAndWait<{ logged?: boolean }>(CHECK_JS, 'dk:zt-check')
    console.debug('[zentao-check]', r)
    return !!r.logged
  } catch (e) {
    if (e instanceof Error && e.message === '禅道窗口未打开') throw e
    return false
  }
}

/** 在禅道页面上下文拉取「我的地盘」列表（同源 fetch，带会话 cookie）。
 *  新版走 REST /api.php/v1；老版回退抓取 index.php?m=my&f=task 页面表格并解析。 */
export async function ztFetchMyWork(
  mode: ZentaoWorkMode = 'task',
  limit = 200,
): Promise<ZentaoItem[]> {
  const js = `(()=>{const emit=(o)=>window.__TAURI__.event.emit('dk:zt-data',o)
fetch('${ZENTAO_API_PREFIX}/user?fields=${mode}&type=assignedTo&limit=${limit}')
.then(r=>r.json())
.then(d=>emit(d))
.catch(()=>fetch('/index.php?m=my&f=task&type=assignedTo')
.then(r=>r.text())
.then(html=>{
const doc=new DOMParser().parseFromString(html,'text/html')
const smap={'未开始':'wait','进行中':'doing','已完成':'done','已暂停':'pause','已取消':'cancel','已关闭':'closed','已延期':'delay'}
const items=[...doc.querySelectorAll('table tbody tr')].map(tr=>{
const tds=[...tr.querySelectorAll('td')].map(td=>td.textContent.trim())
const link=tr.querySelector('a[title]')||tr.querySelector('a')
const name=(link&&(link.getAttribute('title')||link.textContent)||'').trim()
const deadline=tds.find(t=>/^\\d{4}-\\d{2}-\\d{2}$/.test(t))||''
const cn=tds.find(t=>smap[t])||''
const pri=tds.find(t=>/^[1-4]$/.test(t))||''
const idTxt=(tr.getAttribute('data-id')||tds[0]||'').replace(/\\D/g,'')
return {id:+idTxt||0,name,status:smap[cn]||cn,deadline:deadline||'0000-00-00',pri:+pri||pri}
}).filter(t=>t.id||t.name)
emit({task:items})
})
.catch(e=>emit({__error:String(e)})))})()`
  const data = await evalAndWait<unknown>(js, 'dk:zt-data', 15000)
  if ((data as Record<string, unknown>)?.__error) {
    throw new Error(String((data as Record<string, unknown>).__error))
  }
  return extractItems(data, mode)
}

/**
 * 自动登录：在禅道窗口里把账号密码填进真实登录表单并提交
 * （走页面原生登录 JS，兼容各版本的加密/验证码逻辑；验证码出现时仍需人工）
 */
export async function ztAutoLogin(account: string, password: string): Promise<void> {
  // 第一步：不在登录页就跳过去（跳转会销毁页面上下文，必须分步）
  const navJs = `(()=>{const on=/f=login/.test(location.href)
    window.__TAURI__.event.emit('dk:zt-nav',{onLogin:on})
    if(!on)location.assign('/index.php?m=user&f=login')})()`
  const nav = await evalAndWait<{ onLogin?: boolean }>(navJs, 'dk:zt-nav').catch(
    (): { onLogin?: boolean } => ({}),
  )
  if (!nav.onLogin) await new Promise((r) => setTimeout(r, 2000))

  // 第二步：填表 + 勾选自动登录 + 提交
  const js = `(()=>{const q=s=>document.querySelector(s);const e=o=>window.__TAURI__.event.emit('dk:zt-auto',o)
const a=q('#account')||q('input[name=account]');const p=q('#password')||q('input[name=password]')
if(!a||!p)return e({error:'noform'})
a.value=${JSON.stringify(account)};p.value=${JSON.stringify(password)}
;['input','change','blur'].forEach(t=>{a.dispatchEvent(new Event(t,{bubbles:true}));p.dispatchEvent(new Event(t,{bubbles:true}))})
const k=q('input[name=keepLogin]');if(k){k.checked=true;k.dispatchEvent(new Event('change',{bubbles:true}))}
const b=q('#submit')||q('button[type=submit]')||q('input[type=submit]')
if(b)b.click();else{const f=a.closest('form');if(f)f.submit();else return e({error:'nosubmit'})}
e({done:true})})()`
  const r = await evalAndWait<{ done?: boolean; error?: string }>(js, 'dk:zt-auto')
  if (r.error) throw new Error('登录表单自动填写失败')
  await new Promise((r2) => setTimeout(r2, 1500))
}

// ============ 智能体工具集：交给 LLM 自主编排禅道连接流程 ============

export const ZENTAO_AGENT_TOOLS: AgentToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'open_zentao_window',
      description:
        '打开禅道浏览器窗口。visible=false 静默创建用于探测登录态；visible=true 显示出来让用户在禅道页面里登录。',
      parameters: {
        type: 'object',
        properties: { visible: { type: 'boolean', description: '是否显示窗口' } },
        required: ['visible'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_zentao_login',
      description:
        '检查禅道窗口当前是否已登录，返回 {"logged": true/false}。窗口未打开或页面未加载完会返回错误。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_my_zentao_tasks',
      description:
        '在已登录的禅道窗口中读取「我的地盘-指派给我的任务」列表，返回任务数组（含 id/name/status/deadline/pri）。必须在已登录状态下调用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_zentao_window',
      description: '关闭禅道窗口',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'auto_login_zentao',
      description:
        '用已绑定的禅道账号密码自动填写登录表单并提交。未绑定凭据时返回错误，此时应改为显示窗口让用户手动登录。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_seconds',
      description: '等待指定秒数（1-30），用于等待用户登录后再次检查登录态',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number', description: '等待秒数' } },
        required: ['seconds'],
      },
    },
  },
]

/** 智能体执行器的任务简报（喂回给模型的是精简字段） */
export function zentaoToolExecutor(
  onTasks: (items: ZentaoItem[]) => void,
  creds?: ZentaoConfig | null,
) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case 'open_zentao_window': {
        await ztOpenWindow(!!args.visible)
        return args.visible ? '禅道窗口已显示，等待用户在页面登录' : '禅道窗口已创建（隐藏）'
      }
      case 'check_zentao_login': {
        try {
          return JSON.stringify({ logged: await ztCheckLoggedIn() })
        } catch {
          return JSON.stringify({ logged: false, note: '窗口未打开或页面未加载完成' })
        }
      }
      case 'read_my_zentao_tasks': {
        const items = await ztFetchMyWork()
        onTasks(items)
        const slim = items.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          deadline: t.deadline,
          pri: t.pri,
        }))
        return JSON.stringify({ count: items.length, tasks: slim })
      }
      case 'close_zentao_window':
        await ztCloseWindow()
        return '禅道窗口已关闭'
      case 'auto_login_zentao': {
        if (!creds?.account || !creds?.password) return '错误: 未绑定禅道账号密码'
        await ztAutoLogin(creds.account, creds.password)
        return '已自动填写并提交登录表单'
      }
      case 'wait_seconds': {
        const s = Math.min(Math.max(Number(args.seconds) || 5, 1), 30)
        await new Promise((r) => setTimeout(r, s * 1000))
        return `已等待 ${s} 秒`
      }
      default:
        return `未知工具: ${name}`
    }
  }
}

/** 智能体任务指令（作为 extraSystemPrompt 传给模型） */
export const ZENTAO_AGENT_PROMPT = `你正在操作 DiKong OA 桌面应用内嵌的禅道浏览器窗口（禅道地址 ${ZENTAO_API_BASE}）。
目标：帮用户连接禅道，读取「我的地盘」中指派给用户的任务，并汇报超时情况。

执行步骤：
1. open_zentao_window(visible=false) 静默创建窗口，然后 check_zentao_login 检查登录态。
   页面刚打开可能还在加载，返回错误时 wait_seconds(3) 后再查一次。
2. 已登录：read_my_zentao_tasks 读取任务，然后 close_zentao_window。
3. 未登录：优先 auto_login_zentao 用已绑定凭据自动登录（失败说明需人工）；
   若工具返回未绑定或提交后仍 logged=false，则 open_zentao_window(visible=true)
   把窗口展示给用户，wait_seconds(10) 与 check_zentao_login 交替循环等待人工登录。
4. 最后用中文汇报：任务总数；其中超时任务（deadline 早于今天且 status 不属于
   done/closed/cancel）逐条列出名称和截止日期；无超时则明确说明。
   窗口被用户关闭或工具持续报错时，如实说明失败原因。`
