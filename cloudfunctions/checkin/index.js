const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PASTELS = ['#F5B7B1', '#F7C59F', '#F9E79F', '#A9DFBF', '#AED6F1', '#D7BDE2', '#F5CBA7', '#FADBD8']


function pad(n) {
  return String(n).padStart(2, '0')
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 周日为一周起点 */
function weekRange(anchorDate) {
  const d = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate())
  const offset = d.getDay() // 0=周日
  const start = new Date(d)
  start.setDate(d.getDate() - offset)
  const days = []
  for (let i = 0; i < 7; i++) {
    const x = new Date(start)
    x.setDate(start.getDate() + i)
    days.push({
      key: dayKey(x),
      label: ['日', '一', '二', '三', '四', '五', '六'][i],
      month: x.getMonth() + 1,
      date: x.getDate()
    })
  }
  const end = days[6]
  const rangeLabel = `${days[0].month}.${days[0].date}-${end.month}.${end.date}`
  return { startKey: days[0].key, endKey: end.key, days, rangeLabel, start }
}

function parseAnchor(weekStart) {
  if (weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    const [y, m, d] = weekStart.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date()
}

async function findMember(groupId, openid) {
  if (!groupId || !openid) return null
  let res = await db.collection('group_members').where({ groupId, openid }).limit(1).get()
  if (res.data[0]) return res.data[0]
  res = await db.collection('group_members').where({ groupId, _openid: openid }).limit(1).get()
  return res.data[0] || null
}

async function ensureMember(groupId, openid) {
  let member = await findMember(groupId, openid)
  if (member) return member
  let group = null
  try {
    group = (await db.collection('groups').doc(groupId).get()).data
  } catch (e) {
    return null
  }
  if (!group) return null
  const userRes = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const user = userRes.data[0]
  const isOwner = group.ownerOpenid === openid
  const isCurrent = user && user.currentGroupId === groupId
  if (!isOwner && !isCurrent) return null
  const addRes = await db.collection('group_members').add({
    data: {
      groupId,
      openid,
      role: isOwner ? 'owner' : 'member',
      nickName: ((user && user.nickName) || '').trim(),
      streak: 0,
      totalCheckins: 0,
      points: 0,
      lastCheckinDay: '',
      joinedAt: db.serverDate()
    }
  })
  return (await db.collection('group_members').doc(addRes._id).get()).data
}

async function assertSameGroup(groupId, viewerOpenid, targetOpenid) {
  const viewer = await findMember(groupId, viewerOpenid)
  if (!viewer) return null
  if (targetOpenid === viewerOpenid) return { viewer, target: viewer }
  const target = await findMember(groupId, targetOpenid)
  if (!target) return null
  return { viewer, target }
}

function yesterdayKey(day) {
  const [y, m, d] = day.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - 1)
  return dayKey(dt)
}

async function bumpStreakOnCheck(member, day) {
  if (!member || !member._id) return member
  if (member.lastCheckinDay === day) return member

  let streak = 1
  if (member.lastCheckinDay === yesterdayKey(day)) {
    streak = (member.streak || 0) + 1
  }
  let pointsGain = 10
  if (streak > 0 && streak % 7 === 0) pointsGain += 20

  await db
    .collection('group_members')
    .doc(member._id)
    .update({
      data: {
        streak,
        totalCheckins: _.inc(1),
        points: _.inc(pointsGain),
        lastCheckinDay: day
      }
    })
  return {
    ...member,
    streak,
    totalCheckins: (member.totalCheckins || 0) + 1,
    points: (member.points || 0) + pointsGain,
    lastCheckinDay: day
  }
}

/**
 * actions:
 * - week: groupId, weekStart?, targetOpenid?
 * - toggle: groupId, habitId, day
 * - addHabit: groupId, name, emoji?
 * - removeHabit: groupId, habitId
 * - listMembers: groupId
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'week'
  const groupId = event.groupId

  if (action === 'listMembers') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const res = await db.collection('group_members').where({ groupId }).limit(50).get()
    const list = (res.data || []).map((m) => {
      const oid = m.openid || m._openid || ''
      const nick = (m.nickName || '').trim()
      return {
        openid: oid,
        displayName: nick || `Buddy ${String(oid).slice(-4) || '??'}`,
        isMe: oid === OPENID,
        role: m.role || 'member'
      }
    })
    return { ok: true, list, myOpenid: OPENID }
  }

  if (action === 'addHabit') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const name = String(event.name || '').trim().slice(0, 12)
    if (!name) return { ok: false, error: 'name_required' }
    const emoji = String(event.emoji || '✨').trim().slice(0, 4) || '✨'
    const existing = await db
      .collection('habits')
      .where({ groupId, openid: OPENID })
      .limit(30)
      .get()
    if ((existing.data || []).length >= 20) return { ok: false, error: 'too_many' }

    const color = PASTELS[(existing.data || []).length % PASTELS.length]
    const addRes = await db.collection('habits').add({
      data: {
        groupId,
        openid: OPENID,
        name,
        emoji,
        color,
        sort: (existing.data || []).length,
        createdAt: db.serverDate()
      }
    })
    const item = (await db.collection('habits').doc(addRes._id).get()).data
    return { ok: true, habit: { ...item, _id: addRes._id } }
  }

  if (action === 'removeHabit') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const habitId = event.habitId
    if (!habitId) return { ok: false, error: 'habit_required' }
    const doc = await db.collection('habits').doc(habitId).get()
    const habit = doc.data
    if (!habit || habit.groupId !== groupId) return { ok: false, error: 'not_found' }
    const owner = habit.openid || habit._openid
    if (owner !== OPENID) return { ok: false, error: 'forbidden' }
    await db.collection('habits').doc(habitId).remove()
    // 可选：不删历史 checkins，周视图会自动忽略无 habit 的格子
    return { ok: true }
  }

  if (action === 'toggle') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const habitId = event.habitId
    const day = String(event.day || '')
    if (!habitId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return { ok: false, error: 'invalid_params' }
    }

    const habitDoc = await db.collection('habits').doc(habitId).get()
    const habit = habitDoc.data
    if (!habit || habit.groupId !== groupId) return { ok: false, error: 'not_found' }
    if ((habit.openid || habit._openid) !== OPENID) {
      return { ok: false, error: 'forbidden' }
    }

    const found = await db
      .collection('checkins')
      .where({ groupId, openid: OPENID, habitId, day })
      .limit(1)
      .get()
    let checked = false
    let member = me

    if (found.data[0]) {
      await db.collection('checkins').doc(found.data[0]._id).remove()
      checked = false
    } else {
      // 兼容旧数据也可能用 _openid
      const found2 = await db
        .collection('checkins')
        .where({ groupId, _openid: OPENID, habitId, day })
        .limit(1)
        .get()
      if (found2.data[0]) {
        await db.collection('checkins').doc(found2.data[0]._id).remove()
        checked = false
      } else {
        const hadAny = await db
          .collection('checkins')
          .where({ groupId, openid: OPENID, day })
          .limit(1)
          .get()
        const hadAny2 =
          hadAny.data.length > 0
            ? hadAny
            : await db.collection('checkins').where({ groupId, _openid: OPENID, day }).limit(1).get()

        await db.collection('checkins').add({
          data: {
            groupId,
            openid: OPENID,
            habitId,
            day,
            createdAt: db.serverDate()
          }
        })
        checked = true
        if (!hadAny2.data.length) {
          member = await bumpStreakOnCheck(me, day)
        }
      }
    }

    return {
      ok: true,
      checked,
      day,
      habitId,
      streak: member.streak || 0,
      points: member.points || 0
    }
  }

  if (action === 'week') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }

    const targetOpenid = event.targetOpenid || OPENID
    const pair = await assertSameGroup(groupId, OPENID, targetOpenid)
    if (!pair) return { ok: false, error: 'not_in_group' }

    const anchor = parseAnchor(event.weekStart)
    // 把任意日期归一到该周周日
    const { days, rangeLabel, startKey } = weekRange(anchor)
    const dayKeys = days.map((d) => d.key)

    let habitsRes = await db
      .collection('habits')
      .where({ groupId, openid: targetOpenid })
      .limit(30)
      .get()
    if (!habitsRes.data.length) {
      habitsRes = await db
        .collection('habits')
        .where({ groupId, _openid: targetOpenid })
        .limit(30)
        .get()
    }

    const habits = (habitsRes.data || [])
      .map((h) => ({
        _id: h._id,
        name: h.name,
        emoji: h.emoji || '✨',
        color: h.color || PASTELS[0],
        sort: h.sort || 0
      }))
      .sort((a, b) => a.sort - b.sort)

    // 拉本周打卡（按 openid；量小可 where day in）
    let checks = []
    if (habits.length) {
      const c1 = await db
        .collection('checkins')
        .where({
          groupId,
          openid: targetOpenid,
          day: _.in(dayKeys)
        })
        .limit(200)
        .get()
      checks = c1.data || []
      if (!checks.length) {
        const c2 = await db
          .collection('checkins')
          .where({
            groupId,
            _openid: targetOpenid,
            day: _.in(dayKeys)
          })
          .limit(200)
          .get()
        checks = c2.data || []
      }
    }

    const doneMap = {}
    checks.forEach((c) => {
      doneMap[`${c.habitId}_${c.day}`] = true
    })

    const grid = habits.map((h) => ({
      habitId: h._id,
      name: h.name,
      emoji: h.emoji,
      color: h.color,
      cells: days.map((d) => ({
        day: d.key,
        checked: !!doneMap[`${h._id}_${d.key}`]
      }))
    }))

    const targetOid = pair.target.openid || pair.target._openid || targetOpenid
    const nick = (pair.target.nickName || '').trim()

    return {
      ok: true,
      weekStart: startKey,
      rangeLabel,
      days,
      habits,
      grid,
      isMe: targetOpenid === OPENID,
      targetOpenid,
      targetName: nick || `Buddy ${String(targetOid).slice(-4)}`,
      streak: pair.target.streak || 0,
      points: pair.target.points || 0,
      today: dayKey(new Date())
    }
  }

  return { ok: false, error: 'unknown_action' }
}
