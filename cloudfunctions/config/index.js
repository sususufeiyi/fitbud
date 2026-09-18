const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 手动开关口令：云开发控制台测云函数时带上 */
const ADMIN_TOKEN = 'fitbud-switch-9f3a'
const DOC_ID = 'main'
const COL = 'app_config'

const DEFAULT_FEATURES = {
  showWantTodo: false
}

async function ensureDoc() {
  try {
    const res = await db.collection(COL).doc(DOC_ID).get()
    if (res.data) return res.data
  } catch (e) {
    // 集合或文档不存在
  }
  try {
    await db.createCollection(COL)
  } catch (e) {
    // 已存在
  }
  const data = {
    ...DEFAULT_FEATURES,
    updatedAt: db.serverDate()
  }
  try {
    await db.collection(COL).doc(DOC_ID).set({ data })
  } catch (e) {
    // ignore
  }
  return { _id: DOC_ID, ...DEFAULT_FEATURES }
}

async function readFeatures() {
  const doc = await ensureDoc()
  return {
    showWantTodo: doc.showWantTodo === true
  }
}

/**
 * action:
 *   get — 读开关（小程序启动用）
 *   setWantTodo — { enabled: true|false, token }
 */
exports.main = async (event = {}) => {
  const action = event.action || 'get'

  if (action === 'get') {
    const features = await readFeatures()
    return { ok: true, features }
  }

  if (action === 'setWantTodo') {
    if (String(event.token || '') !== ADMIN_TOKEN) {
      return { ok: false, error: 'forbidden' }
    }
    const enabled = event.enabled === true || event.enabled === 'true' || event.enabled === 1
    await ensureDoc()
    await db.collection(COL).doc(DOC_ID).set({
      data: {
        showWantTodo: enabled,
        updatedAt: db.serverDate()
      }
    })
    return { ok: true, features: { showWantTodo: enabled } }
  }

  return { ok: false, error: 'unknown_action' }
}
