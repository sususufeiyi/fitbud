const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function makeInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

async function ensureUniqueInviteCode() {
  for (let i = 0; i < 8; i++) {
    const code = makeInviteCode()
    const found = await db.collection('groups').where({ inviteCode: code }).limit(1).get()
    if (!found.data.length) return code
  }
  return makeInviteCode() + Date.now().toString(36).slice(-2).toUpperCase()
}

async function getMembership(groupId, openid) {
  let res = await db
    .collection('group_members')
    .where({ groupId, openid })
    .limit(1)
    .get()
  if (res.data[0]) return res.data[0]
  res = await db
    .collection('group_members')
    .where({ groupId, _openid: openid })
    .limit(1)
    .get()
  return res.data[0] || null
}

/**
 * event.action: create | join | list | detail | members | select | rename
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  const groups = db.collection('groups')
  const members = db.collection('group_members')
  const users = db.collection('users')

  if (action === 'create') {
    const name = String(event.name || '').trim().slice(0, 20)
    if (!name) return { ok: false, error: 'name_required' }

    const inviteCode = await ensureUniqueInviteCode()
    const addRes = await groups.add({
      data: {
        name,
        inviteCode,
        memberCount: 1,
        ownerOpenid: OPENID,
        createdAt: db.serverDate()
      }
    })

    const me = await users.where({ _openid: OPENID }).limit(1).get()
    const myNick = ((me.data[0] && me.data[0].nickName) || '').trim()

    await members.add({
      data: {
        groupId: addRes._id,
        openid: OPENID,
        role: 'owner',
        nickName: myNick,
        streak: 0,
        totalCheckins: 0,
        points: 0,
        lastCheckinDay: '',
        joinedAt: db.serverDate()
      }
    })

    await users.where({ _openid: OPENID }).update({
      data: { currentGroupId: addRes._id, updatedAt: db.serverDate() }
    })

    const groupDoc = (await groups.doc(addRes._id).get()).data || {}
    return {
      ok: true,
      group: {
        ...groupDoc,
        _id: addRes._id,
        myStreak: 0,
        myPoints: 0,
        role: 'owner'
      }
    }
  }

  if (action === 'join') {
    const inviteCode = String(event.inviteCode || '')
      .trim()
      .toUpperCase()
    if (!inviteCode) return { ok: false, error: 'invite_required' }

    const found = await groups.where({ inviteCode }).limit(1).get()
    const group = found.data[0]
    if (!group) return { ok: false, error: 'group_not_found' }

    const existed = await getMembership(group._id, OPENID)
    if (existed) {
      await users.where({ _openid: OPENID }).update({
        data: { currentGroupId: group._id, updatedAt: db.serverDate() }
      })
      return {
        ok: true,
        already: true,
        group: { ...group, _id: group._id }
      }
    }

    const me = await users.where({ _openid: OPENID }).limit(1).get()
    const myNick = ((me.data[0] && me.data[0].nickName) || '').trim()

    await members.add({
      data: {
        groupId: group._id,
        openid: OPENID,
        role: 'member',
        nickName: myNick,
        streak: 0,
        totalCheckins: 0,
        points: 0,
        lastCheckinDay: '',
        joinedAt: db.serverDate()
      }
    })
    await groups.doc(group._id).update({
      data: { memberCount: _.inc(1) }
    })
    await users.where({ _openid: OPENID }).update({
      data: { currentGroupId: group._id, updatedAt: db.serverDate() }
    })

    const latest = (await groups.doc(group._id).get()).data || {}
    return {
      ok: true,
      already: false,
      group: { ...latest, _id: group._id }
    }
  }

  if (action === 'list') {
    let mine = await members.where({ openid: OPENID }).limit(50).get()
    if (!mine.data.length) {
      mine = await members.where({ _openid: OPENID }).limit(50).get()
    }

    const list = []
    for (const m of mine.data) {
      if (!m.groupId) continue
      try {
        const g = (await groups.doc(m.groupId).get()).data
        if (!g) continue
        list.push({
          ...g,
          _id: m.groupId,
          myStreak: m.streak || 0,
          myPoints: m.points || 0,
          role: m.role || 'member'
        })
      } catch (e) {
        // 群已删则跳过
      }
    }

    return { ok: true, list }
  }

  if (action === 'detail') {
    const groupId = event.groupId
    if (!groupId) return { ok: false, error: 'group_required' }
    const membership = await getMembership(groupId, OPENID)
    if (!membership) return { ok: false, error: 'not_member' }
    const group = (await groups.doc(groupId).get()).data || {}
    return { ok: true, group: { ...group, _id: groupId }, membership }
  }

  if (action === 'members') {
    const groupId = event.groupId
    if (!groupId) return { ok: false, error: 'group_required' }
    const membership = await getMembership(groupId, OPENID)
    if (!membership) return { ok: false, error: 'not_member' }

    const res = await members.where({ groupId }).limit(50).get()
    const day = (() => {
      const d = new Date()
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${dd}`
    })()

    const list = []
    for (const m of res.data || []) {
      const oid = m.openid || m._openid || ''
      let nickName = (m.nickName || '').trim()
      if (!nickName && oid) {
        try {
          const u = await users.where({ _openid: oid }).limit(1).get()
          nickName = ((u.data[0] && u.data[0].nickName) || '').trim()
        } catch (e) {
          // ignore
        }
      }

      let todayChecked = false
      if (oid) {
        try {
          const c = await db
            .collection('checkins')
            .where({ groupId, _openid: oid, day })
            .limit(1)
            .get()
          todayChecked = c.data.length > 0
        } catch (e) {
          // ignore
        }
      }

      list.push({
        _id: m._id,
        openid: oid,
        role: m.role || 'member',
        nickName,
        displayName: nickName || `Buddy ${String(oid).slice(-4) || '??'}`,
        streak: m.streak || 0,
        totalCheckins: m.totalCheckins || 0,
        points: m.points || 0,
        lastCheckinDay: m.lastCheckinDay || '',
        todayChecked,
        isMe: oid === OPENID
      })
    }

    list.sort((a, b) => (b.points || 0) - (a.points || 0) || (b.streak || 0) - (a.streak || 0))
    return { ok: true, list, day }
  }


  if (action === 'select') {
    const groupId = event.groupId
    if (!groupId) return { ok: false, error: 'group_required' }
    let membership = await getMembership(groupId, OPENID)

    // 本地已选群但成员表缺记录时，自动补成员
    if (!membership) {
      let groupDoc = null
      try {
        groupDoc = (await groups.doc(groupId).get()).data
      } catch (e) {
        return { ok: false, error: 'not_member' }
      }
      if (!groupDoc) return { ok: false, error: 'not_member' }

      const me = await users.where({ _openid: OPENID }).limit(1).get()
      const myNick = ((me.data[0] && me.data[0].nickName) || '').trim()
      const isOwner = groupDoc.ownerOpenid === OPENID
      await members.add({
        data: {
          groupId,
          openid: OPENID,
          role: isOwner ? 'owner' : 'member',
          nickName: myNick,
          streak: 0,
          totalCheckins: 0,
          points: 0,
          lastCheckinDay: '',
          joinedAt: db.serverDate()
        }
      })
      membership = await getMembership(groupId, OPENID)
    }

    if (!membership) return { ok: false, error: 'not_member' }

    await users.where({ _openid: OPENID }).update({
      data: { currentGroupId: groupId, updatedAt: db.serverDate() }
    })
    const group = (await groups.doc(groupId).get()).data || {}
    return {
      ok: true,
      group: {
        ...group,
        _id: groupId,
        myStreak: membership.streak || 0,
        myPoints: membership.points || 0,
        role: membership.role || 'member'
      },
      membership
    }
  }

  if (action === 'rename') {
    const groupId = event.groupId
    const name = String(event.name || '').trim().slice(0, 20)
    if (!groupId) return { ok: false, error: 'group_required' }
    if (!name) return { ok: false, error: 'name_required' }

    const membership = await getMembership(groupId, OPENID)
    if (!membership) return { ok: false, error: 'not_member' }

    await groups.doc(groupId).update({
      data: {
        name,
        updatedAt: db.serverDate()
      }
    })
    const group = (await groups.doc(groupId).get()).data || {}
    return {
      ok: true,
      group: {
        ...group,
        _id: groupId,
        name
      }
    }
  }

  return { ok: false, error: 'unknown_action' }
}

