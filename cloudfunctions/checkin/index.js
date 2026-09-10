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

/** 云函数常为 UTC，按北京时间算「今天」 */
function chinaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date())
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value)
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
}

function todayKey() {
  return dayKey(chinaNow())
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
  return chinaNow()
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

async function bumpPoints(member, baseGain, { updateStreak, day, groupId, openid }) {
  if (!member || !member._id || !(baseGain > 0)) return { member, pointsGain: 0 }

  let pointsGain = baseGain
  let streak = member.streak || 0
  let lastCheckinDay = member.lastCheckinDay || ''
  const data = {
    totalCheckins: _.inc(1)
  }

  let bonus = 0
  if (updateStreak && lastCheckinDay !== day) {
    streak = lastCheckinDay === yesterdayKey(day) ? (member.streak || 0) + 1 : 1
    lastCheckinDay = day
    data.streak = streak
    data.lastCheckinDay = day
    if (streak > 0 && streak % 7 === 0) {
      bonus = 20
      pointsGain += 20
    }
  }

  data.points = _.inc(pointsGain)
  await db.collection('group_members').doc(member._id).update({ data })

  const nextPoints = (member.points || 0) + pointsGain
  const oid = openid || member.openid || member._openid || ''
  const gid = groupId || member.groupId || ''
  if (gid && oid) {
    const base = pointsGain - bonus
    if (base > 0) {
      await db.collection('point_logs').add({
        data: {
          groupId: gid,
          openid: oid,
          delta: base,
          balance: (member.points || 0) + base,
          reason: updateStreak ? 'checkin' : 'makeup',
          title: updateStreak ? `打卡 +${base}` : `补卡 +${base}`,
          refId: day || '',
          createdAt: db.serverDate()
        }
      })
    }
    if (bonus > 0) {
      await db.collection('point_logs').add({
        data: {
          groupId: gid,
          openid: oid,
          delta: bonus,
          balance: nextPoints,
          reason: 'streak_bonus',
          title: `连续满 7 天 +${bonus}`,
          refId: day || '',
          createdAt: db.serverDate()
        }
      })
    }
  }

  return {
    member: {
      ...member,
      streak: data.streak != null ? streak : member.streak || 0,
      totalCheckins: (member.totalCheckins || 0) + 1,
      points: nextPoints,
      lastCheckinDay: data.lastCheckinDay != null ? lastCheckinDay : member.lastCheckinDay || ''
    },
    pointsGain
  }
}

async function revertPoints(member, pointsGain, { groupId, openid, day } = {}) {
  if (!member || !member._id || !(pointsGain > 0)) return member
  await db
    .collection('group_members')
    .doc(member._id)
    .update({
      data: {
        totalCheckins: _.inc(-1),
        points: _.inc(-pointsGain)
      }
    })
  const nextPoints = Math.max(0, (member.points || 0) - pointsGain)
  const oid = openid || member.openid || member._openid || ''
  const gid = groupId || member.groupId || ''
  if (gid && oid) {
    await db.collection('point_logs').add({
      data: {
        groupId: gid,
        openid: oid,
        delta: -pointsGain,
        balance: nextPoints,
        reason: 'checkin_revert',
        title: `取消打卡 -${pointsGain}`,
        refId: day || '',
        createdAt: db.serverDate()
      }
    })
  }
  return {
    ...member,
    totalCheckins: Math.max(0, (member.totalCheckins || 0) - 1),
    points: nextPoints
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

    const today = todayKey()
    if (day > today) {
      return { ok: false, error: 'future_not_allowed' }
    }
    const isMakeup = day < today

    const habitDoc = await db.collection('habits').doc(habitId).get()
    const habit = habitDoc.data
    if (!habit || habit.groupId !== groupId) return { ok: false, error: 'not_found' }
    if ((habit.openid || habit._openid) !== OPENID) {
      return { ok: false, error: 'forbidden' }
    }

    let found = await db
      .collection('checkins')
      .where({ groupId, openid: OPENID, habitId, day })
      .limit(1)
      .get()
    if (!found.data[0]) {
      found = await db
        .collection('checkins')
        .where({ groupId, _openid: OPENID, habitId, day })
        .limit(1)
        .get()
    }

    let checked = false
    let member = me
    let pointsGain = 0
    let makeup = isMakeup

    if (found.data[0]) {
      // 取消打卡：有记过分则扣回，或转记到同日其它打卡上
      const old = found.data[0]
      const back = Number(old.pointsGain) || 0
      await db.collection('checkins').doc(old._id).remove()
      checked = false
      makeup = !!old.isMakeup
      if (back > 0) {
        const left1 = await db
          .collection('checkins')
          .where({ groupId, openid: OPENID, day })
          .limit(1)
          .get()
        const left =
          left1.data.length > 0
            ? left1
            : await db.collection('checkins').where({ groupId, _openid: OPENID, day }).limit(1).get()
        if (left.data[0]) {
          await db.collection('checkins').doc(left.data[0]._id).update({
            data: { pointsGain: back }
          })
        } else {
          member = await revertPoints(me, back, { groupId, openid: OPENID, day })
          pointsGain = -back
        }
      }
    } else {
      // 新打卡
      const hadAny = await db
        .collection('checkins')
        .where({ groupId, openid: OPENID, day })
        .limit(1)
        .get()
      const hadAny2 =
        hadAny.data.length > 0
          ? hadAny
          : await db.collection('checkins').where({ groupId, _openid: OPENID, day }).limit(1).get()
      const isFirstOfDay = !hadAny2.data.length

      pointsGain = 0
      if (isFirstOfDay) {
        const base = isMakeup ? 5 : 10
        const bumped = await bumpPoints(me, base, {
          updateStreak: !isMakeup,
          day,
          groupId,
          openid: OPENID
        })
        member = bumped.member
        pointsGain = bumped.pointsGain
      }

      await db.collection('checkins').add({
        data: {
          groupId,
          openid: OPENID,
          habitId,
          day,
          isMakeup,
          pointsGain: isFirstOfDay ? pointsGain : 0,
          createdAt: db.serverDate()
        }
      })
      checked = true
      makeup = isMakeup
    }

    return {
      ok: true,
      checked,
      day,
      habitId,
      isMakeup: makeup,
      pointsGain,
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
    const makeupMap = {}
    checks.forEach((c) => {
      doneMap[`${c.habitId}_${c.day}`] = true
      if (c.isMakeup) makeupMap[`${c.habitId}_${c.day}`] = true
    })

    const todayStr = todayKey()
    const grid = habits.map((h) => ({
      habitId: h._id,
      name: h.name,
      emoji: h.emoji,
      color: h.color,
      cells: days.map((d) => {
        const future = d.key > todayStr
        return {
          day: d.key,
          checked: !!doneMap[`${h._id}_${d.key}`],
          isMakeup: !!makeupMap[`${h._id}_${d.key}`],
          future,
          canCheck: !future,
          isToday: d.key === todayStr
        }
      })
    }))

    // 全员本周进度：已打格 /（习惯数 × 截至今天的天数）
    const eligibleDays = dayKeys.filter((k) => k <= todayStr)
    const membersRes = await db.collection('group_members').where({ groupId }).limit(50).get()
    const allHabitsRes = await db.collection('habits').where({ groupId }).limit(500).get()
    const allChecksRes = await db
      .collection('checkins')
      .where({ groupId, day: _.in(dayKeys) })
      .limit(1000)
      .get()

    const habitsByOid = {}
    ;(allHabitsRes.data || []).forEach((h) => {
      const oid = h.openid || h._openid || ''
      if (!oid) return
      if (!habitsByOid[oid]) habitsByOid[oid] = []
      habitsByOid[oid].push(h._id)
    })

    const checkSetByOid = {}
    ;(allChecksRes.data || []).forEach((c) => {
      const oid = c.openid || c._openid || ''
      if (!oid || !c.habitId || !c.day) return
      if (!checkSetByOid[oid]) checkSetByOid[oid] = new Set()
      checkSetByOid[oid].add(`${c.habitId}_${c.day}`)
    })

    const weekProgress = (membersRes.data || [])
      .map((m) => {
        const oid = m.openid || m._openid || ''
        const nick = (m.nickName || '').trim()
        const habitIds = habitsByOid[oid] || []
        const habitCount = habitIds.length
        const total = habitCount * eligibleDays.length
        let done = 0
        if (total > 0) {
          const set = checkSetByOid[oid] || new Set()
          habitIds.forEach((hid) => {
            eligibleDays.forEach((dk) => {
              if (set.has(`${hid}_${dk}`)) done += 1
            })
          })
        }
        const percent = total > 0 ? Math.round((done / total) * 100) : 0
        return {
          openid: oid,
          displayName: nick || `Buddy ${String(oid).slice(-4) || '??'}`,
          isMe: oid === OPENID,
          habitCount,
          done,
          total,
          percent
        }
      })
      .sort((a, b) => {
        if (a.isMe !== b.isMe) return a.isMe ? -1 : 1
        return b.percent - a.percent
      })

    const targetOid = pair.target.openid || pair.target._openid || targetOpenid
    const nick = (pair.target.nickName || '').trim()

    return {
      ok: true,
      weekStart: startKey,
      rangeLabel,
      days,
      habits,
      grid,
      weekProgress,
      isMe: targetOpenid === OPENID,
      targetOpenid,
      targetName: nick || `Buddy ${String(targetOid).slice(-4)}`,
      streak: pair.target.streak || 0,
      points: pair.target.points || 0,
      today: todayStr
    }
  }

  return { ok: false, error: 'unknown_action' }
}
