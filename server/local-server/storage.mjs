/**
 * 项目图片存在本机 MinIO。连接信息：DIKONG_MINIO_CONFIG 或 /opt/dikong-oa/minio.json
 */
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Client } from 'minio'

const BUCKET = 'dikong-images'
const MAX_BYTES = 8 * 1024 * 1024
const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

let client
let ready

export function minioConfigPath() {
  if (process.env.DIKONG_MINIO_CONFIG) return process.env.DIKONG_MINIO_CONFIG
  const local = new URL('./minio.json', import.meta.url)
  if (existsSync(local)) return local
  return '/opt/dikong-oa/minio.json'
}

function loadConfig() {
  const path = minioConfigPath()
  if (!existsSync(path)) {
    const err = new Error('图片存储尚未配置')
    err.code = 503
    throw err
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function getClient() {
  if (!client) {
    const cfg = loadConfig()
    client = new Client({
      endPoint: cfg.endPoint,
      port: Number(cfg.port),
      useSSL: Boolean(cfg.useSSL),
      accessKey: cfg.accessKey,
      secretKey: cfg.secretKey,
    })
  }
  return client
}

const PUBLIC_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${BUCKET}/*`],
    },
  ],
})

export async function ensureStorage() {
  if (!ready) {
    ready = (async () => {
      const minio = getClient()
      const exists = await minio.bucketExists(BUCKET)
      if (!exists) await minio.makeBucket(BUCKET, 'us-east-1')
      await minio.setBucketPolicy(BUCKET, PUBLIC_POLICY)
      return true
    })().catch((error) => {
      ready = null
      throw error
    })
  }
  await ready
}

function bad(message) {
  const err = new Error(message)
  err.code = 400
  throw err
}

export async function putImage(userId, body) {
  await ensureStorage()
  const contentType = String(body.contentType || '').toLowerCase()
  const ext = TYPES[contentType]
  if (!ext) bad('只支持 jpg、png、gif、webp 图片')
  const raw = String(body.data || '')
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) bad('图片内容为空')
  if (buffer.length > MAX_BYTES) bad('图片不能超过 8MB')
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const key = `projects/${day}/${userId}-${randomUUID()}.${ext}`
  await getClient().putObject(BUCKET, key, buffer, buffer.length, { 'Content-Type': contentType })
  return { key, url: `/images/${key}`, size: buffer.length }
}
