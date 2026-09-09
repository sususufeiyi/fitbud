const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const MAX = 100

async function syncNickToMembers(openid, nickName) {
  // 同步到该用户所有群成员记录（openid / _openid 两种）
  const col = db.collection('group_members')
  const byOpenid = await col.where({ openid }).limit(MAX).get()
  const by_openid = await col.where({ _openid: openid }).limit(MAX).get()
  const ids = new Set()
  ;[...(byOpenid.data || []), ...(by_openid.data || [])].forEach((m) => {
    if (m && m._id) ids.add(m._id)
  })

  const tasks = []
  ids.forEach((id) => {
    tasks.push(
      col.doc(id).update({
        data: { nickName }
      })
    )
  })
  if (tasks.length) await Promise.all(tasks)
}

/**
 * event.action: login(默认) | updateProfile
 * updateProfile: nickName, avatarUrl
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const users = db.collection('users')
  const action = event.action || 'login'

  if (action === 'updateProfile') {
    const nickName = String(event.nickName || '').trim().slice(0, 20)
    const avatarUrl = String(event.avatarUrl || '').trim().slice(0, 500)
    if (!nickName) return { ok: false, error: 'nickname_required' }

    const found = await users.where({ _openid: OPENID }).limit(1).get()
    let user = found.data[0]

    if (!user) {
      const addRes = await users.add({
        data: {
          nickName,
          avatarUrl,
          streak: 0,
          totalCheckins: 0,
          points: 0,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      user = (await users.doc(addRes._id).get()).data
    } else {
      const patch = { nickName, updatedAt: db.serverDate() }
      if (avatarUrl) patch.avatarUrl = avatarUrl
      await users.doc(user._id).update({ data: patch })
      user = (await users.doc(user._id).get()).data
    }

    await syncNickToMembers(OPENID, nickName)
    return { ok: true, user, openid: OPENID }
  }

  // 默认登录
  const found = await users.where({ _openid: OPENID }).limit(1).get()
  let user = found.data[0]

  if (!user) {
    const now = db.serverDate()
    const addRes = await users.add({
      data: {
        nickName: '',
        avatarUrl: '',
        streak: 0,
        totalCheckins: 0,
        points: 0,
        createdAt: now,
        updatedAt: now
      }
    })
    const doc = await users.doc(addRes._id).get()
    user = doc.data
  }

  return {
    ok: true,
    openid: OPENID,
    user
  }
}
