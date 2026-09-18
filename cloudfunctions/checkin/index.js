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

function chinaHour() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hour12: false
  }).formatToParts(new Date())
  return Number((parts.find((p) => p.type === 'hour') || {}).value) % 24
}

function computeTitles(m) {
  const list = []
  if ((m.makeupCount || 0) >= 3) {
    list.push({ id: 'makeup', name: '补卡专业户', desc: '补卡也是一种坚持' })
  }
  if ((m.honestCount || 0) >= 2) {
    list.push({ id: 'honest', name: '闪电侠', desc: '10秒打三次' })
  }
  if ((m.nightOwlCount || 0) >= 2) {
    list.push({ id: 'night', name: '深夜哲学家', desc: '凌晨还在打卡' })
  }
  if ((m.perfectWeekCount || 0) >= 1) {
    list.push({ id: 'king', name: '全勤卷王', desc: '一周格格不落' })
  }
  if ((m.streak || 0) >= 7) {
    list.push({ id: 'streak7', name: '一周不断', desc: `连续 ${m.streak} 天` })
  }
  if ((m.luckyCount || 0) >= 1) {
    list.push({ id: 'lucky', name: '欧皇附体', desc: '运气打卡选手' })
  }
  return list
}

/** 每周目标次数：1–7，7=每天 */
function normalizeTimesPerWeek(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return 7
  return Math.min(7, n)
}

function slotDayKey(weekStart, slot) {
  return `${weekStart}#${slot}`
}

function parseSlotDay(day) {
  const m = String(day || '').match(/^(\d{4}-\d{2}-\d{2})#(\d+)$/)
  if (!m) return null
  return { weekStart: m[1], slot: Number(m[2]) }
}

/** 北京时间下的日历日（用于 createdAt） */
function chinaDayKeyFromValue(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d)
  const get = (type) => Number((parts.find((p) => p.type === type) || {}).value)
  return dayKey(new Date(get('year'), get('month') - 1, get('day')))
}

/**
 * 一条打卡对应的「活动日」：
 * - 每天习惯：用 day（真实日期）
 * - 每周 N 次：槽位不是日历日，用 streakDay 或实际打卡日 createdAt
 * 切勿把 weekStart#slot 映射成周日+slot，否则会虚增连续/累计
 */
function activityDayFromCheckin(c) {
  if (!c || c.mirrored) return ''
  if (c.streakDay && /^\d{4}-\d{2}-\d{2}$/.test(String(c.streakDay))) {
    return String(c.streakDay)
  }
  const s = String(c.day || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (parseSlotDay(s)) return chinaDayKeyFromValue(c.createdAt)
  return ''
}

function countUniqueCheckinDays(rows) {
  const set = new Set()
  ;(rows || []).forEach((c) => {
    const key = activityDayFromCheckin(c)
    if (key) set.add(key)
  })
  return set.size
}

/**
 * 连续：从今天往回（今天还没打则从昨天起），有「非补卡」打卡的自然日不断档天数。
 * 同一天多个习惯只算 1 天；补卡不算；周目标按实际打卡日算。
 */
function consecutiveStreakFromCheckins(rows, todayStr) {
  const set = new Set()
  ;(rows || []).forEach((c) => {
    if (!c || c.mirrored || c.isMakeup) return
    const key = activityDayFromCheckin(c)
    if (key && key <= todayStr) set.add(key)
  })
  if (!set.size) return 0
  let cursor = todayStr
  if (!set.has(cursor)) cursor = yesterdayKey(cursor)
  let n = 0
  while (set.has(cursor)) {
    n += 1
    cursor = yesterdayKey(cursor)
  }
  return n
}

async function loadMemberCheckins(groupId, openid) {
  let hist = await db
    .collection('checkins')
    .where({ groupId, openid })
    .limit(1000)
    .get()
  if (!(hist.data || []).length) {
    hist = await db
      .collection('checkins')
      .where({ groupId, _openid: openid })
      .limit(1000)
      .get()
  }
  return hist.data || []
}

function isValidCheckDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) || !!parseSlotDay(day)
}

function slotKeysForHabits(weekStart, habits) {
  const keys = []
  ;(habits || []).forEach((h) => {
    const n = normalizeTimesPerWeek(h.timesPerWeek)
    if (n >= 7) return
    for (let i = 0; i < n; i++) keys.push(slotDayKey(weekStart, i))
  })
  return keys
}

/** 把源打卡项的打卡记录复制到目标项（不计分，已有同日记录则跳过） */
async function copyHabitCheckins({ sourceHabitId, targetHabitId, targetGroupId, openid }) {
  if (!sourceHabitId || !targetHabitId || !targetGroupId || !openid) return 0

  let cRes = await db
    .collection('checkins')
    .where({ habitId: sourceHabitId, openid })
    .limit(200)
    .get()
  if (!(cRes.data || []).length) {
    cRes = await db
      .collection('checkins')
      .where({ habitId: sourceHabitId, _openid: openid })
      .limit(200)
      .get()
  }
  const sourceChecks = cRes.data || []
  if (!sourceChecks.length) return 0

  let tRes = await db
    .collection('checkins')
    .where({ habitId: targetHabitId, openid })
    .limit(200)
    .get()
  if (!(tRes.data || []).length) {
    tRes = await db
      .collection('checkins')
      .where({ habitId: targetHabitId, _openid: openid })
      .limit(200)
      .get()
  }
  const existDays = new Set((tRes.data || []).map((c) => c.day).filter(Boolean))

  let copied = 0
  for (let i = 0; i < sourceChecks.length; i++) {
    const c = sourceChecks[i]
    if (!c.day || existDays.has(c.day)) continue
    const data = {
      groupId: targetGroupId,
      openid,
      habitId: targetHabitId,
      day: c.day,
      isMakeup: !!c.isMakeup,
      recordOnly: !!c.recordOnly,
      pointsGain: 0,
      syncedFrom: c._id || '',
      createdAt: c.createdAt || db.serverDate()
    }
    if (c.weekStart) data.weekStart = c.weekStart
    if (c.slot != null && c.slot !== '') data.slot = c.slot
    await db.collection('checkins').add({ data })
    existDays.add(c.day)
    copied += 1
  }
  return copied
}

/** 联动 ID：同源同步的打卡项共用，后续打卡互相镜像 */
function resolveLinkId(habit, habitId) {
  return String((habit && (habit.linkId || habit.syncedFrom)) || habitId || '').trim()
}

async function ensureHabitLinkId(habitId, habit) {
  const linkId = resolveLinkId(habit, habitId)
  if (!linkId) return ''
  if (habit && !habit.linkId) {
    try {
      await db.collection('habits').doc(habitId).update({ data: { linkId } })
    } catch (e) {
      // ignore
    }
  }
  return linkId
}

async function findLinkedHabits(linkId, openid, excludeHabitId) {
  if (!linkId || !openid) return []
  const map = {}

  const push = (h, id) => {
    const hid = id || (h && h._id)
    if (!hid || hid === excludeHabitId) return
    const owner = (h && (h.openid || h._openid)) || ''
    if (owner && owner !== openid) return
    map[hid] = { ...h, _id: hid }
  }

  try {
    const root = await db.collection('habits').doc(linkId).get()
    if (root.data) push(root.data, linkId)
  } catch (e) {
    // ignore
  }

  let byLink = await db.collection('habits').where({ openid, linkId }).limit(50).get()
  ;(byLink.data || []).forEach((h) => push(h, h._id))
  if (!(byLink.data || []).length) {
    byLink = await db.collection('habits').where({ _openid: openid, linkId }).limit(50).get()
    ;(byLink.data || []).forEach((h) => push(h, h._id))
  }

  let bySynced = await db.collection('habits').where({ openid, syncedFrom: linkId }).limit(50).get()
  ;(bySynced.data || []).forEach((h) => push(h, h._id))
  if (!(bySynced.data || []).length) {
    bySynced = await db.collection('habits').where({ _openid: openid, syncedFrom: linkId }).limit(50).get()
    ;(bySynced.data || []).forEach((h) => push(h, h._id))
  }

  return Object.keys(map).map((k) => map[k])
}

/** 把本次打卡/取消镜像到其他群的同源打卡项（不计分） */
async function mirrorLinkedCheckin({
  linkId,
  openid,
  day,
  checked,
  isMakeup,
  slotInfo,
  excludeHabitId
}) {
  const linked = await findLinkedHabits(linkId, openid, excludeHabitId)
  for (let i = 0; i < linked.length; i++) {
    const h = linked[i]
    const hid = h._id
    const gid = h.groupId
    if (!hid || !gid) continue

    let found = await db
      .collection('checkins')
      .where({ habitId: hid, openid, day })
      .limit(1)
      .get()
    if (!found.data[0]) {
      found = await db
        .collection('checkins')
        .where({ habitId: hid, _openid: openid, day })
        .limit(1)
        .get()
    }

    if (checked) {
      if (found.data[0]) continue
      const data = {
        groupId: gid,
        openid,
        habitId: hid,
        day,
        isMakeup: !!isMakeup,
        recordOnly: normalizeDifficulty(h.difficulty) === 'record',
        pointsGain: 0,
        mirrored: true,
        createdAt: db.serverDate()
      }
      if (slotInfo) {
        data.weekStart = slotInfo.weekStart
        data.slot = slotInfo.slot
      }
      await db.collection('checkins').add({ data })
    } else if (found.data[0]) {
      const old = found.data[0]
      const back = Number(old.pointsGain) || 0
      await db.collection('checkins').doc(old._id).remove()
      if (back > 0) {
        const mem = await findMember(gid, openid)
        if (mem) {
          await revertPoints(mem, back, { groupId: gid, openid, day })
        }
      }
    }
  }
}

async function linkHabitsTogether(sourceId, sourceDoc, targetId) {
  const linkId = resolveLinkId(sourceDoc, sourceId) || sourceId
  if (!sourceDoc.linkId && sourceId) {
    try {
      await db.collection('habits').doc(sourceId).update({ data: { linkId } })
    } catch (e) {
      // ignore
    }
  }
  if (targetId) {
    try {
      await db.collection('habits').doc(targetId).update({
        data: { linkId, syncedFrom: sourceId }
      })
    } catch (e) {
      // ignore
    }
  }
  return linkId
}

function normalizeDifficulty(v) {
  const key = String(v || 'other')
  if (key === 'sport' || key === 'record' || key === 'other') return key
  // 旧版简单/一般/困难 → 日常 +2
  if (key === 'easy' || key === 'normal' || key === 'hard') return 'other'
  return 'other'
}

/** 运动 +10 / 补卡 +5；日常 +2 / 补卡 +1；record = 0 */
function pointsForDifficulty(difficulty, isMakeup) {
  const key = normalizeDifficulty(difficulty)
  if (key === 'record') return 0
  if (key === 'sport') return isMakeup ? 5 : 10
  return isMakeup ? 1 : 2
}

function difficultyLabel(difficulty) {
  const key = normalizeDifficulty(difficulty)
  if (key === 'record') return '只做记录'
  if (key === 'sport') return `运动 +${pointsForDifficulty('sport', false)}`
  return `日常 +${pointsForDifficulty('other', false)}`
}

async function fetchAll(colName, whereData) {
  const all = []
  let skip = 0
  const page = 100
  while (skip < 5000) {
    let q = db.collection(colName)
    if (whereData) q = q.where(whereData)
    const res = await q.skip(skip).limit(page).get()
    const rows = res.data || []
    all.push(...rows)
    if (rows.length < page) break
    skip += page
  }
  return all
}

async function removeAllDocs(colName) {
  let removed = 0
  while (removed < 5000) {
    const res = await db.collection(colName).limit(100).get()
    const rows = res.data || []
    if (!rows.length) break
    await Promise.all(rows.map((row) => db.collection(colName).doc(row._id).remove()))
    removed += rows.length
    if (rows.length < 100) break
  }
  return removed
}

async function removeRewardLogs() {
  let removed = 0
  const reasons = ['reward_total', 'reward_streak']
  for (let i = 0; i < reasons.length; i++) {
    while (removed < 5000) {
      const res = await db
        .collection('point_logs')
        .where({ reason: reasons[i] })
        .limit(100)
        .get()
      const rows = res.data || []
      if (!rows.length) break
      await Promise.all(rows.map((row) => db.collection('point_logs').doc(row._id).remove()))
      removed += rows.length
      if (rows.length < 100) break
    }
  }
  return removed
}

async function grantExtra(member, amount, { groupId, openid, reason, title, refId, extraData }) {
  if (!member || !member._id || !(amount > 0)) return member
  const data = { points: _.inc(amount), ...(extraData || {}) }
  await db.collection('group_members').doc(member._id).update({ data })
  const nextPoints = (member.points || 0) + amount
  const oid = openid || member.openid || member._openid || ''
  const gid = groupId || member.groupId || ''
  if (gid && oid) {
    await db.collection('point_logs').add({
      data: {
        groupId: gid,
        openid: oid,
        delta: amount,
        balance: nextPoints,
        reason: reason || 'bonus',
        title: String(title || `奖励 +${amount}`).slice(0, 40),
        refId: refId || '',
        createdAt: db.serverDate()
      }
    })
  }
  const next = { ...member, points: nextPoints }
  if (extraData) {
    Object.keys(extraData).forEach((k) => {
      // 简单同步计数类字段（_.inc 无法本地精确，由调用方传入最终值更好）
    })
  }
  return next
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

/** 由某日所在月得到起止 key（含首尾） */
function monthRange(anchorDate) {
  const y = anchorDate.getFullYear()
  const m = anchorDate.getMonth()
  const start = new Date(y, m, 1)
  const end = new Date(y, m + 1, 0)
  return {
    year: y,
    month: m + 1,
    startKey: dayKey(start),
    endKey: dayKey(end),
    nextStartKey: dayKey(new Date(y, m + 1, 1)),
    label: `${y}年${m + 1}月`
  }
}

function checkinOwner(c) {
  return c.openid || c._openid || ''
}

function checkinPoints(c) {
  const n = Number(c.pointsGain)
  return Number.isFinite(n) ? n : 0
}

/** day 是否落在 [startKey, endKey]；周槽位按 weekStart 判断 */
function checkinInRange(c, startKey, endKey) {
  const day = String(c.day || '')
  const slot = parseSlotDay(day)
  if (slot) {
    return slot.weekStart >= startKey && slot.weekStart <= endKey
  }
  return day >= startKey && day <= endKey
}

function buildPointsRank(members, pointsMap, openidMe) {
  const rows = (members || []).map((m) => {
    const oid = m.openid || m._openid || ''
    const nick = (m.nickName || '').trim()
    const points = Math.max(0, Number(pointsMap[oid]) || 0)
    return {
      openid: oid,
      displayName: nick || `Buddy ${String(oid).slice(-4) || '??'}`,
      isMe: oid === openidMe,
      points
    }
  })
  const max = rows.reduce((acc, r) => Math.max(acc, r.points), 0)
  rows.forEach((r) => {
    r.percent = max > 0 ? Math.round((r.points / max) * 100) : 0
  })
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1
    return String(a.displayName).localeCompare(String(b.displayName), 'zh')
  })
  return rows
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
  const created = (await db.collection('group_members').doc(addRes._id).get()).data || {}
  return { ...created, _id: addRes._id }
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

async function bumpPoints(member, baseGain, { updateStreak, day, groupId, openid, extraData }) {
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
  if (extraData) Object.assign(data, extraData)
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

  const nextMember = {
    ...member,
    streak: data.streak != null ? streak : member.streak || 0,
    totalCheckins: (member.totalCheckins || 0) + 1,
    points: nextPoints,
    lastCheckinDay: data.lastCheckinDay != null ? lastCheckinDay : member.lastCheckinDay || ''
  }
  if (extraData && extraData.makeupCount) {
    nextMember.makeupCount = (member.makeupCount || 0) + 1
  }
  return { member: nextMember, pointsGain }
}

/** 只做记录：更新连续/总次数，不加分 */
async function bumpRecordOnly(member, { updateStreak, day }) {
  if (!member || !member._id) return member
  let streak = member.streak || 0
  let lastCheckinDay = member.lastCheckinDay || ''
  const data = { totalCheckins: _.inc(1) }
  if (updateStreak && lastCheckinDay !== day) {
    streak = lastCheckinDay === yesterdayKey(day) ? (member.streak || 0) + 1 : 1
    lastCheckinDay = day
    data.streak = streak
    data.lastCheckinDay = day
  }
  await db.collection('group_members').doc(member._id).update({ data })
  return {
    ...member,
    streak: data.streak != null ? streak : member.streak || 0,
    totalCheckins: (member.totalCheckins || 0) + 1,
    lastCheckinDay: data.lastCheckinDay != null ? lastCheckinDay : member.lastCheckinDay || ''
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
 * - addHabit / updateHabit / removeHabit / listSyncSources / syncHabits
 * - luckyRoll / poke / ackPokes / ackHonest / titles
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'week'
  const groupId = event.groupId

  if (action === 'recalcAll') {
    if (event.confirm !== 'RECALC') {
      return { ok: false, error: 'confirm_required' }
    }
    const habits = await fetchAll('habits')
    const habitMap = {}
    habits.forEach((h) => {
      if (h && h._id) habitMap[h._id] = h
    })

    const checkins = await fetchAll('checkins')
    const sums = {}
    const checkinPatches = []
    for (let i = 0; i < checkins.length; i++) {
      const c = checkins[i]
      if (!c || !c._id) continue
      let nextGain = 0
      let isRecord = !!c.recordOnly
      if (c.mirrored) {
        nextGain = 0
        if (Number(c.pointsGain) !== 0) {
          checkinPatches.push({ id: c._id, data: { pointsGain: 0 } })
        }
      } else {
        const habit = habitMap[c.habitId]
        const diff = habit ? habit.difficulty : c.recordOnly ? 'record' : 'other'
        isRecord = normalizeDifficulty(diff) === 'record'
        nextGain = isRecord ? 0 : pointsForDifficulty(diff, !!c.isMakeup)
        if (Number(c.pointsGain) !== nextGain || !!c.recordOnly !== isRecord) {
          checkinPatches.push({
            id: c._id,
            data: { pointsGain: nextGain, recordOnly: isRecord }
          })
        }
        const oid = c.openid || c._openid || ''
        const gid = c.groupId || ''
        if (oid && gid) {
          const key = `${gid}__${oid}`
          sums[key] = (sums[key] || 0) + nextGain
        }
      }
    }

    // 先写成员总分，避免超时后右上角还是旧分
    const members = await fetchAll('group_members')
    let membersUpdated = 0
    const memberJobs = []
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      if (!m || !m._id) continue
      const oid = m.openid || m._openid || ''
      const gid = m.groupId || ''
      const next = sums[`${gid}__${oid}`] || 0
      memberJobs.push(
        db
          .collection('group_members')
          .doc(m._id)
          .update({ data: { points: next } })
          .then(() => {
            membersUpdated += 1
          })
      )
      if (memberJobs.length >= 20) {
        await Promise.all(memberJobs.splice(0, memberJobs.length))
      }
    }
    if (memberJobs.length) await Promise.all(memberJobs)

    const claimsRemoved = await removeAllDocs('reward_claims')
    const logsRemoved = await removeRewardLogs()

    // 再回写每条打卡分
    let updated = 0
    const jobs = []
    for (let i = 0; i < checkinPatches.length; i++) {
      const p = checkinPatches[i]
      jobs.push(
        db
          .collection('checkins')
          .doc(p.id)
          .update({ data: p.data })
          .then(() => {
            updated += 1
          })
      )
      if (jobs.length >= 20) {
        await Promise.all(jobs.splice(0, jobs.length))
      }
    }
    if (jobs.length) await Promise.all(jobs)

    return {
      ok: true,
      checkins: checkins.length,
      checkinsUpdated: updated,
      members: members.length,
      membersUpdated,
      claimsRemoved,
      rewardLogsRemoved: logsRemoved,
      sampleSums: Object.keys(sums)
        .slice(0, 5)
        .map((k) => ({ key: k.slice(-8), points: sums[k] }))
    }
  }

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
    const timesPerWeek = normalizeTimesPerWeek(event.timesPerWeek)
    const difficulty = normalizeDifficulty(event.difficulty)
    const addRes = await db.collection('habits').add({
      data: {
        groupId,
        openid: OPENID,
        name,
        emoji,
        color,
        timesPerWeek,
        difficulty,
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

  if (action === 'updateHabit') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const habitId = event.habitId
    if (!habitId) return { ok: false, error: 'habit_required' }
    const name = String(event.name || '').trim().slice(0, 12)
    if (!name) return { ok: false, error: 'name_required' }
    const emoji = String(event.emoji || '✨').trim().slice(0, 4) || '✨'
    const timesPerWeek = normalizeTimesPerWeek(event.timesPerWeek)
    const difficulty = normalizeDifficulty(event.difficulty)

    const doc = await db.collection('habits').doc(habitId).get()
    const habit = doc.data
    if (!habit || habit.groupId !== groupId) return { ok: false, error: 'not_found' }
    const owner = habit.openid || habit._openid
    if (owner !== OPENID) return { ok: false, error: 'forbidden' }

    await db.collection('habits').doc(habitId).update({
      data: { name, emoji, timesPerWeek, difficulty }
    })
    return {
      ok: true,
      habit: { ...habit, _id: habitId, name, emoji, timesPerWeek, difficulty }
    }
  }

  if (action === 'listSyncSources') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }

    let memRes = await db.collection('group_members').where({ openid: OPENID }).limit(50).get()
    if (!(memRes.data || []).length) {
      memRes = await db.collection('group_members').where({ _openid: OPENID }).limit(50).get()
    }
    const otherGroupIds = [
      ...new Set(
        (memRes.data || [])
          .map((m) => m.groupId)
          .filter((gid) => gid && gid !== groupId)
      )
    ]

    const sources = []
    for (let i = 0; i < otherGroupIds.length; i++) {
      const gid = otherGroupIds[i]
      let gName = '其他群'
      try {
        const gDoc = await db.collection('groups').doc(gid).get()
        gName = ((gDoc.data && gDoc.data.name) || '').trim() || gName
      } catch (e) {
        // ignore
      }

      let habitsRes = await db
        .collection('habits')
        .where({ groupId: gid, openid: OPENID })
        .limit(30)
        .get()
      if (!(habitsRes.data || []).length) {
        habitsRes = await db
          .collection('habits')
          .where({ groupId: gid, _openid: OPENID })
          .limit(30)
          .get()
      }
      const habits = (habitsRes.data || [])
        .map((h) => ({
          _id: h._id,
          name: h.name || '',
          emoji: h.emoji || '✨',
          color: h.color || PASTELS[0],
          timesPerWeek: normalizeTimesPerWeek(h.timesPerWeek),
          difficulty: normalizeDifficulty(h.difficulty),
          freqLabel:
            normalizeTimesPerWeek(h.timesPerWeek) >= 7
              ? '每天'
              : `周${normalizeTimesPerWeek(h.timesPerWeek)}次`,
          diffLabel: difficultyLabel(h.difficulty)
        }))
        .filter((h) => h.name)
      if (!habits.length) continue
      sources.push({
        groupId: gid,
        groupName: gName,
        habits
      })
    }

    return { ok: true, sources }
  }

  if (action === 'syncHabits') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const habitIds = Array.isArray(event.habitIds)
      ? event.habitIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 20)
      : []
    if (!habitIds.length) return { ok: false, error: 'empty' }

    const existing = await db
      .collection('habits')
      .where({ groupId, openid: OPENID })
      .limit(30)
      .get()
    const existingList = existing.data || []
    const byName = {}
    existingList.forEach((h) => {
      const n = String(h.name || '').trim()
      if (n && !byName[n]) byName[n] = h
    })
    let room = Math.max(0, 20 - existingList.length)

    let added = 0
    let skipped = 0
    let checkins = 0

    for (let i = 0; i < habitIds.length; i++) {
      const hid = habitIds[i]
      let doc
      try {
        doc = (await db.collection('habits').doc(hid).get()).data
      } catch (e) {
        skipped += 1
        continue
      }
      if (!doc) {
        skipped += 1
        continue
      }
      const owner = doc.openid || doc._openid
      if (owner !== OPENID) {
        skipped += 1
        continue
      }
      if (doc.groupId === groupId) {
        skipped += 1
        continue
      }
      const name = String(doc.name || '').trim().slice(0, 12)
      if (!name) {
        skipped += 1
        continue
      }

      // 同名：只补同步打卡状态，并建立联动
      if (byName[name]) {
        const targetId = byName[name]._id
        await linkHabitsTogether(hid, doc, targetId)
        checkins += await copyHabitCheckins({
          sourceHabitId: hid,
          targetHabitId: targetId,
          targetGroupId: groupId,
          openid: OPENID
        })
        skipped += 1
        continue
      }

      if (room <= 0) {
        skipped += 1
        continue
      }

      const emoji = String(doc.emoji || '✨').trim().slice(0, 8) || '✨'
      const timesPerWeek = normalizeTimesPerWeek(doc.timesPerWeek)
      const difficulty = normalizeDifficulty(doc.difficulty)
      const color = doc.color || PASTELS[(existingList.length + added) % PASTELS.length]
      const linkId = resolveLinkId(doc, hid) || hid
      if (!doc.linkId) {
        try {
          await db.collection('habits').doc(hid).update({ data: { linkId } })
        } catch (e) {
          // ignore
        }
      }
      const addRes = await db.collection('habits').add({
        data: {
          groupId,
          openid: OPENID,
          name,
          emoji,
          color,
          timesPerWeek,
          difficulty,
          sort: existingList.length + added,
          syncedFrom: hid,
          linkId,
          createdAt: db.serverDate()
        }
      })
      const newId = addRes._id
      byName[name] = { _id: newId, name }
      added += 1
      room -= 1

      checkins += await copyHabitCheckins({
        sourceHabitId: hid,
        targetHabitId: newId,
        targetGroupId: groupId,
        openid: OPENID
      })
    }

    return { ok: true, added, skipped, checkins }
  }

  if (action === 'toggle') {
    const habitId = event.habitId
    const day = String(event.day || '')
    if (!habitId || !isValidCheckDay(day)) {
      return { ok: false, error: 'invalid_params' }
    }

    const [me, habitDoc] = await Promise.all([
      ensureMember(groupId, OPENID),
      db.collection('habits').doc(habitId).get()
    ])
    if (!me) return { ok: false, error: 'not_in_group' }

    const today = todayKey()
    const currentWeekStart = weekRange(chinaNow()).startKey
    const slotInfo = parseSlotDay(day)
    const habit = habitDoc.data
    if (!habit || habit.groupId !== groupId) return { ok: false, error: 'not_found' }
    if ((habit.openid || habit._openid) !== OPENID) {
      return { ok: false, error: 'forbidden' }
    }

    const timesPerWeek = normalizeTimesPerWeek(habit.timesPerWeek)
    let isMakeup = false

    if (slotInfo) {
      // 每周 N 次：按周槽位打卡
      if (timesPerWeek >= 7) return { ok: false, error: 'invalid_params' }
      if (slotInfo.slot < 0 || slotInfo.slot >= timesPerWeek) {
        return { ok: false, error: 'invalid_params' }
      }
      if (slotInfo.weekStart > currentWeekStart) {
        return { ok: false, error: 'future_not_allowed' }
      }
      isMakeup = slotInfo.weekStart < currentWeekStart
    } else {
      if (timesPerWeek < 7) return { ok: false, error: 'invalid_params' }
      if (day > today) {
        return { ok: false, error: 'future_not_allowed' }
      }
      isMakeup = day < today
    }

    // habitId + day 即可（打卡项属于个人）
    const found = await db.collection('checkins').where({ habitId, day }).limit(1).get()

    let checked = false
    let member = me
    let pointsGain = 0
    let makeup = isMakeup
    let nightOwl = false
    let weekChampion = false
    const linkId = String(habit.linkId || habit.syncedFrom || '').trim()

    const mirrorIfNeeded = (checkedFlag) => {
      if (!linkId) return Promise.resolve()
      return mirrorLinkedCheckin({
        linkId,
        openid: OPENID,
        day,
        checked: checkedFlag,
        isMakeup: makeup,
        slotInfo,
        excludeHabitId: habitId
      })
    }

    if (found.data[0]) {
      // 取消打卡：这条记过多少分就扣回多少
      const old = found.data[0]
      const back = Number(old.pointsGain) || 0
      await db.collection('checkins').doc(old._id).remove()
      checked = false
      makeup = !!old.isMakeup
      if (back > 0) {
        member = await revertPoints(me, back, { groupId, openid: OPENID, day })
        pointsGain = -back
      }
      try {
        await mirrorIfNeeded(false)
      } catch (e) {
        // ignore mirror errors
      }
      return {
        ok: true,
        checked,
        day,
        habitId,
        isMakeup: makeup,
        pointsGain,
        streak: member.streak || 0,
        points: member.points || 0,
        nightOwl: false,
        weekChampion: false
      }
    }

    // 新打卡：每条打卡项按难度独立计分（镜像记录不计分）
    const recordOnly = normalizeDifficulty(habit.difficulty) === 'record'
    const streakDay = slotInfo ? (isMakeup ? slotInfo.weekStart : today) : day

    if (recordOnly) {
      let existingLen = 1
      const hadAny = await db
        .collection('checkins')
        .where({ groupId, openid: OPENID, day })
        .limit(1)
        .get()
      existingLen = (hadAny.data || []).filter((c) => !c.mirrored).length
      if (!existingLen) {
        member = await bumpRecordOnly(me, {
          updateStreak: !isMakeup,
          day: streakDay
        })
      }
    } else {
      const base = pointsForDifficulty(habit.difficulty, isMakeup)
      const extraData = isMakeup ? { makeupCount: _.inc(1) } : null
      const bumped = await bumpPoints(me, base, {
        updateStreak: !isMakeup,
        day: streakDay,
        groupId,
        openid: OPENID,
        extraData
      })
      member = bumped.member
      pointsGain = bumped.pointsGain

      const hour = chinaHour()
      const nightOk = !isMakeup && hour >= 0 && hour < 5 && (slotInfo || day === today)
      if (nightOk && (member.lastNightOwlDay || '') !== today) {
        await db.collection('group_members').doc(me._id).update({
          data: { points: _.inc(3), nightOwlCount: _.inc(1), lastNightOwlDay: today }
        })
        const bal = (member.points || 0) + 3
        await db.collection('point_logs').add({
          data: {
            groupId,
            openid: OPENID,
            delta: 3,
            balance: bal,
            reason: 'night_owl',
            title: '夜猫子认证 +3',
            refId: day,
            createdAt: db.serverDate()
          }
        })
        member = {
          ...member,
          points: bal,
          nightOwlCount: (me.nightOwlCount || 0) + 1,
          lastNightOwlDay: today
        }
        pointsGain += 3
        nightOwl = true
      }
    }

    const checkData = {
      groupId,
      openid: OPENID,
      habitId,
      day,
      streakDay,
      isMakeup,
      recordOnly,
      pointsGain: recordOnly ? 0 : pointsGain,
      createdAt: db.serverDate()
    }
    if (slotInfo) {
      checkData.weekStart = slotInfo.weekStart
      checkData.slot = slotInfo.slot
    }
    await db.collection('checkins').add({ data: checkData })
    checked = true
    makeup = isMakeup

    try {
      await mirrorIfNeeded(true)
    } catch (e) {
      // ignore mirror errors
    }

    return {
      ok: true,
      checked,
      day,
      habitId,
      isMakeup: makeup,
      pointsGain,
      streak: member.streak || 0,
      points: member.points || 0,
      nightOwl,
      weekChampion
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
        sort: h.sort || 0,
        timesPerWeek: normalizeTimesPerWeek(h.timesPerWeek),
        difficulty: normalizeDifficulty(h.difficulty)
      }))
      .sort((a, b) => a.sort - b.sort)

    const weekQueryDays = dayKeys.concat(slotKeysForHabits(startKey, habits))

    // 拉本周打卡（按 openid；量小可 where day in）
    let checks = []
    if (habits.length && weekQueryDays.length) {
      const c1 = await db
        .collection('checkins')
        .where({
          groupId,
          openid: targetOpenid,
          day: _.in(weekQueryDays)
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
            day: _.in(weekQueryDays)
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
    const currentWeekStart = weekRange(chinaNow()).startKey
    const weekIsFuture = startKey > currentWeekStart
    const weekIsPast = startKey < currentWeekStart

    const grid = habits.map((h) => {
      const timesPerWeek = normalizeTimesPerWeek(h.timesPerWeek)
      const weekly = timesPerWeek < 7
      if (weekly) {
        const cells = []
        for (let i = 0; i < timesPerWeek; i++) {
          const key = slotDayKey(startKey, i)
          cells.push({
            day: key,
            slot: i,
            checked: !!doneMap[`${h._id}_${key}`],
            isMakeup: !!makeupMap[`${h._id}_${key}`] || (weekIsPast && !!doneMap[`${h._id}_${key}`]),
            future: weekIsFuture,
            canCheck: !weekIsFuture,
            isToday: false
          })
        }
        return {
          habitId: h._id,
          name: h.name,
          emoji: h.emoji,
          color: h.color,
          timesPerWeek,
          weekly: true,
          difficulty: normalizeDifficulty(h.difficulty),
          freqLabel: `周${timesPerWeek}次`,
          diffLabel: difficultyLabel(h.difficulty),
          cells
        }
      }
      return {
        habitId: h._id,
        name: h.name,
        emoji: h.emoji,
        color: h.color,
        timesPerWeek: 7,
        weekly: false,
        difficulty: normalizeDifficulty(h.difficulty),
        freqLabel: '每天',
        diffLabel: difficultyLabel(h.difficulty),
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
      }
    })

    // 全员日/周/月积分排名（按打卡所得 pointsGain）
    const membersRes = await db.collection('group_members').where({ groupId }).limit(50).get()
    const members = membersRes.data || []
    const monthMeta = monthRange(parseAnchor(startKey))
    const dayEnd = todayStr < monthMeta.endKey ? todayStr : monthMeta.endKey

    async function loadChecksByDayRange(fromKey, nextKey) {
      try {
        const res = await db
          .collection('checkins')
          .where({
            groupId,
            day: _.gte(fromKey).and(_.lt(nextKey))
          })
          .limit(1000)
          .get()
        return res.data || []
      } catch (e) {
        return null
      }
    }

    let monthChecks = await loadChecksByDayRange(monthMeta.startKey, monthMeta.nextStartKey)
    if (!monthChecks) {
      const allHabitsRes = await db.collection('habits').where({ groupId }).limit(500).get()
      const allHabits = allHabitsRes.data || []
      const allQueryDays = dayKeys.concat(slotKeysForHabits(startKey, allHabits))
      const weekChecksRes = await db
        .collection('checkins')
        .where({ groupId, day: _.in(allQueryDays.length ? allQueryDays : dayKeys) })
        .limit(1000)
        .get()
      monthChecks = weekChecksRes.data || []
    }

    // 日进度固定看「今天」，跨月翻周时补拉今日记录
    let dayChecks = monthChecks
    const todayMonth = monthRange(chinaNow())
    if (todayMonth.startKey !== monthMeta.startKey) {
      const extra = await loadChecksByDayRange(todayMonth.startKey, todayMonth.nextStartKey)
      dayChecks = extra || []
    }

    const dayPoints = {}
    const weekPoints = {}
    const monthPoints = {}
    dayChecks.forEach((c) => {
      const oid = checkinOwner(c)
      if (!oid) return
      const pts = checkinPoints(c)
      if (!pts) return
      if (String(c.day || '') === todayStr) {
        dayPoints[oid] = (dayPoints[oid] || 0) + pts
      }
    })
    monthChecks.forEach((c) => {
      const oid = checkinOwner(c)
      if (!oid) return
      const pts = checkinPoints(c)
      if (!pts) return
      if (checkinInRange(c, startKey, days[6].key)) {
        weekPoints[oid] = (weekPoints[oid] || 0) + pts
      }
      if (checkinInRange(c, monthMeta.startKey, dayEnd)) {
        monthPoints[oid] = (monthPoints[oid] || 0) + pts
      }
    })

    const dayProgress = buildPointsRank(members, dayPoints, OPENID)
    const weekProgress = buildPointsRank(members, weekPoints, OPENID)
    const monthProgress = buildPointsRank(members, monthPoints, OPENID)

    const targetOid = pair.target.openid || pair.target._openid || targetOpenid
    const nick = (pair.target.nickName || '').trim()

    const top = weekProgress.find((p) => (p.points || 0) > 0)
    const weekChampion = top
      ? {
          name: top.displayName,
          openid: top.openid,
          isMe: !!top.isMe,
          points: top.points || 0
        }
      : null

    // 连续险断：昨天有打卡、今天还没有（仅自己）
    let streakRisk = false
    if (targetOpenid === OPENID && (pair.target.streak || 0) > 0) {
      const y = chinaNow()
      y.setDate(y.getDate() - 1)
      const yKey = dayKey(y)
      const [yRes, tRes] = await Promise.all([
        db.collection('checkins').where({ groupId, openid: OPENID, day: yKey }).limit(1).get(),
        db.collection('checkins').where({ groupId, openid: OPENID, day: todayStr }).limit(1).get()
      ])
      streakRisk = (yRes.data || []).length > 0 && !(tRes.data || []).length
    }

    const nowWeek = weekRange(chinaNow()).startKey
    const luckyAvailable =
      targetOpenid === OPENID && (pair.target.lastLuckyWeek || '') !== nowWeek

    const pendingPokes =
      targetOpenid === OPENID ? (pair.target.pendingPokes || []).slice(-10) : []

    let checkinDays = 0
    let consecutiveStreak = pair.target.streak || 0
    try {
      const histRows = await loadMemberCheckins(groupId, targetOpenid)
      checkinDays = countUniqueCheckinDays(histRows)
      consecutiveStreak = consecutiveStreakFromCheckins(histRows, todayStr)
      if (
        targetOpenid === OPENID &&
        pair.target._id &&
        (pair.target.streak || 0) !== consecutiveStreak
      ) {
        await db
          .collection('group_members')
          .doc(pair.target._id)
          .update({ data: { streak: consecutiveStreak } })
      }
    } catch (e) {
      checkinDays = pair.target.streak || 0
    }

    return {
      ok: true,
      weekStart: startKey,
      rangeLabel,
      days,
      habits,
      grid,
      weekProgress,
      dayProgress,
      monthProgress,
      isMe: targetOpenid === OPENID,
      targetOpenid,
      targetName: nick || `Buddy ${String(targetOid).slice(-4)}`,
      streak: consecutiveStreak,
      checkinDays,
      consecutiveStreak,
      points: pair.target.points || 0,
      today: todayStr,
      weekChampion,
      streakRisk,
      luckyAvailable,
      pendingPokes,
      titles: targetOpenid === OPENID ? computeTitles(pair.target) : []
    }
  }

  if (action === 'luckyRoll') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const nowWeek = weekRange(chinaNow()).startKey
    if ((me.lastLuckyWeek || '') === nowWeek) {
      return { ok: false, error: 'already' }
    }
    const amount = 5 + Math.floor(Math.random() * 16) // 5–20
    const bal = (me.points || 0) + amount
    await db.collection('group_members').doc(me._id).update({
      data: {
        points: _.inc(amount),
        lastLuckyWeek: nowWeek,
        luckyCount: _.inc(1)
      }
    })
    await db.collection('point_logs').add({
      data: {
        groupId,
        openid: OPENID,
        delta: amount,
        balance: bal,
        reason: 'lucky_roll',
        title: `运气打卡 +${amount}`,
        refId: nowWeek,
        createdAt: db.serverDate()
      }
    })
    return { ok: true, amount, points: bal }
  }

  if (action === 'poke') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    const targetOpenid = String(event.targetOpenid || '').trim()
    if (!targetOpenid || targetOpenid === OPENID) {
      return { ok: false, error: 'invalid_target' }
    }
    const pair = await assertSameGroup(groupId, OPENID, targetOpenid)
    if (!pair) return { ok: false, error: 'not_in_group' }
    const fromName = (me.nickName || '').trim() || `Buddy ${String(OPENID).slice(-4)}`
    const poke = {
      from: OPENID,
      name: fromName,
      at: Date.now()
    }
    const prev = pair.target.pendingPokes || []
    const next = prev.filter((p) => p.from !== OPENID).concat([poke]).slice(-20)
    await db.collection('group_members').doc(pair.target._id).update({
      data: { pendingPokes: next }
    })
    return { ok: true }
  }

  if (action === 'ackPokes') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    await db.collection('group_members').doc(me._id).update({
      data: { pendingPokes: [] }
    })
    return { ok: true }
  }

  if (action === 'ackHonest') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    await db.collection('group_members').doc(me._id).update({
      data: { honestCount: _.inc(1) }
    })
    return { ok: true, honestCount: (me.honestCount || 0) + 1 }
  }

  if (action === 'titles') {
    const me = await ensureMember(groupId, OPENID)
    if (!me) return { ok: false, error: 'not_in_group' }
    return {
      ok: true,
      titles: computeTitles(me),
      makeupCount: me.makeupCount || 0,
      nightOwlCount: me.nightOwlCount || 0,
      honestCount: me.honestCount || 0,
      perfectWeekCount: me.perfectWeekCount || 0,
      luckyCount: me.luckyCount || 0
    }
  }

  return { ok: false, error: 'unknown_action' }
}
