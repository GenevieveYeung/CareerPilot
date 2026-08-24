/* CareerPilot display language.
 * Stable backend codes and external content stay unchanged; only UI labels
 * are translated here so every view renders the same wording.
 */
(() => {
  const normalize = value => String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

  const STATUS_LABELS = {
    applied: '已投递', submitted: '已投递', under_review: '审核中',
    potential: '待评估', to_review: '待评估', interested: '感兴趣', to_apply: '待投递',
    online_assessment: '在线测评', oa_received: '在线测评', oa_completed: '在线测评已完成',
    interview: '面试', final_round: '终面', offer: 'Offer', rejected: '已拒绝',
    withdrawn: '已撤回', closed: '已结束', 'closed_/_expired': '已结束', waiting: '等待进展',
    archived: '已归档', skipped: '已跳过'
  };

  const EVENT_LABELS = {
    applied: '已投递', oa_received: '收到在线测评', oa_completed: '完成在线测评',
    interview_invitation: '收到面试邀请', interview_invited: '收到面试邀请',
    interview_completed: '完成面试', assessment_centre: '评估中心', assessment_center: '评估中心',
    interview: '面试', offer: '收到 Offer', rejected: '已拒绝', withdrawn: '已撤回',
    follow_up: '跟进', application_deadline: '申请截止', oa_deadline: '在线测评截止',
    offer_deadline: 'Offer 截止', deadline: '截止日期', other: '其他',
    recruitment_event: '招聘活动', career_fair: '招聘会'
  };

  const FILTER_LABELS = { all: '全部', active: '进行中', 'need-action': '待处理', waiting: '等待进展', rejected: '已拒绝' };
  const UI = {
    applicationDetails: '申请详情', company: '公司', position: '职位', currentStatus: '当前状态',
    submittedDate: '投递日期', applicationId: '申请编号', channel: '申请渠道', submittedMaterials: '已提交简历与求职信',
    submittedResume: '已提交简历', coverLetter: '求职信', currentTasks: '当前任务', noOpenTask: '暂无未完成任务，等待进展',
    deadlines: '截止日期', noDeadline: '暂无截止日期记录', timeline: '申请时间线', recordProgress: '记录进展',
    noTimeline: '暂无时间线记录', waiting: '等待进展', dateNotSet: '日期未设置', completed: '已完成',
    deadline: '截止日期', applicationDeadline: '申请截止', oaDeadline: '在线测评截止', interview: '面试',
    offerDeadline: 'Offer 截止', specificTimeMissing: '具体时间未填写', calendarTimeline: '时间线'
  };

  function lookup(map, value, fallback = '') {
    const key = normalize(value);
    return map[key] || map[String(value ?? '').trim()] || fallback || String(value ?? '');
  }

  function status(value) {
    const raw = String(value ?? '').trim();
    if (raw === 'Online Assessment') return STATUS_LABELS.online_assessment;
    if (raw === 'Under review') return STATUS_LABELS.under_review;
    if (raw === 'Closed / Expired') return STATUS_LABELS['closed_/_expired'];
    return lookup(STATUS_LABELS, raw, raw);
  }

  function event(value) { return lookup(EVENT_LABELS, value, String(value ?? '')); }
  function filter(value) { return FILTER_LABELS[value] || String(value ?? ''); }

  function remaining(delta) {
    const n = Number(delta);
    if (!Number.isFinite(n)) return UI.dateNotSet;
    if (n < 0) return `已逾期 ${Math.abs(n)} 天`;
    if (n === 0) return '今天截止';
    return `还有 ${n} 天`;
  }

  function deadlineLabel(item = {}) {
    const raw = `${item.type || ''} ${item.title || ''}`.toLowerCase();
    if (item.type === 'OA 截止' || raw.includes('online assessment') || raw.includes('oa deadline') || raw.includes('oa 截止')) return UI.oaDeadline;
    if (item.kind === 'interview' || raw.includes('interview')) return UI.interview;
    if (raw.includes('offer')) return UI.offerDeadline;
    if (item.type === '申请截止' || raw.includes('application deadline')) return UI.applicationDeadline;
    return event(item.type || item.title || UI.deadline) || UI.deadline;
  }

  function taskLabel(item = {}, dayDelta) {
    const days = typeof dayDelta === 'function' ? dayDelta(item.date) : NaN;
    const label = deadlineLabel(item);
    const date = item.date || '—';
    return `${label}：${date} · ${remaining(days)}`;
  }

  const TEXT_REPLACEMENTS = new Map([
    ['Timeline', '时间线'], ['发生日期留在 Timeline；这里只显示截止日期和已安排时间', '发生日期留在时间线；这里只显示截止日期和已安排时间'], ['发生日期进入 Timeline；截止日期只用于日历和今日待办，不会替换发生日期。若只填日期，系统不会自行假设具体截止时间。', '发生日期进入时间线；截止日期只用于日历和今日待办，不会替换发生日期。若只填日期，系统不会自行假设具体截止时间。'], ['Current status', '当前状态'], ['Submitted', '投递日期'], ['Submitted CV', '已提交简历'],
    ['Current task', '当前任务'], ['Waiting for update', '等待进展'], ['Application details', '申请详情'], ['Company', '公司'],
    ['Position', '职位'], ['Current tasks', '当前任务'], ['Deadlines', '截止日期'], ['No deadline recorded', '暂无截止日期记录'],
    ['Record progress', '记录进展'], ['No timeline records', '暂无时间线记录'], ['OA deadline', '在线测评截止'],
    ['date not set', '日期未设置'], ['completed', '已完成'], ['today', '今天截止'], ['No open task. Waiting for update.', '暂无未完成任务，等待进展'],
    ['Need Action', '待处理'], ['Active progress', '有进展'], ['Active', '进行中'], ['Waiting', '等待进展'], ['Rejected', '已拒绝'],
    ['生成搜索 Prompt', '生成搜索提示词'], ['生成定制简历 Prompt', '生成定制简历提示词'], ['定制简历 Prompt', '定制简历提示词'], ['生成 Prompt', '生成提示词'], ['复制 Prompt', '复制提示词'], ['Draft', '草稿'],
    ['Potential', '待评估'], ['To Review', '待查看'], ['Interested', '感兴趣'], ['To Apply', '待投递'], ['Online Assessment', '在线测评'], ['Under review', '审核中'], ['Closed / Expired', '已结束'],
    ['All', '全部'], ['Offer Deadline', 'Offer 截止'], ['Interview Invited', '收到面试邀请'], ['OA Received', '收到在线测评'],
    ['OA Completed', '完成在线测评'], ['Interview Completed', '完成面试'], ['Follow-up', '跟进'], ['Application Deadline', '申请截止']
  ]);
  function translateVisible(root = document) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      if (!node.nodeValue || !node.nodeValue.trim()) return;
      let value = node.nodeValue;
      TEXT_REPLACEMENTS.forEach((label, source) => { if (value.trim() === source) value = value.replace(source, label); });
      node.nodeValue = value;
    });
  }

  window.CareerPilotI18n = { STATUS_LABELS, EVENT_LABELS, FILTER_LABELS, UI, status, event, filter, remaining, deadlineLabel, taskLabel, translateVisible };
})();
