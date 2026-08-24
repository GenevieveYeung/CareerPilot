/*
 * Application workflow projection.
 *
 * Application Events remain the only source of truth. This file only changes
 * the views: timeline uses event_date; calendar and action items use the
 * appropriate deadline or scheduled event time.
 */
(() => {
  const I18n = window.CareerPilotI18n || { status: value => value, event: value => value, taskLabel: item => `${item.type || '截止日期'}：${item.date || '—'}`, deadlineLabel: item => item.type || '截止日期', remaining: () => '日期未设置', UI: {} };
  if (!document.getElementById('workflow-calendar-styles')) {
    const style = document.createElement('style');
    style.id = 'workflow-calendar-styles';
    style.textContent = `
      .calgrid .calendar { min-width: 0; }
      .calendar .month { grid-template-rows: repeat(6, minmax(130px, 1fr)); }
      .calendar .day { height: 130px; min-height: 130px; min-width: 0; overflow: hidden; }
      .calendar .day-number { display: block; line-height: 18px; }
      .calendar .day-events { min-width: 0; overflow: hidden; }
      .calendar .event, .calendar-day-list .event { display: block; width: 100%; max-width: 100%; min-width: 0; height: 33px; box-sizing: border-box; padding: 4px 6px; border: 1px solid var(--event-border); border-left-width: 3px; background: var(--event-bg) !important; color: var(--event-fg) !important; white-space: normal; overflow: hidden; text-overflow: clip; }
      .calendar .event-copy, .calendar-day-list .event-copy { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.22; }
      .calendar .event-copy span, .calendar-day-list .event-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .calendar .event-more { display: block; max-width: 100%; margin-top: 3px; padding: 0 5px; border: 0; background: transparent; color: var(--muted); font-size: 11px; cursor: pointer; }
      .calendar .event-more:hover { color: var(--ink); text-decoration: underline; }
      .cal-overdue { --event-bg: #fee2e2; --event-border: #b91c1c; --event-fg: #991b1b; }
      .cal-today { --event-bg: #fecaca; --event-border: #dc2626; --event-fg: #991b1b; }
      .cal-soon { --event-bg: #fef3c7; --event-border: #f59e0b; --event-fg: #92400e; }
      .cal-week { --event-bg: #dbeafe; --event-border: #3b82f6; --event-fg: #1d4ed8; }
      .cal-later { --event-bg: #f1f5f9; --event-border: #94a3b8; --event-fg: #526277; }
      .cal-interview { --event-bg: #ede9fe; --event-border: #8b5cf6; --event-fg: #6d28d9; }
      .cal-completed { --event-bg: #f3f4f6; --event-border: #9ca3af; --event-fg: #6b7280; }
      .calendar .event.cal-completed { text-decoration: line-through; text-decoration-color: #9ca3af; }
      .todo.cal-overdue, .todo.cal-today, .todo.cal-soon, .todo.cal-week, .todo.cal-later, .todo.cal-interview, .todo.cal-completed { border-left: 3px solid var(--event-border); padding-left: 9px; }
      .todo.cal-overdue .date, .todo.cal-today .date, .todo.cal-soon .date, .todo.cal-week .date, .todo.cal-later .date, .todo.cal-interview .date, .todo.cal-completed .date { color: var(--event-fg); }
      .todo.cal-completed { opacity: .78; }
      .calgrid .todo { display: grid; grid-template-columns: minmax(52px, 64px) minmax(0, 1fr); align-items: start; min-width: 0; border-left: 3px solid var(--event-border, transparent); padding-left: 9px; }
      .calgrid .todo .date, .todo-date { width: auto; min-width: 52px; white-space: nowrap; flex-shrink: 0; color: var(--event-fg, var(--blue)); }
      .calgrid .todo-main { min-width: 0; }
      .calgrid .todo-company, .calgrid .todo-job { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .calgrid .todo .sub { min-width: 0; }
      .calgrid .todo .event-type-label { color: var(--event-fg, inherit); font-weight: 700; }
      .calendar-day-list { display: grid; gap: 7px; margin-top: 12px; }
      .calendar-day-list .event { height: auto; min-height: 36px; }
      .tag.gray { background: #f1f5f9; color: #64748b; }
      .application-list-note { margin: -8px 0 14px; }
      .application-row-deadline { color: var(--amber); font-weight: 700; }
      .application-row-waiting { color: var(--muted); }
      .application-deadlines { display: grid; gap: 8px; }
      .application-deadline { display: flex; justify-content: space-between; gap: 14px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 9px; background: #fafbfc; }
      .application-deadline.overdue { border-color: #fecaca; background: #fff7f7; color: #991b1b; }
      .application-deadline.soon { border-color: #fed7aa; background: #fffaf3; color: #92400e; }
      .resume-material-layout, .resume-material-stack { display: flex; flex-direction: column; gap: 16px; align-items: stretch; width: 100%; min-width: 0; }
      .resume-material-layout > .resume-application-block, .resume-material-stack > .resume-application-block { width: 100%; min-width: 0; }
      .resume-application-block { width: 100%; min-width: 0; overflow-wrap: normal; word-break: normal; }
      .resume-application-block .resume-file-line { display: grid; grid-template-columns: 124px minmax(0, 1fr) auto; gap: 9px; align-items: center; margin-top: 9px; min-width: 0; }
      .resume-application-block .resume-file-line b { min-width: 0; overflow-wrap: anywhere; word-break: normal; }
      .resume-application-block .resume-file-line .btn { white-space: nowrap; flex-shrink: 0; }
      @media (max-width: 850px) { .resume-application-block .resume-file-line { grid-template-columns: 104px minmax(0, 1fr) auto; gap: 7px; } }
      @media (max-width: 1100px) {
        .calgrid { grid-template-columns: minmax(0, 1fr) 290px; }
      }
      @media (max-width: 850px) {
        .calendar .month { grid-template-rows: repeat(6, minmax(112px, 1fr)); }
        .calendar .day { height: 112px; min-height: 112px; padding: 5px; }
        .calendar .event { height: 29px; padding: 3px 4px; font-size: 10px; }
        .calgrid .todo { grid-template-columns: 58px minmax(0, 1fr); }
      }
    `;
    document.head.appendChild(style);
  }

  const activeEvents = applicationId => (S.applicationEvents || [])
    .filter(event => event.application_id === applicationId && !event.deleted_at)
    .sort((a, b) => `${b.event_date} ${b.event_time || ''}|${b.created_at || ''}`.localeCompare(`${a.event_date} ${a.event_time || ''}|${a.created_at || ''}`));

  const latestEvent = (applicationId, type) => activeEvents(applicationId).find(event => event.event_type === type);
  const hasEvent = (applicationId, types) => activeEvents(applicationId).some(event => types.includes(event.event_type));

  const dateNumber = value => {
    const match = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? Date.UTC(+match[1], +match[2] - 1, +match[3]) / 86400000 : NaN;
  };
  const dayDelta = value => dateNumber(value) - dateNumber(today());
  const remaining = (value, kind = 'deadline') => {
    const delta = dayDelta(value);
    if (!Number.isFinite(delta)) return '未设置日期';
    if (delta < 0) return `已逾期 ${Math.abs(delta)} 天`;
    if (kind === 'interview') return delta === 0 ? '今天面试' : `${delta} 天后面试`;
    if (delta === 0) return '今天截止';
    return `还有 ${delta} 天`;
  };
  const urgencyClass = value => {
    const delta = dayDelta(value);
    if (delta <= 0) return 'red';
    if (delta <= 3) return 'amber';
    if (delta <= 7) return 'blue';
    return '';
  };
  const urgencyLabel = (value, kind) => tag(remaining(value, kind), urgencyClass(value));

  function eventCalendarItems(application, event) {
    const type = event.event_type;
    const relatedEvents = activeEvents(application.application_id);
    const completedOA = relatedEvents.some(item => item.event_type === 'OA Completed' && (!event.round || item.round === event.round));
    const completedInterview = relatedEvents.some(item => item.event_type === 'Interview Completed' && (!event.round || item.round === event.round));
    const closed = hasEvent(application.application_id, ['Rejected', 'Withdrawn']);
    const items = [];
    if (type === 'OA Received' && event.deadline) {
      items.push({ id: `deadline-${event.event_id}`, event_id: event.event_id, date: fmt(event.deadline), time: event.deadline_time || '', type: 'OA 截止', title: '在线测评截止', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: 'deadline', completed: completedOA || closed });
    } else if (type === 'Interview Invitation' && event.event_date) {
      items.push({ id: `interview-${event.event_id}`, event_id: event.event_id, date: fmt(event.event_date), time: event.event_time || '', type: '面试', title: event.round ? `面试 · ${event.round}` : '面试', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: 'interview', completed: completedInterview || closed });
    } else if (type === 'Assessment Centre' && event.event_date) {
      items.push({ id: `assessment-${event.event_id}`, event_id: event.event_id, date: fmt(event.event_date), time: event.event_time || '', type: 'Assessment Centre', title: event.title || 'Assessment Centre', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: 'interview', completed: closed });
    } else if (type === 'Offer' && (event.deadline || event.event_date)) {
      const date = event.deadline || event.event_date;
      items.push({ id: `offer-${event.event_id}`, event_id: event.event_id, date: fmt(date), time: event.deadline ? (event.deadline_time || '') : (event.event_time || ''), type: event.deadline ? 'Offer 截止' : 'Offer', title: event.title || 'Offer', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: event.deadline ? 'deadline' : 'interview', completed: closed });
    } else if (type === 'Follow-up' && (event.deadline || event.event_date)) {
      const date = event.deadline || event.event_date;
      items.push({ id: `followup-${event.event_id}`, event_id: event.event_id, date: fmt(date), time: event.deadline ? (event.deadline_time || '') : (event.event_time || ''), type: '跟进', title: event.title || '跟进', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: 'deadline', completed: closed });
    } else if (event.deadline) {
      items.push({ id: `deadline-${event.event_id}`, event_id: event.event_id, date: fmt(event.deadline), time: '', type: '截止', title: event.title || '申请事项截止', job_title: application.job_title, company: application.company, application_id: application.application_id, kind: 'deadline', completed: closed });
    }
    return items;
  }

  function workflowCalEvents() {
    const output = [];
    (S.jobs || []).filter(job => job.application_deadline && !job.deleted_at && job.current_validity === 'Validated + Active' && ['Potential', 'To Review', 'Interested', 'To Apply'].includes(job.status)).forEach(job => {
      output.push({ id: `job-deadline-${job.job_id}`, date: fmt(job.application_deadline), time: '', type: '申请截止', title: job.job_title, job_title: job.job_title, company: job.company, job_id: job.job_id, kind: 'application', completed: false });
    });
    (S.applications || []).filter(application => application.status !== 'Skipped').forEach(application => activeEvents(application.application_id).forEach(event => output.push(...eventCalendarItems(application, event))));
    (S.calendarEvents || []).filter(event => !event.deleted_at && event.source_type === 'Manual').forEach(event => {
      const application = event.application_id && (S.applications || []).find(item => item.application_id === event.application_id);
      output.push({ id: `manual-${event.event_id}`, event_id: event.event_id, date: fmt(event.event_date), time: event.event_time || '', type: event.event_type || '事项', title: event.title, job_title: application?.job_title || '', company: event.company || application?.company, application_id: event.application_id, kind: 'manual', completed: event.status === 'Completed' });
    });
    return output;
  }

  function openItemsFor(application) {
    if (hasEvent(application.application_id, ['Rejected', 'Withdrawn'])) return [];
    return workflowCalEvents().filter(item => item.application_id === application.application_id && !item.completed).sort((a, b) => {
      const ad = dayDelta(a.date), bd = dayDelta(b.date);
      const aWeight = a.kind === 'application' ? 1 : 0;
      const bWeight = b.kind === 'application' ? 1 : 0;
      return (ad < 0 ? -100000 : ad) - (bd < 0 ? -100000 : bd) || aWeight - bWeight;
    });
  }

  function nextAction(application) {
    const item = openItemsFor(application)[0];
    if (item) return applicationTaskLabel(item);
    return application.next_action || '等待进展';
  }

  const closedApplicationStages = ['Rejected', 'Withdrawn', 'Closed', 'Closed / Expired'];
  const progressedApplicationLabels = ['在线测评', '面试', '终面', 'Offer'];

  function isClosedApplication(application) {
    return closedApplicationStages.includes(cur(application)) || hasEvent(application.application_id, ['Rejected', 'Withdrawn']);
  }

  function applicationStatusLabel(application) {
    const current = cur(application);
    if (current === 'Rejected') return I18n.status('rejected');
    if (current === 'Withdrawn') return I18n.status('withdrawn');
    if (current === 'Closed' || current === 'Closed / Expired') return I18n.status('closed');
    if (current === 'Offer') return I18n.status('offer');
    const eventRows = activeEvents(application.application_id);
    const finalRound = eventRows.some(event => ['Interview Invitation', 'Interview Completed', 'Assessment Centre'].includes(event.event_type) && /final|last|assessment centre|superday/i.test(`${event.round || ''} ${event.title || ''}`));
    if (finalRound) return I18n.status('final_round');
    if (current === 'Interview' || eventRows.some(event => ['Interview Invitation', 'Interview Completed', 'Assessment Centre'].includes(event.event_type))) return I18n.status('interview');
    if (current === 'Online Assessment' || eventRows.some(event => ['OA Received', 'OA Completed'].includes(event.event_type))) return I18n.status('oa_received');
    if (current === 'Under review') return I18n.status('under_review');
    return I18n.status('submitted');
  }

  function applicationStatusClass(label) {
    if (progressedApplicationLabels.includes(label)) return 'green';
    if (['已投递', '审核中'].includes(label)) return 'blue';
    return 'gray';
  }

  function applicationFilterBucket(application) {
    if (isClosedApplication(application)) return 'rejected';
    if (openItemsFor(application).length) return 'need-action';
    return progressedApplicationLabels.includes(applicationStatusLabel(application)) ? 'active' : 'waiting';
  }

  function applicationTaskLabel(item) {
    return I18n.taskLabel(item, dayDelta);
  }

  function applicationSort(a, b) {
    const rank = { 'need-action': 0, active: 1, waiting: 2, rejected: 3 };
    const ar = rank[applicationFilterBucket(a)], br = rank[applicationFilterBucket(b)];
    if (ar !== br) return ar - br;
    const at = openItemsFor(a)[0], bt = openItemsFor(b)[0];
    const ad = at ? dayDelta(at.date) : Infinity, bd = bt ? dayDelta(bt.date) : Infinity;
    if (ar === 0 && ad !== bd) return ad - bd;
    return `${b.attempt_date || ''}|${b.updated_at || ''}`.localeCompare(`${a.attempt_date || ''}|${a.updated_at || ''}`);
  }

  function applicationDeadlineItems(application) {
    return workflowCalEvents()
      .filter(item => item.application_id === application.application_id && item.date)
      .sort((a, b) => dayDelta(a.date) - dayDelta(b.date));
  }

  // One display model for Calendar, Upcoming and the Dashboard action list.
  // This is deliberately derived from the existing event projection: it does
  // not write data or change application-stage logic.
  function getEventVisualState(item) {
    if (item.completed) return { key: 'completed', className: 'cal-completed', label: '✓ 已完成', rank: 9 };
    const delta = dayDelta(item.date);
    if (item.kind === 'interview') {
      if (delta < 0) return { key: 'interview-past', className: 'cal-interview', label: '已开始', rank: 8 };
      if (delta === 0) return { key: 'interview-today', className: 'cal-interview', label: '今天', rank: 2 };
      if (delta === 1) return { key: 'interview-tomorrow', className: 'cal-interview', label: '明天', rank: 2 };
      return { key: 'interview', className: 'cal-interview', label: `还有 ${delta} 天`, rank: delta <= 3 ? 2 : delta <= 7 ? 4 : 5 };
    }
    if (!Number.isFinite(delta)) return { key: 'unknown', className: 'cal-later', label: '日期未设置', rank: 8 };
    if (delta < 0) return { key: 'overdue', className: 'cal-overdue', label: '已逾期', rank: 0 };
    if (delta === 0) return { key: 'today', className: 'cal-today', label: '今天截止', rank: 1 };
    if (delta <= 3) return { key: 'soon', className: 'cal-soon', label: `还有 ${delta} 天`, rank: 2 };
    if (delta <= 7) return { key: 'week', className: 'cal-week', label: `还有 ${delta} 天`, rank: 4 };
    return { key: 'later', className: 'cal-later', label: `还有 ${delta} 天`, rank: 5 };
  }

  function shortCalendarTitle(item) {
    const raw = String(item.job_title || item.title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '未命名岗位';
    const generic = /^(HK|Hong Kong|China|Graduate|Graduate Programme|Graduate Trainee|Management Trainee|Campus Recruitment|202[0-9] Start|202[0-9]届校招)$/i;
    const parts = raw.split(/\s*(?:-|–|—|\||·)\s*/).map(part => part.trim()).filter(Boolean);
    const useful = parts.filter(part => !generic.test(part)).sort((a, b) => b.length - a.length)[0] || raw;
    return useful.length > 30 ? `${useful.slice(0, 30).trim()}…` : useful;
  }

  function calendarDisplayModel(item) {
    const application = item.application_id && (S.applications || []).find(row => row.application_id === item.application_id);
    const job = item.job_id && (S.jobs || []).find(row => row.job_id === item.job_id);
    const model = { ...item };
    model.companyLabel = item.company || application?.company || job?.company || item.title || '—';
    model.jobTitle = item.job_title || application?.job_title || job?.job_title || item.title || '';
    model.shortTitle = shortCalendarTitle({ ...item, job_title: model.jobTitle });
    model.daysRemaining = dayDelta(item.date);
    model.visual = getEventVisualState(item);
    model.typeLabel = item.completed && item.kind === 'deadline' && /^OA/.test(item.type) ? '✓ OA 已完成' : item.completed ? `✓ ${item.type} 已完成` : item.type;
    model.dateLabel = String(item.date || '').slice(5) || '—';
    model.fullTitle = `${model.typeLabel} · ${model.companyLabel}${model.jobTitle ? ` · ${model.jobTitle}` : ''}`;
    return model;
  }

  function calendarDisplayModels(items = workflowCalEvents()) {
    return items.map(calendarDisplayModel);
  }

  function calendarSort(a, b) {
    const ar = a.visual.rank, br = b.visual.rank;
    return ar - br || (a.daysRemaining || 0) - (b.daysRemaining || 0) || String(a.date).localeCompare(String(b.date)) || String(a.time || '').localeCompare(String(b.time || ''));
  }

  function calendarEventMarkup(item) {
    return `<div class="event ${item.visual.className}" data-open-event="${esc(item.id)}" title="${esc(item.fullTitle)}"><div class="event-copy"><span>${esc(item.typeLabel)} · ${esc(item.companyLabel)}</span><span>${esc(item.shortTitle)}</span></div></div>`;
  }

  function calendarTodoMarkup(item) {
    const time = item.time ? ` · ${esc(item.time)}` : '';
    return `<div class="todo ${item.visual.className}" data-open-event="${esc(item.id)}"><div class="date todo-date">${esc(item.dateLabel)}</div><div class="todo-main"><b class="todo-company">${esc(item.companyLabel)}</b><div class="sub"><span class="event-type-label">${esc(item.typeLabel)}</span> · ${esc(item.visual.label)}${time}</div><div class="sub todo-job" title="${esc(item.jobTitle || item.title || '')}">${esc(item.shortTitle)}</div></div></div>`;
  }

  function applicationStatusCounts() {
    const counts = { all: 0, active: 0, 'need-action': 0, waiting: 0, rejected: 0 };
    (S.applications || []).filter(application => application.status !== 'Skipped').forEach(application => {
      const bucket = applicationFilterBucket(application);
      counts.all += 1;
      if (bucket === 'rejected') counts.rejected += 1;
      else { counts.active += 1; counts[bucket] += 1; }
    });
    return counts;
  }

  function workflowHome() {
    const counts = applicationStatusCounts();
    const pendingJobs = (S.activeJobs || []).length;
    const todos = calendarDisplayModels(workflowCalEvents()).filter(item => !item.completed).sort(calendarSort).slice(0, 8);
    const recent = (S.applications || []).filter(application => application.status !== 'Skipped').sort((a, b) => String(b.attempt_date).localeCompare(String(a.attempt_date))).slice(0, 4);
    $('home').innerHTML = `<div class="head"><div><h1>今天要做什么？</h1><p>${today()} · 只显示未完成的下一步</p></div><div class="actions"><button class="btn" data-go="jobs">找新岗位</button><button class="btn primary" data-add-job>添加岗位</button></div></div>
      <div class="grid2 section"><div class="surface"><div class="between"><h2>今日待办</h2><button class="btn" data-go="calendar">日历</button></div>${todos.map(calendarTodoMarkup).join('') || '<div class="empty">暂无需要立即处理的截止事项</div>'}</div>
      <div class="surface"><div class="between"><h2>最近申请</h2><button class="btn" data-go="apps">全部</button></div>${recent.map(application => `<div class="todo" data-app="${esc(application.application_id)}"><div><b>${esc(application.company)}</b><div class="sub">${esc(application.job_title)} · ${esc(stage[cur(application)] || cur(application))}</div><div class="sub">下一步：${esc(nextAction(application))}</div></div></div>`).join('') || '<div class="empty">暂无申请记录</div>'}</div></div>
      <div class="section"><h2>申请总览</h2><div class="progress">${[['all', '全部', counts.all], ['active', '进行中', counts.active], ['need-action', '待处理', counts['need-action']], ['waiting', '等待进展', counts.waiting], ['rejected', '已拒绝', counts.rejected]].map(([key, label, value]) => `<div class="metric" role="button" tabindex="0" data-progress="${key}"><strong>${value}</strong><span>${label}</span><small>查看申请</small></div>`).join('')}</div></div>
      <div class="section"><div class="between"><h2>推荐岗位</h2><button class="btn" data-go="jobs">岗位池</button></div>${table((S.activeJobs || []).slice().sort((a, b) => +b.priority - +a.priority).slice(0, 5))}</div>`;
  }

  function applicationMaterialRows(applicationId) {
    return (S.applicationMaterials || []).filter(item => item.application_id === applicationId && !item.deleted_at && /Confirmed/.test(item.mapping_status || ''));
  }

  function resumeBundle(application) {
    const rows = applicationMaterialRows(application.application_id).filter(item => item.role === 'CV' || item.role === 'CV_EDITABLE');
    const submission = rows.find(item => item.role === 'CV' && ['Actual Submitted File', 'Submission File'].includes(item.file_role || 'Submission File')) || rows.find(item => item.role === 'CV');
    const editable = rows.find(item => item.role === 'CV_EDITABLE' || item.file_role === 'Editable Source');
    const actualSubmittedVersion = (submission && ver(submission.material_version_id)) || ver(application.selected_cv_version_id || application.selected_cv_submission_version_id);
    const snapshotEditableVersion = editable && ver(editable.material_version_id);
    const resumeId = application.submitted_resume_id || application.selected_cv_resume_id || submission?.resume_id || editable?.resume_id || actualSubmittedVersion?.material_id || snapshotEditableVersion?.material_id || application.resume_version_id || '';
    const library = (S.materialLibrary || []).find(item => item.material_id === resumeId) || (actualSubmittedVersion?.material_id && (S.materialLibrary || []).find(item => item.material_id === actualSubmittedVersion.material_id));
    const editableVersion = (library?.editable_version_id && ver(library.editable_version_id)) || snapshotEditableVersion;
    const submissionPdfVersion = (library?.submission_version_id && ver(library.submission_version_id)) || null;
    const candidateRow = (S.applicationMaterials || []).find(item => item.application_id === application.application_id && item.role === 'CV' && item.mapping_status === 'Candidate' && !item.deleted_at);
    const candidateVersion = candidateRow && ver(candidateRow.material_version_id);
    const mappingInvalid = Boolean(application.invalid_resume_role_mapping);
    const selectedVersion = mappingInvalid ? null : ver(application.selected_cv_version_id || application.selected_cv_submission_version_id);
    const selectedLibrary = (S.materialLibrary || []).find(item => item.material_id === (mappingInvalid ? candidateVersion?.material_id : (application.selected_cv_resume_id || selectedVersion?.material_id || '')));
    const selectedEditableVersion = mappingInvalid ? null : (ver(application.selected_cv_editable_version_id) || (selectedVersion?.material_id === selectedLibrary?.material_id ? (selectedLibrary?.editable_version_id && ver(selectedLibrary.editable_version_id)) : null));
    const selectedPdfVersion = mappingInvalid ? null : (selectedLibrary?.submission_version_id && ver(selectedLibrary.submission_version_id));
    return { rows, submission, editable, actualSubmittedVersion, snapshotEditableVersion, submissionVersion: actualSubmittedVersion, editableVersion, submissionPdfVersion, library, resumeId, selectedVersion, selectedEditableVersion, selectedPdfVersion, selectedLibrary, actualSubmitted: Boolean(application.submitted_resume_id || application.confirmed_by_user || application.actual_submitted_file_path || submission) };
  }

  function resumeLabel(application) {
    const bundle = resumeBundle(application);
    if (bundle.library?.display_name || bundle.submission?.resume_version_name) return bundle.library?.display_name || bundle.submission.resume_version_name;
    return bundle.submissionVersion?.file_name || '';
  }

  function workflowApps() {
    const rows = (S.applications || []).filter(application => application.status !== 'Skipped' && (af === 'all' || cur(application) === af));
    $('apps').innerHTML = `<div class="head"><div><h1>我的申请</h1><p>申请、进展、日历和待办都来自同一条时间线</p></div></div><div class="filters">${[['all', '全部'], ['Applied', '已投递'], ['Online Assessment', '在线测评'], ['Interview', '面试'], ['Offer', 'Offer'], ['Rejected', '拒绝'], ['Withdrawn', '已撤回']].map(x => `<button data-af="${x[0]}" class="${af === x[0] ? 'active' : ''}">${x[1]}</button>`).join('')}</div><div class="tablebox"><table class="table"><thead><tr><th>公司 / 职位</th><th>当前阶段</th><th>申请日期</th><th>简历版本 / 投递文件</th><th>当前任务</th></tr></thead><tbody>${rows.map(application => { const bundle = resumeBundle(application); const candidate = (S.applicationMaterials || []).find(item => item.application_id === application.application_id && item.mapping_status === 'Candidate' && !item.deleted_at && item.role === 'CV'); return `<tr data-app="${esc(application.application_id)}"><td><b>${esc(application.company)}</b><div class="sub">${esc(application.job_title)}</div></td><td>${tag(stage[cur(application)] || cur(application), 'blue')}</td><td>${fmt(application.attempt_date)}</td><td>${bundle.submissionVersion ? `<b>${esc(resumeLabel(application))}</b><div class="sub">${esc(bundle.submissionVersion.file_name)}</div>` : candidate ? tag('待确认', 'amber') : '待补充'}</td><td>${esc(nextAction(application))}</td></tr>`; }).join('')}</tbody></table>${rows.length ? '' : '<div class="empty">没有符合条件的申请</div>'}</div>`;
  }

  function materialBlock(application, role, label) {
    if (role === 'CV') {
      const bundle = resumeBundle(application);
      const candidate = (S.applicationMaterials || []).find(item => item.application_id === application.application_id && item.role === 'CV' && item.mapping_status === 'Candidate' && !item.deleted_at);
      if (bundle.actualSubmitted) {
        const actualName = bundle.submission?.file_name || application.actual_submitted_file_name || bundle.actualSubmittedVersion?.file_name || '待补充';
        const actualType = String(bundle.actualSubmittedVersion?.extension || bundle.submission?.actual_submitted_file_type || application.actual_submitted_file_type || '').toUpperCase();
        const resumeId = bundle.library?.material_id || bundle.resumeId || '';
        const editableName = bundle.editableVersion?.file_name || '尚未添加';
        const editableOpen = bundle.editable ? `<button class="btn" data-open-application-material="${esc(bundle.editable.application_material_id)}">打开 Word</button>` : bundle.editableVersion ? `<button class="btn" data-open-version="${esc(bundle.editableVersion.material_version_id)}">打开 Word</button>` : '<span class="sub">尚未添加</span>';
        const editableChange = resumeId ? `<button class="btn" data-resume-slot data-resume-slot-id="${esc(resumeId)}" data-resume-slot-role="editable_docx" data-resume-slot-application="${esc(application.application_id)}">${bundle.editableVersion ? '更换 Word' : '添加 Word'}</button>` : '';
        const pdfName = bundle.submissionPdfVersion?.file_name || '尚未添加';
        const pdfOpen = bundle.submissionPdfVersion ? `<button class="btn" data-open-version="${esc(bundle.submissionPdfVersion.material_version_id)}">查看 PDF</button>` : '<span class="sub">尚未添加</span>';
        const pdfChange = resumeId ? `<button class="btn" data-resume-slot data-resume-slot-id="${esc(resumeId)}" data-resume-slot-role="submission_pdf" data-resume-slot-application="${esc(application.application_id)}">${bundle.submissionPdfVersion ? '更换 PDF' : '添加 PDF'}</button>` : '';
        const actualOpen = bundle.submission ? `<button class="btn" data-open-application-material="${esc(bundle.submission.application_material_id)}">${actualType === 'PDF' ? '查看 PDF' : '打开文件'}</button>` : bundle.actualSubmittedVersion ? `<button class="btn" data-open-version="${esc(bundle.actualSubmittedVersion.material_version_id)}">${actualType === 'PDF' ? '查看 PDF' : '打开文件'}</button>` : '<span class="sub">待补充</span>';
        return `<div class="candidate resume-application-block"><div class="between"><b>提交简历</b>${tag('✓ 已确认', 'green')}</div><div class="resume-version-name">${esc(bundle.library?.display_name || bundle.submission?.resume_version_name || '未命名版本')}</div><div class="resume-file-line"><span class="sub">编辑版 Word</span><b>${esc(editableName)}</b>${editableOpen}${editableChange}</div><div class="resume-file-line"><span class="sub">投递版 PDF</span><b>${esc(pdfName)}</b>${pdfOpen}${pdfChange}</div><div class="resume-file-line"><span class="sub">实际提交文件</span><b>${esc(actualName)}</b>${actualOpen}</div><div class="sub">实际提交文件会按历史快照保留，不会被资料库后续更新覆盖。${actualType && actualType !== 'PDF' ? ' 当时实际上传的是 Word 文件。' : ''}</div><div class="actions"><button class="btn" data-correct-material="${esc(application.application_id)}">更正记录</button></div></div>`;
      }
      const selectedVersion = bundle.selectedVersion || (candidate && ver(candidate.material_version_id));
      if (selectedVersion || candidate) {
        const isCandidate = Boolean(candidate) || application.selected_cv_status === 'Candidate';
        const selectedName = application.invalid_resume_role_mapping ? (candidate?.file_name || selectedVersion?.file_name || '可能的文件') : (application.selected_cv_file_name || selectedVersion?.file_name || '可能的文件');
        const selectedEditable = bundle.selectedEditableVersion || (selectedVersion && /^(DOCX|DOC)$/i.test(String(selectedVersion.extension || '')) ? selectedVersion : null);
        const selectedPdf = bundle.selectedPdfVersion || (/^PDF$/i.test(String(selectedVersion?.extension || '')) ? selectedVersion : null);
        const selectedResumeId = bundle.selectedLibrary?.material_id || bundle.library?.material_id || selectedVersion?.material_id || '';
        const selectedEditableOpen = selectedEditable && !selectedEditable.missing_at ? `<button class="btn" data-open-version="${esc(selectedEditable.material_version_id)}">打开 Word</button>` : '<span class="sub">尚未添加</span>';
        const selectedPdfOpen = selectedPdf && !selectedPdf.missing_at ? `<button class="btn" data-open-version="${esc(selectedPdf.material_version_id)}">查看 PDF</button>` : `<span class="sub">尚未添加</span>`;
        const selectedEditableChange = selectedResumeId ? `<button class="btn" data-resume-slot data-resume-slot-id="${esc(selectedResumeId)}" data-resume-slot-role="editable_docx" data-resume-slot-application="${esc(application.application_id)}">${selectedEditable ? '更换 Word' : '添加 Word'}</button>` : '';
        const selectedPdfChange = selectedResumeId ? `<button class="btn" data-resume-slot data-resume-slot-id="${esc(selectedResumeId)}" data-resume-slot-role="submission_pdf" data-resume-slot-application="${esc(application.application_id)}">${selectedPdf ? '更换 PDF' : '添加 PDF'}</button>` : '';
        const submitted = ['Applied', 'Online Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].includes(String(application.current_stage || application.status));
        const confirmLabel = submitted ? '确认这是当时提交的简历' : '使用这份简历';
        return `<div class="candidate resume-application-block"><div class="between"><b>${isCandidate || submitted ? '实际提交简历 · 待确认' : '准备使用的简历'}</b>${tag(isCandidate || submitted ? '待确认' : '待使用', isCandidate || submitted ? 'amber' : 'blue')}</div><div class="resume-version-name">${esc(application.selected_cv_version_name || bundle.selectedLibrary?.display_name || selectedName)}</div><div class="resume-file-line"><span class="sub">编辑版 Word</span><b>${esc(selectedEditable?.file_name || '尚未添加')}</b>${selectedEditableOpen}${selectedEditableChange}</div><div class="resume-file-line"><span class="sub">投递版 PDF</span><b>${esc(selectedPdf?.file_name || '尚未添加')}</b>${selectedPdfOpen}${selectedPdfChange}</div><div class="sub">${submitted ? '确认后只会补全 CareerPilot 的历史记录，不会改变已经发给公司的文件。' : '这是准备使用的简历；尚未生成已投递快照。'}</div><div class="actions"><button class="btn primary" data-confirm-selected="${esc(application.application_id)}" data-selected-version="${esc(selectedVersion?.material_version_id || candidate?.material_version_id || '')}">${confirmLabel}</button><button class="btn" data-choose-cv="${esc(application.application_id)}">更换</button><button class="btn" data-ignore-selected="${esc(application.application_id)}">忽略</button></div></div>`;
      }
      return `<div class="candidate resume-application-block"><b>提交简历</b><div class="sub">尚未选择本次准备使用的简历。</div><button class="btn primary" data-choose-cv="${esc(application.application_id)}">更换 / 选择简历</button></div>`;
    }
    const row = applicationMaterialRows(application.application_id).find(item => item.role === role);
    const candidate = (S.applicationMaterials || []).find(item => item.application_id === application.application_id && item.role === role && item.mapping_status === 'Candidate' && !item.deleted_at);
    const version = row && ver(row.material_version_id);
    if (version) return `<div class="candidate"><b>已提交${label}</b><div>${esc(version.file_name)}</div><div class="sub">申请时快照 · ${esc((row.file_hash || '').slice(0, 12))}…</div><div class="actions"><button class="btn" data-open-application-material="${esc(row.application_material_id)}">打开</button><button class="btn" data-view-material-source="${esc(application.application_id)}">查看来源</button></div></div>`;
    const selectedId = role === 'Cover Letter' ? application.selected_cover_letter_version_id : '';
    const selected = selectedId && ver(selectedId);
    if (selected || candidate) { const selectedVersion = selected || ver(candidate.material_version_id); const selectedName = role === 'Cover Letter' ? (application.selected_cover_letter_file_name || selectedVersion?.file_name) : selectedVersion?.file_name; const openOrRelink = selectedVersion && !selectedVersion.missing_at ? `<button class="btn" data-open-version="${esc(selectedVersion.material_version_id)}">打开</button>` : `<span class="sub">文件已找不到</span><button class="btn" data-relink-cover-letter="${esc(application.application_id)}">重新定位</button>`; return `<div class="candidate"><b>${application.selected_cover_letter_status === 'Candidate' || candidate ? label + ' · 待确认' : '本次准备使用的' + label}</b><div>${esc(selectedName || '可能的文件')}</div>${openOrRelink}<div class="actions"><button class="btn primary" data-confirm-selected="${esc(application.application_id)}" data-selected-role="${esc(role)}" data-selected-version="${esc(selectedVersion?.material_version_id || '')}">确认使用</button><button class="btn" data-choose-cover-letter="${esc(application.application_id)}">更换</button><button class="btn" data-ignore-selected="${esc(application.application_id)}" data-selected-role="${esc(role)}">移除</button></div></div>`; }
    return `<div class="candidate"><b>${label}</b><div class="sub">尚未选择本次准备使用的${label}。</div><button class="btn" data-choose-cover-letter="${esc(application.application_id)}">添加 / 更换</button></div>`;
  }

  function workflowAppDrawer(application) {
    if (!application) return;
    const focusId = window.__careerPilotFocusEventId || '';
    const timeline = activeEvents(application.application_id);
    const task = openItemsFor(application)[0];
    openDrawer(`<div class="between">${tag(stage[cur(application)] || cur(application), 'blue')}<button class="btn" data-close>关闭</button></div><h2>${esc(application.company)}</h2><p class="role">${esc(application.job_title)}</p><p class="sub">申请日期：${fmt(application.attempt_date)} · 当前阶段：${esc(stage[cur(application)] || cur(application))}</p><div class="actions" style="margin-top:12px">${application.job_url ? `<button class="btn" data-url="${esc(application.job_url)}">打开职位</button>` : ''}</div><div class="sep"><b>申请信息</b><p class="sub">申请编号：${esc(application.application_id)}${application.application_channel ? `<br>申请渠道：${esc(application.application_channel)}` : ''}</p></div><div class="sep"><b>提交简历与申请材料</b><div class="resume-material-layout" style="margin-top:10px">${materialBlock(application, 'CV', '已提交简历')}${materialBlock(application, 'Cover Letter', '求职信')}</div></div><div class="sep"><b>当前任务</b><div class="candidate">${task ? `<b>${esc(task.type)}</b><div>${esc(task.title)} · ${esc(remaining(task.date, task.kind))}</div>${task.kind === 'deadline' ? `<div class="sub">截止日期：${esc(task.date)}${task.time ? ` · ${esc(task.time)}` : ' · 具体时间未填写'}</div>` : `<div class="sub">时间：${esc(task.date)} ${esc(task.time || '')}</div>`}` : '<span class="sub">暂无未完成的截止事项</span>'}</div></div><div class="sep"><div class="between"><b>申请时间线</b><button class="btn primary" data-record="${esc(application.application_id)}">记录进展</button></div><div class="timeline">${timeline.map(event => { const focused = event.event_id === focusId; return `<div class="${focused ? 'candidate' : ''}"><b>${fmt(event.event_date)} · ${esc(I18n.event(event.event_type))}${event.round ? ` · ${esc(event.round)}` : ''}</b><span class="sub">${event.deadline ? `截止日期：${fmt(event.deadline)}${event.deadline_time ? ` ${esc(event.deadline_time)}` : ' · 具体时间未填写'} · ` : ''}${esc(event.notes || '')}</span></div>`; }).join('') || '<div class="empty">暂无进展记录</div>'}</div></div>`);
    window.__careerPilotFocusEventId = '';
  }

  function workflowApplications() {
    const all = (S.applications || []).filter(application => application.status !== 'Skipped');
    const rows = all.filter(application => {
      if (af === 'all') return true;
      if (af === 'active') return !isClosedApplication(application);
      if (af === 'need-action') return applicationFilterBucket(application) === 'need-action';
      if (af === 'waiting') return applicationFilterBucket(application) === 'waiting';
      if (af === 'rejected') return applicationFilterBucket(application) === 'rejected';
      return true;
    }).sort(applicationSort);
    const filters = [['all', '全部'], ['active', '进行中'], ['need-action', '待处理'], ['waiting', '等待进展'], ['rejected', '已拒绝']];
    $('apps').innerHTML = `<div class="head"><div><h1>我的申请</h1><p>每个职位只有一条申请记录；阶段变化保留在同一条时间线中</p></div></div>
      <div class="filters">${filters.map(([key, label]) => `<button data-af="${key}" class="${af === key ? 'active' : ''}">${label}</button>`).join('')}</div>
      <p class="sub application-list-note">默认顺序：待处理 → 有进展 → 等待进展 → 已拒绝 / 已结束。截止日期会自动提高优先级。</p>
      <div class="tablebox"><table class="table"><thead><tr><th>公司 / 职位</th><th>当前状态</th><th>投递日期</th><th>已提交简历</th><th>当前任务</th></tr></thead><tbody>${rows.map(application => {
        const bundle = resumeBundle(application);
        const candidate = (S.applicationMaterials || []).find(item => item.application_id === application.application_id && item.mapping_status === 'Candidate' && !item.deleted_at && item.role === 'CV');
        const label = applicationStatusLabel(application);
        const task = openItemsFor(application)[0];
        const taskMarkup = task ? `<span class="application-row-deadline">${esc(applicationTaskLabel(task))}</span>` : `<span class="application-row-waiting">等待进展</span>`;
        return `<tr data-app="${esc(application.application_id)}"><td><b>${esc(application.company)}</b><div class="sub">${esc(application.job_title)}</div></td><td>${tag(label, applicationStatusClass(label))}</td><td>${fmt(application.attempt_date)}</td><td>${bundle.submissionVersion ? `<b>${esc(resumeLabel(application))}</b><div class="sub">${esc(bundle.submissionVersion.file_name)}</div>` : candidate ? tag('待确认', 'amber') : '待补充'}</td><td>${taskMarkup}</td></tr>`;
      }).join('')}</tbody></table>${rows.length ? '' : '<div class="empty">没有符合条件的申请</div>'}</div>`;
  }

  function workflowApplicationDrawer(application) {
    if (!application) return;
    const label = applicationStatusLabel(application);
    const statusClass = applicationStatusClass(label);
    const timeline = activeEvents(application.application_id);
    const task = openItemsFor(application)[0];
    const deadlines = applicationDeadlineItems(application);
    openDrawer(`<div class="between">${tag(label, statusClass)}<button class="btn" data-close>关闭</button></div>
      <h2>${esc(application.company)}</h2><p class="role">${esc(application.job_title)}</p>
      <div class="sep"><b>申请详情</b><div class="form" style="margin-top:10px"><div><span class="sub">公司</span><br><b>${esc(application.company)}</b></div><div><span class="sub">职位</span><br><b>${esc(application.job_title)}</b></div><div><span class="sub">当前状态</span><br>${tag(label, statusClass)}</div><div><span class="sub">投递日期</span><br><b>${esc(fmt(application.attempt_date))}</b></div></div><p class="sub" style="margin-top:10px">申请编号：${esc(application.application_id)}${application.application_channel ? `<br>申请渠道：${esc(application.application_channel)}` : ''}</p></div>
      <div class="sep"><b>提交简历与申请材料</b><div class="resume-material-stack" style="margin-top:10px">${materialBlock(application, 'CV', '已提交简历')}${materialBlock(application, 'Cover Letter', '求职信')}</div></div>
      <div class="sep"><b>当前任务</b><div class="candidate">${task ? `<b>${esc(applicationTaskLabel(task))}</b><div class="sub">${esc(task.title || task.type || '')}</div>` : '<span class="sub">暂无未完成任务，等待进展</span>'}</div></div>
      <div class="sep"><b>截止日期</b><div class="application-deadlines">${deadlines.map(item => `<div class="application-deadline ${item.completed ? '' : urgencyClass(item.date)}"><span>${esc(I18n.deadlineLabel(item))}</span><b>${esc(item.date)}${item.completed ? ' · 已完成' : ` · ${I18n.remaining(dayDelta(item.date))}`}</b></div>`).join('') || '<span class="sub">暂无截止日期记录</span>'}</div></div>
      <div class="sep"><div class="between"><b>申请时间线</b><button class="btn primary" data-record="${esc(application.application_id)}">记录进展</button></div><div class="timeline">${timeline.map(event => `<div><b>${fmt(event.event_date)} · ${esc(I18n.event(event.event_type))}${event.round ? ` · ${esc(event.round)}` : ''}</b><span class="sub">${event.deadline ? `截止日期：${fmt(event.deadline)}${event.deadline_time ? ` ${esc(event.deadline_time)}` : ' · 具体时间未填写'} · ` : ''}${esc(event.notes || '')}</span></div>`).join('') || '<div class="empty">暂无时间线记录</div>'}</div></div>`);
  }

  function workflowCalendar() {
    const items = calendarDisplayModels(workflowCalEvents());
    const y = month.getFullYear(), m = month.getMonth(), first = new Date(y, m, 1), start = new Date(y, m, 1 - first.getDay()), days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    const upcoming = items.filter(item => !item.completed).sort(calendarSort).slice(0, 10);
    $('calendar').innerHTML = `<div class="head"><div><h1>求职日历</h1><p>发生日期留在 Timeline；这里只显示截止日期和已安排时间</p></div><button class="btn primary" data-add-event>+ 添加独立事项</button></div><div class="calgrid"><div class="calendar"><div class="between"><button class="btn" data-prev>‹</button><b>${y} 年 ${m + 1} 月</b><button class="btn" data-next>›</button></div><div class="month">${['日', '一', '二', '三', '四', '五', '六'].map(x => `<div class="week">${x}</div>`).join('')}${days.map(day => { const iso = day.toLocaleDateString('en-CA'); const list = items.filter(item => item.date === iso); const visible = list.slice(0, 2); const more = list.length - visible.length; return `<div class="day ${day.getMonth() !== m ? 'dim' : ''}"><span class="day-number">${day.getDate()}</span><div class="day-events">${visible.map(calendarEventMarkup).join('')}${more > 0 ? `<button class="event-more" data-calendar-more="${esc(iso)}">+${more} 个更多</button>` : ''}</div></div>`; }).join('')}</div></div><aside class="surface"><h2>未来待办</h2>${upcoming.map(calendarTodoMarkup).join('') || '<div class="empty">暂无未来待办</div>'}</aside></div>`;
  }

  function workflowRecordModal(applicationId) {
    openModal(`<h2>记录进展</h2><p class="notice">发生日期进入 Timeline；截止日期只用于日历和今日待办，不会替换发生日期。若只填日期，系统不会自行假设具体截止时间。</p><div class="form"><div class="field"><label>发生了什么？</label><select id="etype">${Object.entries(events).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></div>${formInput('edate', '发生日期', 'date', today())}${formInput('etime', '时间（如面试时间）', 'time')}${formInput('edeadline', '截止日期（如适用）', 'date')}${formInput('edeadline_time', '截止时间（可选）', 'time')}${formInput('eround', '轮次')}<div class="field full"><label>备注</label><textarea id="enotes"></textarea></div></div><div class="run"><span></span><div class="actions"><button class="btn" data-cancel>取消</button><button class="btn primary" data-save-progress="${applicationId}">保存进展</button></div></div>`);
  }

  function translateWorkflow() { I18n.translateVisible(document); }
  function workflowRender() { workflowHome(); jobs(); workflowApplications(); workflowCalendar(); mine(); go(page); setTimeout(translateWorkflow, 0); }

  // Replace only view functions; the existing API/write handlers remain in use.
  home = workflowHome;
  apps = workflowApplications;
  calendar = workflowCalendar;
  calEvents = workflowCalEvents;
  appDrawer = workflowApplicationDrawer;
  recordModal = workflowRecordModal;
  render = workflowRender;
  const baseOpenDrawer = window.openDrawer;
  if (typeof baseOpenDrawer === 'function') window.openDrawer = (...args) => { const result = baseOpenDrawer(...args); setTimeout(translateWorkflow, 0); return result; };
  const baseOpenModal = window.openModal;
  if (typeof baseOpenModal === 'function') window.openModal = (...args) => { const result = baseOpenModal(...args); setTimeout(translateWorkflow, 0); return result; };

  document.addEventListener('click', event => {
    const progress = event.target.closest('[data-progress]');
    if (progress) {
      event.stopImmediatePropagation();
      if (progress.dataset.progress === 'pending') { go('jobs'); return; }
      af = progress.dataset.progress; go('apps'); workflowApplications(); return;
    }
    const moreDay = event.target.closest('[data-calendar-more]');
    if (moreDay) {
      event.stopImmediatePropagation();
      const iso = moreDay.dataset.calendarMore;
      const list = calendarDisplayModels(workflowCalEvents()).filter(item => item.date === iso);
      openModal(`<div class="between"><h2>${esc(iso.slice(5).replace('-', '月'))}日事项</h2><button class="btn" data-cancel>关闭</button></div><div class="calendar-day-list">${list.map(calendarEventMarkup).join('') || '<div class="empty">这一天没有事项</div>'}</div>`);
      return;
    }
    const calendarEvent = event.target.closest('[data-open-event]');
    if (calendarEvent) {
      const item = workflowCalEvents().find(candidate => candidate.id === calendarEvent.dataset.openEvent);
      if (item?.application_id) {
        event.stopImmediatePropagation();
        window.__careerPilotFocusEventId = item.event_id || '';
        workflowAppDrawer((S.applications || []).find(application => application.application_id === item.application_id));
      }
    }
  }, true);

  // load() is already running in the original page script; when it resolves it
  // calls the replaced render(). This retry only covers a very fast cached load.
  setTimeout(() => { if (S && S.jobs) workflowRender(); }, 0);
})();
