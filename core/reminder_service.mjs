const TZ = 'Asia/Hong_Kong';
const DEFAULT_RECIPIENT = '';

export const DEFAULT_SCHEDULE = {
  oa: [
    { key: 'D-3', days: 3, time: '09:00', enabled: true },
    { key: 'D-2', days: 2, time: '09:00', enabled: true },
    { key: 'D-1', days: 1, time: '09:00', enabled: true },
    { key: 'D0', days: 0, time: '08:00', enabled: true },
  ],
  interview: [
    { key: 'D-1', days: 1, time: '09:00', enabled: true },
    { key: 'D0', days: 0, time: '08:00', enabled: true },
    { key: 'T-2H', minutes_before: 120, time: '', enabled: true },
  ],
  offer: [
    { key: 'D-3', days: 3, time: '09:00', enabled: true },
    { key: 'D-2', days: 2, time: '09:00', enabled: true },
    { key: 'D-1', days: 1, time: '09:00', enabled: true },
    { key: 'D0', days: 0, time: '08:00', enabled: true },
  ],
  application: [
    { key: 'D-2', days: 2, time: '09:00', enabled: true },
    { key: 'D-1', days: 1, time: '09:00', enabled: true },
  ],
};

const clone = value => JSON.parse(JSON.stringify(value));
const clean = value => value == null ? '' : String(value).trim();
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(clean(value));
const validTime = value => /^\d{2}:\d{2}$/.test(clean(value));

function settingRow(state, key) { return (state.settings || []).find(row => row.key === key); }
function profileEmail(state) {
  const row = (state.profile || []).find(item => item.key === 'candidate');
  try { return JSON.parse(row?.value || '{}').email || DEFAULT_RECIPIENT; } catch (_) { return DEFAULT_RECIPIENT; }
}

export function getReminderSettings(state) {
  const row = settingRow(state, 'reminder_settings');
  let saved = {};
  try { saved = JSON.parse(row?.value || '{}'); } catch (_) { saved = {}; }
  const schedule = {};
  for (const [kind, rules] of Object.entries(DEFAULT_SCHEDULE)) {
    schedule[kind] = (Array.isArray(saved.schedule?.[kind]) ? saved.schedule[kind] : rules).map(rule => ({ ...rule, enabled: rule.enabled !== false }));
  }
  return {
    enabled: saved.enabled === true,
    sender_email: clean(saved.sender_email),
    recipient_email: clean(saved.recipient_email || profileEmail(state)),
    timezone: TZ,
    schedule,
    updated_at: clean(saved.updated_at || row?.updated_at),
  };
}

export function normalizeReminderSettings(input, state) {
  const current = getReminderSettings(state);
  const result = {
    enabled: input.enabled === true || input.enabled === 'true',
    sender_email: clean(input.sender_email || current.sender_email),
    recipient_email: clean(input.recipient_email || current.recipient_email || profileEmail(state)),
    timezone: TZ,
    schedule: {},
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.sender_email)) throw Object.assign(new Error('请输入有效的 QQ Mail 发件邮箱。'), { code: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.recipient_email)) throw Object.assign(new Error('请输入有效的收件邮箱。'), { code: 400 });
  for (const [kind, defaults] of Object.entries(DEFAULT_SCHEDULE)) {
    const incoming = Array.isArray(input.schedule?.[kind]) ? input.schedule[kind] : current.schedule[kind] || defaults;
    result.schedule[kind] = incoming.map((rule, index) => {
      const fallback = defaults[index] || {};
      const normalized = {
        key: clean(rule.key || fallback.key || `${kind}-${index}`),
        enabled: rule.enabled !== false,
        time: validTime(rule.time) ? clean(rule.time) : clean(fallback.time),
      };
      if (rule.minutes_before != null || fallback.minutes_before != null) normalized.minutes_before = Math.max(1, Math.min(1440, Number(rule.minutes_before ?? fallback.minutes_before)));
      else normalized.days = Math.max(0, Math.min(60, Number.isFinite(Number(rule.days)) ? Number(rule.days) : Number(fallback.days || 0)));
      return normalized;
    });
  }
  return result;
}

export function settingsToValue(settings) { return JSON.stringify({ ...settings, updated_at: new Date().toISOString() }); }

function eventMap(state) { return new Map((state.applicationEvents || []).filter(row => !row.deleted_at).map(row => [row.event_id, row])); }
function appMap(state) { return new Map((state.applications || []).map(row => [row.application_id, row])); }
function jobMap(state) { return new Map((state.jobs || []).filter(row => !row.deleted_at).map(row => [row.job_id, row])); }
function terminal(app) { return ['Rejected', 'Withdrawn'].includes(app?.status) || ['Rejected', 'Withdrawn'].includes(app?.current_stage); }
function localDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function localDate(date) { const p = localDateParts(date); return `${p.year}-${p.month}-${p.day}`; }
function atLocal(date, time = '00:00') { return new Date(`${date}T${validTime(time) ? time : '00:00'}:00+08:00`); }
function addDays(date, days) { const [year, month, day] = String(date).split('-').map(Number); const result = new Date(Date.UTC(year, month - 1, day + Number(days))); return result.toISOString().slice(0, 10); }
function endOfDay(date) { return atLocal(date, '23:59'); }
function remaining(deadline, now = new Date()) {
  const days = Math.ceil((atLocal(deadline, '00:00').getTime() - atLocal(localDate(now), '00:00').getTime()) / 86400000);
  if (days <= 0) return '今天截止';
  return `还有${days}天`;
}
function sendAt(deadline, rule, eventTime) {
  if (rule.minutes_before != null) {
    if (!validTime(eventTime)) return null;
    return new Date(atLocal(deadline, eventTime).getTime() - Number(rule.minutes_before) * 60000);
  }
  return atLocal(addDays(deadline, -Number(rule.days || 0)), rule.time || '09:00');
}
function candidateFor({ kind, app, job, event, deadline, rule, now }) {
  const title = kind === 'oa' ? 'OA 截止' : kind === 'interview' ? '面试提醒' : kind === 'offer' ? 'Offer 截止' : '申请截止';
  const company = app?.company || job?.company || '';
  const jobTitle = app?.job_title || job?.job_title || '';
  const idPart = app?.application_id || job?.job_id || '';
  const eventId = event?.event_id || '';
  const key = [idPart, eventId, deadline, rule.key].join('|');
  const scheduledAt = sendAt(deadline, rule, event?.event_time);
  if (!scheduledAt || scheduledAt > now || endOfDay(deadline) < now) return null;
  return {
    reminder_key: key,
    kind,
    application_id: app?.application_id || '',
    event_id: eventId,
    job_id: app?.job_id || job?.job_id || '',
    company,
    job_title: jobTitle,
    task: title,
    deadline,
    deadline_time: validTime(event?.event_time) ? event.event_time : '',
    threshold: rule.key,
    send_at: scheduledAt.toISOString(),
    remaining: remaining(deadline, now),
    current_status: app?.current_stage || app?.status || job?.status || '待处理',
    application_url: app?.job_url || job?.job_url || job?.official_url || '',
    assessment_url: event?.assessment_url || event?.url || '',
  };
}

export function pendingReminderCandidates(state, now = new Date()) {
  const settings = getReminderSettings(state);
  const apps = appMap(state), jobs = jobMap(state), events = eventMap(state);
  const rows = [];
  for (const event of events.values()) {
    const app = apps.get(event.application_id);
    if (!app || terminal(app)) continue;
    if (event.event_type === 'OA Received' && validDate(event.deadline)) {
      const completed = [...events.values()].some(other => other.application_id === app.application_id && other.event_type === 'OA Completed' && !other.deleted_at && `${other.event_date}T${other.event_time || ''}` >= `${event.event_date}T${event.event_time || ''}`);
      if (!completed) for (const rule of settings.schedule.oa.filter(item => item.enabled)) { const row = candidateFor({ kind: 'oa', app, event, deadline: event.deadline, rule, now }); if (row) rows.push(row); }
    }
    if (event.event_type === 'Interview Invitation') {
      const completed = [...events.values()].some(other => other.application_id === app.application_id && other.event_type === 'Interview Completed' && !other.deleted_at && (!event.round || other.round === event.round));
      const deadline = validDate(event.deadline) ? event.deadline : event.event_date;
      if (!completed && validDate(deadline)) for (const rule of settings.schedule.interview.filter(item => item.enabled)) { const row = candidateFor({ kind: 'interview', app, event, deadline, rule, now }); if (row) rows.push(row); }
    }
    if (event.event_type === 'Offer' && validDate(event.deadline)) for (const rule of settings.schedule.offer.filter(item => item.enabled)) { const row = candidateFor({ kind: 'offer', app, event, deadline: event.deadline, rule, now }); if (row) rows.push(row); }
  }
  for (const job of jobs.values()) {
    if (!validDate(job.application_deadline) || !['Potential', 'To Review', 'Interested', 'To Apply'].includes(job.status) || job.current_validity !== 'Validated + Active') continue;
    if ([...apps.values()].some(app => app.job_id === job.job_id && !terminal(app))) continue;
    for (const rule of settings.schedule.application.filter(item => item.enabled)) { const row = candidateFor({ kind: 'application', job, deadline: job.application_deadline, rule, now }); if (row) rows.push(row); }
  }
  return rows.sort((a, b) => a.deadline.localeCompare(b.deadline) || a.send_at.localeCompare(b.send_at));
}

export function buildReminderEmail(candidate, baseUrl = 'http://127.0.0.1:8420/') {
  const subject = `【${candidate.remaining}】${candidate.company} ${candidate.job_title} 截止提醒`;
  const lines = [
    `${candidate.company}`,
    `${candidate.job_title}`,
    `任务：${candidate.task}`,
    `截止日期：${candidate.deadline}${candidate.deadline_time ? ` ${candidate.deadline_time}` : ''}`,
    `剩余：${candidate.remaining}`,
    `当前状态：${candidate.current_status}`,
    '',
    `打开 CareerPilot：${baseUrl}`,
  ];
  if (candidate.assessment_url) lines.push(`测评链接：${candidate.assessment_url}`);
  return { subject, text: lines.join('\n') };
}
