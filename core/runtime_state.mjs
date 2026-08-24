import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateProfileRows } from './profile_service.mjs';
import projectPaths from './project_paths.cjs';

const paths = projectPaths.getProjectPaths({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const workspace = paths.repoRoot;
const stateDir = paths.stateDir;
const statePath = process.env.CAREERPILOT_RUNTIME_STATE_PATH || paths.runtimeStatePath;
const clean = value => value == null ? '' : String(value);
const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clean(value));
const now = () => new Date().toISOString();
const dateToday = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((out, part) => {
    if (part.type !== 'literal') out[part.type] = part.value;
    return out;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const id = prefix => `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const activeStatuses = new Set(['Potential', 'To Review', 'Interested', 'To Apply']);
const applicationStatuses = new Set(['Applied', 'Online Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn']);
let stateCache = null;
let stateMtime = null;
let writeQueue = Promise.resolve();

async function loadState() {
  let stat = await fs.stat(statePath);
  if (stateCache && stateMtime === stat.mtimeMs) return stateCache;
  const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'));
  stateCache = parsed.snapshot || parsed;
  // Older migration snapshots kept the complete cold workbook under a
  // nested `data` property. It is already preserved in the original master
  // backup and must never be copied into the runtime hot path or API payload.
  if (stateCache && Object.prototype.hasOwnProperty.call(stateCache, 'data')) {
    delete stateCache.data;
  }
  stateMtime = stat.mtimeMs;
  return stateCache;
}

async function persist(state) {
  // Persist the normalized hot snapshot so derived counts cannot retain the
  // historical workbook totals after the cold jobs have been moved out.
  state = deriveSnapshot(state);
  const run = writeQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify({ format_version: 1, saved_at: now(), snapshot: state }), 'utf8');
      await fs.rename(temp, statePath);
      stateCache = state;
      stateMtime = (await fs.stat(statePath)).mtimeMs;
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  });
  writeQueue = run;
  await run;
}

export async function hasState() { return Boolean(await fs.stat(statePath).catch(() => null)); }
export async function getStateMtime() { return (await fs.stat(statePath).catch(() => null))?.mtimeMs ?? null; }

function eventStage(type) {
  return ({ Applied: 'Applied', 'OA Received': 'Online Assessment', 'OA Completed': 'Online Assessment', 'Interview Invitation': 'Interview', 'Interview Completed': 'Interview', 'Assessment Centre': 'Interview', Offer: 'Offer', Rejected: 'Rejected', Withdrawn: 'Withdrawn' })[type] || '';
}
function ensure(state, key) { if (!Array.isArray(state[key])) state[key] = []; return state[key]; }
function materialsRootForState(state) { return path.resolve(clean(ensure(state, 'settings').find(row => row.key === 'materials_root')?.value || paths.materialsRoot)); }
function findBy(rows, key, value) { const row = rows.find(item => item[key] === value); if (!row) throw Object.assign(new Error('记录不存在，请刷新后重试。'), { code: 404 }); return row; }
function versionCheck(row, expected) { if (expected != null && Number(row.version || 1) !== Number(expected)) throw Object.assign(new Error('记录已被其他操作更新，请刷新后重试。'), { code: 409 }); }
function addStatusHistory(state, jobId, from, to, reason) { ensure(state, 'statusHistory').push({ history_id: id('hist'), job_id: jobId, changed_at: now(), from_status: from, to_status: to, changed_by: 'ui', reason: clean(reason), notes: '' }); }

function syncApplicationStage(state, applicationId) {
  const apps = ensure(state, 'applications');
  const app = findBy(apps, 'application_id', applicationId);
  const events = ensure(state, 'applicationEvents').filter(item => item.application_id === applicationId && !item.deleted_at && eventStage(item.event_type)).sort((a, b) => `${a.event_date}T${a.event_time || '00:00'}|${a.created_at || ''}`.localeCompare(`${b.event_date}T${b.event_time || '00:00'}|${b.created_at || ''}`));
  const latest = events.at(-1);
  const stage = latest ? eventStage(latest.event_type) : 'Applied';
  app.current_stage = stage; app.status = stage; app.updated_at = now(); app.updated_by = 'ui'; app.version = Number(app.version || 1) + 1;
  const job = ensure(state, 'jobs').find(item => item.job_id === app.job_id);
  if (job) { const old = job.status; job.status = stage; job.lifecycle_status = stage; job.updated_at = now(); job.updated_by = 'ui'; job.version = Number(job.version || 1) + 1; if (old !== stage) addStatusHistory(state, job.job_id, old, stage, 'Derived from application timeline'); }
  return stage;
}

function materialExtension(version) {
  return clean(version?.extension || path.extname(clean(version?.file_name)).slice(1)).toUpperCase();
}

function isEditableResumeVersion(version) { return ['DOCX', 'DOC'].includes(materialExtension(version)); }
function isSubmissionResumeVersion(version) { return materialExtension(version) === 'PDF'; }
function isActualSubmittedVersion(version) { return ['PDF', 'DOCX', 'DOC'].includes(materialExtension(version)); }
function applicationIsSubmitted(app) {
  return ['Applied', 'Online Assessment', 'Interview', 'Offer', 'Rejected', 'Withdrawn'].includes(clean(app?.current_stage || app?.status))
    || Boolean(clean(app?.submitted_resume_id || app?.actual_submitted_file_path || app?.submitted_snapshot_path));
}

function materialVersionsFor(state, materialId) {
  return ensure(state, 'materialVersions').filter(version => version.material_id === materialId && !version.deleted_at && !version.missing_at)
    .sort((a, b) => String(b.modified_at || '').localeCompare(String(a.modified_at || '')));
}

function normalizeResumeStem(value) {
  return path.parse(clean(value)).name.toLowerCase()
    .replace(/\b(?:v|version)[\s._-]*\d+\b/gi, '')
    .replace(/\b(?:final|draft|latest|one[\s._-]*page|resume|cv)\b/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function compatibleResumeStems(left, right) {
  const a = normalizeResumeStem(left), b = normalizeResumeStem(right);
  return Boolean(a && b && Math.min(a.length, b.length) >= 8 && (a === b || a.includes(b) || b.includes(a)));
}

function resumeLibraryVersions(state, library) {
  return materialVersionsFor(state, library.material_id);
}

function updateResumeSlotMetadata(library, editable, submission) {
  library.resume_id = clean(library.resume_id || library.material_id);
  library.editable_docx_path = editable?.file_path || '';
  library.editable_docx_filename = editable?.file_name || '';
  library.editable_docx_hash = editable?.sha256 || '';
  library.editable_docx_modified_at = editable?.modified_at || '';
  library.submission_pdf_path = submission?.file_path || '';
  library.submission_pdf_filename = submission?.file_name || '';
  library.submission_pdf_hash = submission?.sha256 || '';
  library.submission_pdf_modified_at = submission?.modified_at || '';
  // Compatibility aliases remain synchronized for existing UI/import code.
  library.editable_file_path = library.editable_docx_path;
  library.editable_file_hash = library.editable_docx_hash;
  library.editable_file_modified_at = library.editable_docx_modified_at;
  library.submission_file_path = library.submission_pdf_path;
  library.submission_file_hash = library.submission_pdf_hash;
  library.submission_file_modified_at = library.submission_pdf_modified_at;
}

function normalizeResumeVersions(state) {
  const libraries = ensure(state, 'materialLibrary');
  const versions = ensure(state, 'materialVersions');
  for (const library of libraries.filter(row => /CV \/ Resume|Resume|简历/i.test(clean(row.material_type)))) {
    library.resume_id = clean(library.resume_id || library.material_id);
    const live = materialVersionsFor(state, library.material_id);
    const docx = live.filter(version => ['DOCX', 'DOC'].includes(materialExtension(version)));
    const pdf = live.filter(version => materialExtension(version) === 'PDF');
    const rawEditable = versions.find(version => version.material_version_id === library.editable_version_id && version.material_id === library.material_id && !version.missing_at);
    const rawSubmission = versions.find(version => version.material_version_id === library.submission_version_id && version.material_id === library.material_id && !version.missing_at);
    const invalidEditable = Boolean(rawEditable && !isEditableResumeVersion(rawEditable));
    const invalidSubmission = Boolean(rawSubmission && !isSubmissionResumeVersion(rawSubmission));
    const explicitEditable = rawEditable && isEditableResumeVersion(rawEditable) ? rawEditable : null;
    const explicitSubmission = rawSubmission && isSubmissionResumeVersion(rawSubmission) ? rawSubmission : null;
    // Pair only when the evidence is deterministic. Never choose the first of
    // several files: that silently changes the user's intended resume.
    const editable = explicitEditable || (docx.length === 1 ? docx[0] : null);
    const submission = explicitSubmission || (pdf.length === 1 ? pdf[0] : null);
    if (editable) library.editable_version_id = editable.material_version_id;
    else if (invalidEditable) library.editable_version_id = '';
    if (submission) library.submission_version_id = submission.material_version_id;
    else if (invalidSubmission) library.submission_version_id = '';
    updateResumeSlotMetadata(library, editable, submission);
    if (invalidEditable || invalidSubmission) {
      library.invalid_role_mapping = true;
      library.pairing_status = 'invalid_role_mapping';
      library.pairing_reason = `检测到文件角色错误：${invalidEditable ? 'editable_docx_path 不是 DOCX/DOC' : ''}${invalidEditable && invalidSubmission ? '；' : ''}${invalidSubmission ? 'submission_pdf_path 不是 PDF' : ''}。原文件保留，需按正确槽位补充或更正。`;
    } else if (editable && submission) {
      library.invalid_role_mapping = false;
      library.pairing_status = 'Paired';
      library.pairing_reason = '已明确关联编辑版 DOCX 和投递版 PDF。';
    } else if (editable) {
      library.pairing_status = 'Missing submission PDF';
      library.pairing_reason = '已找到编辑版 DOCX，但尚未关联投递版 PDF。';
    } else if (submission) {
      library.pairing_status = 'Missing editable DOCX';
      library.pairing_reason = '已找到投递版 PDF，但尚未关联可编辑 DOCX。';
    } else {
      library.pairing_status = 'No files';
      library.pairing_reason = '尚未找到可用的 DOCX 或 PDF。';
    }
  }
  for (const row of ensure(state, 'applicationMaterials')) {
    const version = versions.find(candidate => candidate.material_version_id === row.material_version_id);
    const library = version && libraries.find(candidate => candidate.material_id === version.material_id);
    if (version) {
      row.resume_id = clean(row.resume_id || library?.resume_id || version.material_id);
      row.resume_version_name = clean(row.resume_version_name || library?.display_name || '');
      if (!row.file_role) row.file_role = row.role === 'CV_EDITABLE' || ['DOCX', 'DOC'].includes(materialExtension(version)) ? 'Editable Source' : row.role === 'CV' ? 'Submission File' : row.role;
    }
  }
}

function migrateResumeLibraryAssociations(state) {
  normalizeResumeVersions(state);
  const libraries = ensure(state, 'materialLibrary').filter(row => !row.deleted_at && row.status !== 'Trash' && row.status !== 'Merged' && /CV \/ Resume|Resume|简历/i.test(clean(row.material_type)));
  const versions = ensure(state, 'materialVersions');
  const changes = [];
  for (const app of ensure(state, 'applications')) {
    if (!applicationIsSubmitted(app) || app.submitted_resume_id) continue;
    const confirmed = ensure(state, 'applicationMaterials')
      .filter(row => row.application_id === app.application_id && !row.deleted_at && row.mapping_status === 'Confirmed' && (row.role === 'CV' || row.role === 'CV_EDITABLE'))
      .sort((a, b) => String(a.confirmed_at || a.created_at || '').localeCompare(String(b.confirmed_at || b.created_at || '')));
    const actual = confirmed.find(row => row.role === 'CV' && ['Actual Submitted File', 'Submission File'].includes(row.file_role || '')) || confirmed.find(row => row.role === 'CV_EDITABLE') || confirmed.find(row => row.role === 'CV');
    const version = actual && versions.find(row => row.material_version_id === actual.material_version_id);
    if (!actual || !version) continue;
    const resumeId = clean(actual.resume_id || version.material_id);
    app.submitted_resume_id = resumeId;
    app.resume_version_id = resumeId;
    app.selected_cv_resume_id = resumeId;
    app.selected_cv_version_id = version.material_version_id;
    app.selected_cv_file_name = version.file_name || actual.file_name || '';
    app.selected_cv_file_path = version.file_path || actual.original_file_path || '';
    app.selected_cv_hash = version.sha256 || actual.file_hash || '';
    app.selected_cv_modified_at = version.modified_at || actual.file_modified_at || '';
    app.submitted_snapshot_path = actual.snapshot_path || '';
    app.actual_submitted_file_path = actual.original_file_path || version.file_path || '';
    app.actual_submitted_file_name = actual.file_name || version.file_name || '';
    app.actual_submitted_file_type = materialExtension(version);
    app.actual_submitted_file_modified_at = version.modified_at || actual.file_modified_at || '';
    app.actual_submitted_file_hash = version.sha256 || actual.file_hash || '';
    app.submitted_pdf_snapshot = materialExtension(version) === 'PDF' ? (actual.snapshot_path || '') : '';
    app.submitted_pdf_reference = app.submitted_pdf_snapshot;
    app.editable_source_snapshot = confirmed.find(row => row.role === 'CV_EDITABLE')?.snapshot_path || '';
    app.editable_source_reference = app.editable_source_snapshot;
    app.confirmed_by_user = true;
    app.confirmed_at = actual.confirmed_at || actual.created_at || now();
    app.selected_cv_status = 'Submitted';
    app.selected_cv_updated_at = now();
    changes.push({ type: 'legacy-confirmed-snapshot', application_id: app.application_id, resume_id: resumeId, material_version_id: version.material_version_id });
  }
  const moved = new Set();
  const allLibraries = ensure(state, 'materialLibrary');
  const updateReferences = (fromId, toId) => {
    const fields = ['resume_version_id', 'submitted_resume_id', 'selected_cv_resume_id'];
    for (const app of ensure(state, 'applications')) for (const field of fields) if (clean(app[field]) === fromId) { app[field] = toId; changes.push({ type: 'application', application_id: app.application_id, field, from: fromId, to: toId }); }
    for (const row of ensure(state, 'applicationMaterials')) if (clean(row.resume_id) === fromId) { row.resume_id = toId; changes.push({ type: 'snapshot', application_material_id: row.application_material_id, field: 'resume_id', from: fromId, to: toId }); }
    for (const job of ensure(state, 'jobs')) if (clean(job.resume_version_id) === fromId) job.resume_version_id = toId;
  };
  const resolveMergedTarget = library => {
    let target = library;
    const seen = new Set();
    while (target?.status === 'Merged' && target.merged_into_resume_id && !seen.has(target.material_id)) {
      seen.add(target.material_id);
      target = allLibraries.find(row => row.material_id === target.merged_into_resume_id) || target;
    }
    return target;
  };
  for (const merged of allLibraries.filter(row => row.status === 'Merged' && row.merged_into_resume_id)) {
    const target = resolveMergedTarget(merged);
    const targetId = target?.resume_id || target?.material_id || '';
    const sourceId = merged.resume_id || merged.material_id;
    if (targetId && sourceId !== targetId) {
      const previous = merged.merged_into_resume_id;
      merged.merged_into_resume_id = targetId;
      updateReferences(sourceId, targetId);
      if (previous !== targetId) changes.push({ type: 'merge-chain', material_id: merged.material_id, from: previous, to: targetId });
    }
  }
  const candidateGroups = [];
  for (const left of libraries) {
    if (moved.has(left.material_id)) continue;
    const leftVersions = resumeLibraryVersions(state, left);
    const leftDocx = leftVersions.find(isEditableResumeVersion);
    const leftPdf = leftVersions.find(isSubmissionResumeVersion);
    const peers = libraries.filter(right => {
      if (right.material_id === left.material_id || moved.has(right.material_id)) return false;
      const rightVersions = resumeLibraryVersions(state, right);
      const rightDocx = rightVersions.find(isEditableResumeVersion);
      const rightPdf = rightVersions.find(isSubmissionResumeVersion);
      const sameDisplay = clean(left.display_name).trim().toLowerCase() === clean(right.display_name).trim().toLowerCase();
      const sameEditableHash = leftDocx?.sha256 && rightDocx?.sha256 && leftDocx.sha256 === rightDocx.sha256;
      const sameCompany = clean(right.company).toLowerCase() === clean(left.company).toLowerCase();
      const sameStem = compatibleResumeStems(left.display_name || leftDocx?.file_name, right.display_name || rightPdf?.file_name || rightDocx?.file_name);
      return (sameCompany && sameStem) || (sameDisplay && sameEditableHash);
    });
    for (const right of peers) {
      const rightVersions = resumeLibraryVersions(state, right);
      const rightDocx = rightVersions.find(isEditableResumeVersion);
      const rightPdf = rightVersions.find(isSubmissionResumeVersion);
      const hasComplementarySlots = (leftDocx && rightPdf && !leftPdf) || (rightDocx && leftPdf && !rightPdf);
      const sameEditableHash = leftDocx && rightDocx && leftDocx.sha256 && leftDocx.sha256 === rightDocx.sha256;
      if (!hasComplementarySlots && !sameEditableHash) continue;
      candidateGroups.push([left, right]);
      break;
    }
  }
  for (const [left, right] of candidateGroups) {
    if (moved.has(left.material_id) || moved.has(right.material_id)) continue;
    const leftVersions = resumeLibraryVersions(state, left);
    const rightVersions = resumeLibraryVersions(state, right);
    const leftDocx = leftVersions.find(isEditableResumeVersion), leftPdf = leftVersions.find(isSubmissionResumeVersion);
    const rightDocx = rightVersions.find(isEditableResumeVersion), rightPdf = rightVersions.find(isSubmissionResumeVersion);
    const canonical = (leftDocx && leftPdf) ? left : (rightDocx && rightPdf) ? right : leftDocx ? left : right;
    const duplicate = canonical === left ? right : left;
    const duplicateVersions = resumeLibraryVersions(state, duplicate);
    for (const version of duplicateVersions) {
      if (version.missing_at || ![isEditableResumeVersion(version), isSubmissionResumeVersion(version)].some(Boolean)) continue;
      const ext = materialExtension(version);
      const slotAlreadyPresent = ext === 'PDF' ? resumeLibraryVersions(state, canonical).some(isSubmissionResumeVersion) : resumeLibraryVersions(state, canonical).some(isEditableResumeVersion);
      if (slotAlreadyPresent) continue;
      version.material_id = canonical.material_id;
      version.updated_at = now(); version.updated_by = 'resume-migration';
      changes.push({ type: 'slot-pair', from: duplicate.material_id, to: canonical.material_id, material_version_id: version.material_version_id, extension: ext });
    }
    updateReferences(duplicate.resume_id || duplicate.material_id, canonical.resume_id || canonical.material_id);
    duplicate.merged_into_resume_id = canonical.resume_id || canonical.material_id;
    duplicate.merged_at = now(); duplicate.status = 'Merged'; duplicate.updated_at = now(); duplicate.updated_by = 'resume-migration';
    moved.add(duplicate.material_id);
  }
  normalizeResumeVersions(state);
  return changes;
}

function deriveSnapshot(state) {
  const { data: _coldData, ...hotState } = state || {};
  normalizeResumeVersions(hotState);
  const jobs = ensure(hotState, 'jobs').filter(item => item.job_id);
  const applications = ensure(hotState, 'applications').filter(item => item.application_id);
  const visibleJobs = jobs.filter(item => !item.deleted_at);
  const activeJobs = visibleJobs.filter(item => item.current_validity === 'Validated + Active' && activeStatuses.has(item.status));
  const count = (predicate) => visibleJobs.filter(item => predicate(item)).length;
  const summary = {
    total: visibleJobs.length, toReview: count(x => x.status === 'To Review'), interested: count(x => x.status === 'Interested'), toApply: count(x => x.status === 'To Apply'),
    applied: count(x => x.status === 'Applied'), onlineAssessment: count(x => x.status === 'Online Assessment'), interview: count(x => x.status === 'Interview'), offer: count(x => x.status === 'Offer'),
    rejectedClosed: count(x => ['Rejected', 'Closed / Expired'].includes(x.status)), activeValidated: activeJobs.length,
    expired: count(x => ['Expired/Closed', 'Expired', 'Closed'].includes(x.current_validity)), archived: count(x => x.status === 'Archived'),
    trash: ensure(hotState, 'trash').filter(x => !x.restored_at && x.permanently_deleted !== 'Yes').length, applications: applications.length,
    materials: ensure(hotState, 'materials').filter(x => !x.deleted_at && x.status !== 'Trash').length,
    calendarEvents: ensure(hotState, 'calendarEvents').filter(x => !x.deleted_at).length,
  };
  return { ...hotState, ok: true, generated_at: now(), master_path: paths.masterPath, jobs, activeJobs, applications, summary };
}

export async function getSnapshot() {
  const current = await loadState();
  const migrated = structuredClone(current);
  const changes = migrateResumeLibraryAssociations(migrated);
  if (changes.length) {
    await persist(migrated);
    return deriveSnapshot(await loadState());
  }
  return deriveSnapshot(current);
}

function updateJob(state, payload) {
  const job = findBy(ensure(state, 'jobs'), 'job_id', clean(payload.job_id || payload.record_id)); versionCheck(job, payload.expected_version);
  const old = job.status;
  for (const key of ['status', 'lifecycle_status', 'application_date', 'cv_version', 'cover_letter_version', 'notes', 'tags', 'programme_type', 'priority', 'application_deadline', 'current_validity', 'last_checked', 'validation_reason']) if (payload[key] !== undefined) job[key] = clean(payload[key]);
  job.updated_at = now(); job.updated_by = 'ui'; job.version = Number(job.version || 1) + 1;
  if (old !== job.status) addStatusHistory(state, job.job_id, old, job.status, payload.reason || 'Changed in CareerPilot UI');
  return { job_id: job.job_id, version: job.version };
}

function addJob(state, payload) {
  const jobId = clean(payload.job_id) || id('job');
  const row = { record_id: id('job-record'), job_id: jobId, legacy_job_id: '', company: clean(payload.company), job_title: clean(payload.job_title), location: clean(payload.location), job_url: clean(payload.job_url), official_url: clean(payload.official_url || payload.job_url), source: clean(payload.source || 'Manual'), status: clean(payload.status || 'To Review'), lifecycle_status: clean(payload.status || 'To Review'), current_validity: clean(payload.current_validity || 'Unknown'), programme_type: clean(payload.programme_type || 'Entry-level'), priority: clean(payload.priority), application_deadline: clean(payload.application_deadline), application_date: '', last_checked: '', validation_reason: 'Manual URL added; validate the actual vacancy page before active display', resume_variant: '', cv_version: '', cover_letter_version: '', tags: clean(payload.tags), notes: clean(payload.notes), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '', deleted_by: '', trash_reason: '', source_sheet: 'Jobs', legacy_row_number: '' };
  ensure(state, 'jobs').push(row); addStatusHistory(state, jobId, '', row.status, 'Added from CareerPilot UI'); return { job_id: jobId, version: 1 };
}

function markApplied(state, payload) {
  const job = findBy(ensure(state, 'jobs'), 'job_id', clean(payload.job_id)); versionCheck(job, payload.expected_version);
  const when = clean(payload.application_date || dateToday()); const old = job.status;
  Object.assign(job, { status: 'Applied', lifecycle_status: 'Applied', application_date: when, cv_version: clean(payload.resume_used), cover_letter_version: clean(payload.cover_letter_used), updated_at: now(), updated_by: 'ui', version: Number(job.version || 1) + 1 });
  if (payload.notes !== undefined) job.notes = clean(payload.notes);
  const apps = ensure(state, 'applications');
  let app = apps.find(item => item.job_id === job.job_id) || apps.find(item => item.company === job.company && item.job_title === job.job_title);
  if (!app) { app = { application_id: id('app'), version: 1 }; apps.push(app); }
  Object.assign(app, { job_id: job.job_id, attempt_date: when, company: job.company, job_title: job.job_title, job_url: job.job_url, platform: clean(payload.application_channel || job.source), status: 'Applied', submission_evidence: 'Marked as applied by user in CareerPilot', resume_used: clean(payload.resume_used), cover_letter_used: clean(payload.cover_letter_used), application_channel: clean(payload.application_channel || job.source), current_stage: 'Applied', next_action: clean(payload.next_action), next_deadline: clean(payload.next_deadline), notes: clean(payload.notes), updated_at: now(), updated_by: 'ui', version: Number(app.version || 1) + 1 });
  const eventRows = ensure(state, 'applicationEvents');
  if (!eventRows.some(item => item.application_id === app.application_id && item.event_type === 'Applied' && !item.deleted_at)) eventRows.push({ event_id: id('appevt'), application_id: app.application_id, job_id: job.job_id, event_type: 'Applied', event_date: when, event_time: '', deadline: clean(payload.next_deadline), round: '', title: '已投递', notes: clean(payload.notes), attachment_material_id: clean(payload.resume_material_version_id), source: 'CareerPilot UI', status: 'Completed', created_at: now(), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '' });
  if (old !== 'Applied') addStatusHistory(state, job.job_id, old, 'Applied', 'Marked as applied in CareerPilot');
  return { job_id: job.job_id, application_id: app.application_id, version: job.version };
}

async function addApplicationEvent(state, payload) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  const allowed = ['Applied', 'OA Received', 'OA Completed', 'Interview Invitation', 'Interview Completed', 'Assessment Centre', 'Offer', 'Rejected', 'Withdrawn', 'Follow-up', 'Other'];
  if (!allowed.includes(clean(payload.event_type))) throw Object.assign(new Error('不支持的申请进展类型。'), { code: 400 });
  const app = findBy(ensure(state, 'applications'), 'application_id', clean(payload.application_id));
  const eventKey = clean(payload.client_event_key || payload.idempotency_key);
  const existing = eventKey && ensure(state, 'applicationEvents').find(item => item.application_id === app.application_id && item.client_event_key === eventKey && !item.deleted_at);
  if (existing) {
    const stage = syncApplicationStage(state, app.application_id);
    return { event_id: existing.event_id, current_stage: stage, duplicate: true };
  }
  const eventType = clean(payload.event_type);
  const eventDate = clean(payload.event_date);
  const deadline = clean(payload.deadline);
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw Object.assign(new Error('截止日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  if (clean(payload.event_time) && !validTime(payload.event_time)) throw Object.assign(new Error('时间格式必须为 HH:MM。'), { code: 400 });
  if (clean(payload.deadline_time) && !validTime(payload.deadline_time)) throw Object.assign(new Error('截止时间格式必须为 HH:MM。'), { code: 400 });
  const row = { event_id: id('appevt'), application_id: app.application_id, job_id: app.job_id, event_type: eventType, event_date: eventDate, event_time: clean(payload.event_time), deadline, deadline_time: clean(payload.deadline_time), completed_at: clean(payload.completed_at || (/Completed/.test(eventType) ? eventDate : '')), received_at: clean(payload.received_at || (/Received|Invitation|Offer/.test(eventType) ? eventDate : '')), round: clean(payload.round), title: clean(payload.title || eventType), notes: clean(payload.notes), url: clean(payload.url), location: clean(payload.location), contact: clean(payload.contact), attachment_material_id: clean(payload.attachment_material_id), client_event_key: eventKey, source: 'CareerPilot UI', status: clean(payload.status || (/Completed|Rejected|Withdrawn|Applied/.test(eventType) ? 'Completed' : 'Pending')), created_at: now(), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '' };
  ensure(state, 'applicationEvents').push(row); const stage = syncApplicationStage(state, app.application_id); return { event_id: row.event_id, current_stage: stage };
}

function updateApplicationEvent(state, payload) {
  const row = findBy(ensure(state, 'applicationEvents'), 'event_id', clean(payload.event_id)); versionCheck(row, payload.expected_version);
  if (payload.event_type !== undefined && !['Applied', 'OA Received', 'OA Completed', 'Interview Invitation', 'Interview Completed', 'Assessment Centre', 'Offer', 'Rejected', 'Withdrawn', 'Follow-up', 'Other'].includes(clean(payload.event_type))) throw Object.assign(new Error('不支持的申请进展类型。'), { code: 400 });
  if (payload.event_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  if (payload.deadline !== undefined && clean(payload.deadline) && !/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.deadline))) throw Object.assign(new Error('截止日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  if (payload.event_time !== undefined && clean(payload.event_time) && !validTime(payload.event_time)) throw Object.assign(new Error('时间格式必须为 HH:MM。'), { code: 400 });
  if (payload.deadline_time !== undefined && clean(payload.deadline_time) && !validTime(payload.deadline_time)) throw Object.assign(new Error('截止时间格式必须为 HH:MM。'), { code: 400 });
  for (const key of ['event_type', 'event_date', 'event_time', 'deadline', 'deadline_time', 'completed_at', 'received_at', 'round', 'title', 'notes', 'url', 'location', 'contact', 'attachment_material_id', 'status']) if (payload[key] !== undefined) row[key] = clean(payload[key]);
  row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; const stage = syncApplicationStage(state, row.application_id); return { event_id: row.event_id, current_stage: stage };
}
function deleteApplicationEvent(state, payload) {
  const row = findBy(ensure(state, 'applicationEvents'), 'event_id', clean(payload.event_id)); versionCheck(row, payload.expected_version); row.deleted_at = now(); row.updated_at = row.deleted_at; row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; const stage = syncApplicationStage(state, row.application_id); return { event_id: row.event_id, current_stage: stage };
}

function saveCalendarEvent(state, payload) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('事项日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  if (clean(payload.event_time) && !validTime(payload.event_time)) throw Object.assign(new Error('时间格式必须为 HH:MM。'), { code: 400 });
  const row = { event_id: id('evt'), event_type: clean(payload.event_type || 'Follow-up'), title: clean(payload.title), event_date: clean(payload.event_date), event_time: clean(payload.event_time), company: clean(payload.company), job_id: clean(payload.job_id), application_id: clean(payload.application_id), notes: clean(payload.notes), reminder: clean(payload.reminder), source_type: 'Manual', source_field: 'CareerPilot UI', status: 'Scheduled', created_at: now(), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '' };
  ensure(state, 'calendarEvents').push(row);
  return { event_id: row.event_id };
}
function updateCalendarEvent(state, payload) {
  const row = findBy(ensure(state, 'calendarEvents'), 'event_id', clean(payload.event_id)); versionCheck(row, payload.expected_version);
  if (payload.event_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('事项日期格式必须为 YYYY-MM-DD。'), { code: 400 });
  if (payload.event_time !== undefined && clean(payload.event_time) && !validTime(payload.event_time)) throw Object.assign(new Error('时间格式必须为 HH:MM。'), { code: 400 });
  for (const key of ['event_type', 'title', 'event_date', 'event_time', 'company', 'job_id', 'application_id', 'notes', 'reminder', 'status']) if (payload[key] !== undefined) row[key] = clean(payload[key]);
  row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1;
  return { event_id: row.event_id };
}
function deleteCalendarEvent(state, payload) { const row = findBy(ensure(state, 'calendarEvents'), 'event_id', clean(payload.event_id)); versionCheck(row, payload.expected_version); row.deleted_at = now(); row.updated_at = row.deleted_at; row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { event_id: row.event_id }; }

function saveRows(state, key, rows) {
  if (key === 'profile') validateProfileRows(rows);
  state[key] = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
  return { sheet: key, rows: state[key].length };
}
function updateRoutine(state, payload) { const row = findBy(ensure(state, 'routines'), 'routine_id', clean(payload.routine_id)); versionCheck(row, payload.expected_version); for (const key of ['name', 'status', 'frequency', 'prompt', 'next_run', 'notes']) if (payload[key] !== undefined) row[key] = clean(payload[key]); row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { routine_id: row.routine_id }; }

function updateMaterial(state, payload) { const row = findBy(ensure(state, 'materials'), 'material_id', clean(payload.material_id)); versionCheck(row, payload.expected_version); for (const key of ['display_name', 'version_label', 'tags', 'target_role', 'default_for', 'status', 'notes']) if (payload[key] !== undefined) row[key] = clean(payload[key]); row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { material_id: row.material_id, version: row.version }; }
function addMaterial(state, payload) { const relative = clean(payload.relative_path).replaceAll('\\', '/'); if (ensure(state, 'materials').some(row => row.relative_path?.toLowerCase() === relative.toLowerCase() && !row.deleted_at)) throw Object.assign(new Error('该文件已经在资料库中。'), { code: 409 }); const materialId = clean(payload.material_id) || id('mat'); ensure(state, 'materials').push({ material_id: materialId, display_name: clean(payload.display_name || payload.file_name), file_name: clean(payload.file_name), relative_path: relative, file_path: clean(payload.file_path), material_type: clean(payload.material_type || 'Other'), version_label: clean(payload.version_label), tags: clean(payload.tags), target_role: clean(payload.target_role), default_for: '', last_updated: dateToday(), status: 'Active', notes: clean(payload.notes), source: 'UI import', updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '', trash_reason: '' }); return { material_id: materialId }; }
function setMaterialDefault(state, payload) { const row = findBy(ensure(state, 'materialDefaults'), 'job_family', clean(payload.job_family)); row.material_id = clean(payload.material_id); row.material_type = clean(payload.material_type || 'CV / Resume'); row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { job_family: row.job_family }; }
function trashMaterial(state, payload) { const row = findBy(ensure(state, 'materials'), 'material_id', clean(payload.material_id)); versionCheck(row, payload.expected_version); const when = now(); const original = row.status; Object.assign(row, { status: 'Trash', deleted_at: when, trash_reason: clean(payload.reason || 'Deleted from materials UI'), updated_at: when, updated_by: 'ui', version: Number(row.version || 1) + 1 }); ensure(state, 'trash').push({ trash_id: id('trash'), entity_type: 'Material', entity_id: row.material_id, deleted_at: when, original_status: original, reason: row.trash_reason, deleted_by: 'ui', restored_at: '', permanently_deleted: 'No' }); return { material_id: row.material_id }; }
function restoreMaterial(state, payload) { const row = findBy(ensure(state, 'materials'), 'material_id', clean(payload.material_id)); Object.assign(row, { status: 'Active', deleted_at: '', trash_reason: '', updated_at: now(), updated_by: 'ui', version: Number(row.version || 1) + 1 }); const trash = ensure(state, 'trash').find(item => item.entity_type === 'Material' && item.entity_id === row.material_id && !item.restored_at && item.permanently_deleted !== 'Yes'); if (trash) trash.restored_at = now(); return { material_id: row.material_id }; }

async function walk(dir) { const out = []; for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) { if (entry.name.toLowerCase() !== 'snapshots') out.push(...await walk(full)); } else if (entry.isFile() && !/^~\$/.test(entry.name) && !/\.tmp$/i.test(entry.name) && !/密码/.test(entry.name)) out.push(full); } return out; }
function materialType(name) { if (/cover[_ ]?letter|求职信/i.test(name)) return 'Cover Letter'; if (/cv|resume|简历/i.test(name)) return 'CV / Resume'; if (/portfolio|作品集/i.test(name)) return 'Portfolio'; if (/transcript|成绩单/i.test(name)) return 'Transcript'; if (/certificate|证书/i.test(name)) return 'Certificate'; return 'Other'; }
function materialRole(name) { if (/computer.?vision|计算机视觉/i.test(name)) return 'AI / ML / Computer Vision'; if (/fpga|hardware|embedded/i.test(name)) return 'FPGA / Hardware'; if (/risk|finance|bank|blackrock|bnp|cmsi|merchant|susquehanna/i.test(name)) return 'Risk / Banking'; if (/data|analytics/i.test(name)) return 'Data'; if (/graduate|毕业生|management.?trainee|\bmt\b/i.test(name)) return 'Graduate / MT'; if (/ai|llm|machine.?learning/i.test(name)) return 'AI / ML'; return ''; }
async function rescanMaterials(state, payload) { const settings = ensure(state, 'settings'); const settingKey = clean(payload.setting_key || 'materials_root') || 'materials_root'; const defaultRoot = settingKey === 'approved_resumes_root' ? path.join(paths.materialsRoot, 'approved_resumes') : paths.materialsRoot; const root = path.resolve(clean(payload.path || settings.find(row => row.key === settingKey)?.value || defaultRoot)); const files = await walk(root); const versions = ensure(state, 'materialVersions'); const libraries = ensure(state, 'materialLibrary'); let added = 0; let changed = 0; for (const file of files) { const stat = await fs.stat(file); const hash = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); const filePath = file.replaceAll(path.sep, '/'); const current = versions.filter(row => row.file_path?.toLowerCase() === filePath.toLowerCase() && !row.missing_at).sort((a, b) => clean(b.modified_at).localeCompare(clean(a.modified_at)))[0]; if (current?.sha256 === hash) continue; const relative = path.relative(root, file).replaceAll(path.sep, '/'); const relativeDir = path.dirname(relative).replaceAll(path.sep, '/'); const isManagedLibraryPath = /^active(?:\/|$)/i.test(relativeDir); const company = relativeDir === '.' || isManagedLibraryPath ? '' : relativeDir.split('/')[0]; const key = `${relativeDir.toLowerCase()}|${path.parse(file).name.toLowerCase()}|${materialType(file)}`; let library = libraries.find(row => row.notes?.includes(`scan-key:${key}`)); if (!library) { library = { material_id: id('lib'), display_name: path.parse(file).name, material_type: materialType(file), library_section: company ? 'Company Application' : 'General Library', role_family: materialRole(`${relative} ${file}`), company, job_title: '', latest_version_id: '', status: 'Active', tags: [materialRole(file)].filter(Boolean).join('; '), notes: `scan-key:${key}`, created_at: now(), updated_at: now(), updated_by: 'scanner', version: 1, deleted_at: '', approved_for_use: false, content_reference: false, format_template: false }; libraries.push(library); added++; } if (current) { current.status = 'Superseded'; changed++; } const versionId = id('ver'); const version = { material_version_id: versionId, material_id: library.material_id, file_name: path.basename(file), relative_path: relative, file_path: filePath, extension: path.extname(file).slice(1).toUpperCase(), file_size: stat.size, modified_at: stat.mtime.toISOString(), sha256: hash, version_label: '', format: path.extname(file).slice(1).toUpperCase(), status: 'Active', scan_id: id('scan'), created_at: now(), updated_at: now(), updated_by: 'scanner', version: 1, missing_at: '' }; versions.push(version); library.latest_version_id = versionId; library.updated_at = now(); added++; } const setting = key => settings.find(row => row.key === key); const upsert = (key, value) => { const row = setting(key); if (row) { row.value = value; row.updated_at = now(); } else settings.push({ key, value, value_type: 'text', description: '', updated_at: now(), updated_by: 'scanner', version: 1 }); }; const rootValue = root.replaceAll(path.sep, '/'); const scannedAt = now(); upsert(settingKey, rootValue); upsert(`${settingKey}_last_scanned`, scannedAt); upsert(`${settingKey}_scan_status`, `Ready: ${files.length} files; ${added} added/versioned; ${changed} superseded`); if (settingKey === 'materials_root') { upsert('materials_last_scanned', scannedAt); upsert('materials_scan_status', `Ready: ${files.length} files; ${added} added/versioned; ${changed} superseded`); } return { path: rootValue, files: files.length, added, changed, setting_key: settingKey }; }

async function snapshotApplicationMaterial(state, payload) {
  const app = findBy(ensure(state, 'applications'), 'application_id', clean(payload.application_id));
  const version = findBy(ensure(state, 'materialVersions'), 'material_version_id', clean(payload.material_version_id));
  if (version.missing_at || !(await fs.stat(version.file_path).catch(() => null))) throw Object.assign(new Error('原文件已找不到，请重新扫描或重新定位后再试。'), { code: 400 });
  const requestedFileRole = clean(payload.file_role);
  if (requestedFileRole === 'Editable Source' && !isEditableResumeVersion(version)) throw Object.assign(new Error('编辑源文件必须是 Word 可编辑文件（.docx）。'), { code: 400 });
  if (requestedFileRole === 'ResumeVersion Submission PDF' && !isSubmissionResumeVersion(version)) throw Object.assign(new Error('Resume Version 的投递版必须是 PDF 文件。'), { code: 400 });
  if (requestedFileRole === 'Actual Submitted File' && !isActualSubmittedVersion(version)) throw Object.assign(new Error('实际提交文件只能是 PDF 或 Word 文件。'), { code: 400 });
  const snapshotDir = path.join(materialsRootForState(state), 'snapshots', app.application_id);
  await fs.mkdir(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, `${Date.now()}_${path.basename(version.file_path)}`);
  await fs.copyFile(version.file_path, snapshotPath);
  const role = clean(payload.role || 'CV');
  const library = ensure(state, 'materialLibrary').find(item => item.material_id === clean(payload.resume_id || payload.material_id || version.material_id));
  const fileRole = requestedFileRole || (role === 'CV_EDITABLE' ? 'Editable Source' : role === 'CV' && isSubmissionResumeVersion(version) ? 'Submission File' : role === 'CV' ? 'Actual Submitted File' : role);
  const row = { application_material_id: id('appmat'), application_id: app.application_id, role, file_role: fileRole, resume_id: clean(payload.resume_id || library?.resume_id || version.material_id), resume_version_name: clean(payload.resume_version_name || library?.display_name || ''), material_version_id: version.material_version_id, file_name: version.file_name || path.basename(version.file_path || ''), original_file_path: version.file_path, snapshot_path: snapshotPath.replaceAll(path.sep, '/'), actual_submitted_file_path: fileRole === 'Actual Submitted File' ? version.file_path : '', actual_submitted_file_type: fileRole === 'Actual Submitted File' ? materialExtension(version) : '', file_hash: version.sha256, file_modified_at: version.modified_at, mapping_status: 'Confirmed', mapping_reason: clean(payload.mapping_reason || (fileRole === 'Actual Submitted File' ? 'Confirmed by user as the file actually submitted; immutable application snapshot' : 'Confirmed by user in CareerPilot; immutable application snapshot')), confirmed_at: now(), created_at: now(), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '' };
  ensure(state, 'applicationMaterials').filter(item => item.application_id === app.application_id && item.role === role && !item.deleted_at).forEach(item => { item.deleted_at = now(); });
  ensure(state, 'applicationMaterials').push(row);
  if (role === 'CV') app.resume_used = row.snapshot_path;
  if (role === 'Cover Letter') app.cover_letter_used = row.snapshot_path;
  app.updated_at = now(); app.version = Number(app.version || 1) + 1;
  return { application_material_id: row.application_material_id, snapshot_path: row.snapshot_path, file_role: row.file_role, resume_id: row.resume_id, resume_version_name: row.resume_version_name };
}

async function saveApplicationResume(state, payload) {
  const app = findBy(ensure(state, 'applications'), 'application_id', clean(payload.application_id));
  normalizeResumeVersions(state);
  const resumeId = clean(payload.resume_id || payload.resume_material_id || payload.material_id);
  const library = ensure(state, 'materialLibrary').find(item => item.material_id === resumeId);
  const versions = ensure(state, 'materialVersions');
  if (!library && resumeId) throw Object.assign(new Error('找不到这份 Resume Version。'), { code: 404 });
  const editableId = clean(payload.editable_version_id || library?.editable_version_id);
  const submissionId = clean(payload.submission_version_id || library?.submission_version_id);
  const actualId = clean(payload.actual_submitted_version_id || payload.material_version_id || submissionId || (!resumeId ? payload.resume_material_version_id : ''));
  const bundle = { resume_id: resumeId || (versions.find(item => item.material_version_id === submissionId)?.material_id || ''), resume_version_name: library?.display_name || '' };
  const editableVersion = editableId ? versions.find(item => item.material_version_id === editableId && item.material_id === bundle.resume_id && !item.missing_at) : null;
  const submissionVersion = submissionId ? versions.find(item => item.material_version_id === submissionId && item.material_id === bundle.resume_id && !item.missing_at) : null;
  const actualVersion = actualId ? versions.find(item => item.material_version_id === actualId && (!bundle.resume_id || item.material_id === bundle.resume_id) && !item.missing_at) : null;
  if (editableId && (!editableVersion || !isEditableResumeVersion(editableVersion))) throw Object.assign(new Error('这里需要选择 Word 可编辑文件（.docx）。'), { code: 400 });
  if (submissionId && (!submissionVersion || !isSubmissionResumeVersion(submissionVersion))) throw Object.assign(new Error('Resume Version 的投递版必须是 PDF 文件。'), { code: 400 });
  if (!actualVersion || !isActualSubmittedVersion(actualVersion)) throw Object.assign(new Error('请选择实际提交的 PDF 或 Word 文件。'), { code: 400 });
  const actualExisting = ensure(state, 'applicationMaterials').find(item => item.application_id === app.application_id && item.role === 'CV' && item.file_role === 'Actual Submitted File' && item.mapping_status === 'Confirmed' && !item.deleted_at && item.material_version_id === actualVersion.material_version_id);
  const editableExisting = editableVersion && ensure(state, 'applicationMaterials').find(item => item.application_id === app.application_id && item.role === 'CV_EDITABLE' && item.file_role === 'Editable Source' && item.mapping_status === 'Confirmed' && !item.deleted_at && item.material_version_id === editableVersion.material_version_id);
  const submission = actualExisting || await snapshotApplicationMaterial(state, { ...payload, application_id: app.application_id, role: 'CV', file_role: 'Actual Submitted File', resume_id: bundle.resume_id || actualVersion.material_id, resume_version_name: bundle.resume_version_name, material_version_id: actualVersion.material_version_id });
  const editable = editableVersion && editableVersion.material_version_id !== actualVersion.material_version_id
    ? (editableExisting || await snapshotApplicationMaterial(state, { ...payload, application_id: app.application_id, role: 'CV_EDITABLE', file_role: 'Editable Source', resume_id: bundle.resume_id, resume_version_name: bundle.resume_version_name, material_version_id: editableVersion.material_version_id }))
    : null;
  const actualResumeId = bundle.resume_id || actualVersion.material_id;
  app.resume_version_id = actualResumeId;
  app.submitted_resume_id = actualResumeId;
  app.submitted_snapshot_path = submission?.snapshot_path || '';
  app.actual_submitted_file_path = actualVersion.file_path || '';
  app.actual_submitted_file_name = actualVersion.file_name || '';
  app.actual_submitted_file_type = materialExtension(actualVersion);
  app.actual_submitted_file_modified_at = actualVersion.modified_at || '';
  app.actual_submitted_file_hash = actualVersion.sha256 || '';
  app.submitted_pdf_snapshot = isSubmissionResumeVersion(actualVersion) ? submission?.snapshot_path || '' : '';
  app.editable_source_snapshot = editable?.snapshot_path || '';
  app.submitted_pdf_reference = app.submitted_pdf_snapshot;
  app.editable_source_reference = app.editable_source_snapshot;
  app.confirmed_by_user = true;
  app.confirmed_at = now();
  app.selected_cv_resume_id = actualResumeId;
  app.selected_cv_version_id = actualVersion.material_version_id;
  app.selected_cv_submission_version_id = submissionVersion?.material_version_id || (isSubmissionResumeVersion(actualVersion) ? actualVersion.material_version_id : '');
  app.selected_cv_editable_version_id = editableVersion?.material_version_id || '';
  app.selected_cv_file_name = actualVersion.file_name || '';
  app.selected_cv_file_path = actualVersion.file_path || '';
  app.selected_cv_hash = actualVersion.sha256 || '';
  app.selected_cv_modified_at = actualVersion.modified_at || '';
  app.selected_cv_status = 'Submitted';
  app.selected_cv_updated_at = now();
  app.updated_at = now(); app.version = Number(app.version || 1) + 1;
  const job = ensure(state, 'jobs').find(item => item.job_id === app.job_id);
  if (job) { job.resume_version_id = actualResumeId; job.submission_file_snapshot = app.submitted_pdf_snapshot; job.editable_source_snapshot = editable?.snapshot_path || ''; job.updated_at = now(); }
  // A confirmed historical mapping is no longer a candidate suggestion.
  ensure(state, 'applicationMaterials').filter(item => item.application_id === app.application_id && item.role === 'CV' && item.mapping_status === 'Candidate' && !item.deleted_at).forEach(item => { item.deleted_at = now(); });
  return { resume_id: actualResumeId, resume_version_name: bundle.resume_version_name, submission, editable, actual_submitted_file: submission, submission_file_missing: !isSubmissionResumeVersion(actualVersion) };
}

function clearSelectedMaterial(app, role) {
  const prefix = role === 'Cover Letter' ? 'selected_cover_letter_' : 'selected_cv_';
  for (const key of Object.keys(app)) if (key.startsWith(prefix)) app[key] = '';
  app[`${prefix}status`] = 'Ignored';
  app[`${prefix}updated_at`] = now();
}

function setApplicationSelectedMaterial(state, payload) {
  const app = findBy(ensure(state, 'applications'), 'application_id', clean(payload.application_id));
  const role = clean(payload.role || 'CV');
  if (!['CV', 'Cover Letter'].includes(role)) throw Object.assign(new Error('不支持的申请材料类型。'), { code: 400 });
  if (['Ignored', 'Clear'].includes(clean(payload.selection_status))) {
    clearSelectedMaterial(app, role);
    if (clean(payload.selection_status) === 'Clear') { const prefix = role === 'Cover Letter' ? 'selected_cover_letter_' : 'selected_cv_'; for (const key of Object.keys(app)) if (key.startsWith(prefix)) app[key] = ''; }
    app.updated_at = now(); app.updated_by = 'ui'; app.version = Number(app.version || 1) + 1;
    return { application_id: app.application_id, role, selected: false, submitted: Boolean(role === 'CV' ? app.submitted_pdf_snapshot : app.cover_letter_used), status: 'Ignored' };
  }
  if (role === 'CV') {
    normalizeResumeVersions(state);
    const libraries = ensure(state, 'materialLibrary');
    const versions = ensure(state, 'materialVersions');
    const libraryId = clean(payload.resume_id || payload.material_id);
    const library = libraries.find(item => item.material_id === libraryId && !item.deleted_at);
    if (!library) throw Object.assign(new Error('请选择一份有效的 Resume Version。'), { code: 404 });
    const live = versions.filter(item => item.material_id === library.material_id && !item.deleted_at && !item.missing_at);
    const editableId = clean(payload.editable_version_id || library.editable_version_id);
    const submissionId = clean(payload.submission_version_id || library.submission_version_id);
    const editable = editableId ? live.find(item => item.material_version_id === editableId) : null;
    const submission = submissionId ? live.find(item => item.material_version_id === submissionId) : null;
    if (editableId && (!editable || !isEditableResumeVersion(editable))) throw Object.assign(new Error('这里需要选择 Word 可编辑文件（.docx）。'), { code: 400 });
    if (submissionId && (!submission || !isSubmissionResumeVersion(submission))) throw Object.assign(new Error('这里需要选择 PDF 投递文件。'), { code: 400 });
    const chosen = submission || editable;
    if (!chosen) throw Object.assign(new Error('这份简历还没有可用的 Word 或 PDF 文件。'), { code: 400 });
    const prefix = 'selected_cv_';
    app.selected_cv_material_id = library.material_id;
    app.selected_cv_resume_id = library.resume_id || library.material_id;
    app.selected_cv_version_id = chosen.material_version_id;
    app.selected_cv_editable_version_id = editable?.material_version_id || '';
    app.selected_cv_submission_version_id = submission?.material_version_id || '';
    app.selected_cv_file_name = chosen.file_name || '';
    app.selected_cv_file_path = chosen.file_path || '';
    app.selected_cv_hash = chosen.sha256 || '';
    app.selected_cv_modified_at = chosen.modified_at || '';
    app.selected_cv_version_name = clean(payload.resume_version_name || library.display_name || '');
    app[`${prefix}status`] = clean(payload.selection_status || 'Selected');
    app[`${prefix}updated_at`] = now();
    app.updated_at = now(); app.updated_by = 'ui'; app.version = Number(app.version || 1) + 1;
    return { application_id: app.application_id, role, selected: true, submitted: applicationIsSubmitted(app), status: app[`${prefix}status`], material_id: library.material_id, resume_id: app.selected_cv_resume_id, material_version_id: chosen.material_version_id, editable_version_id: app.selected_cv_editable_version_id, submission_version_id: app.selected_cv_submission_version_id, file_name: chosen.file_name };
  }
  normalizeResumeVersions(state);
  const versions = ensure(state, 'materialVersions');
  const versionId = clean(payload.submission_version_id || payload.material_version_id || payload.selected_version_id || payload.editable_version_id);
  const version = versionId ? versions.find(item => item.material_version_id === versionId && !item.deleted_at) : null;
  if (!version || version.missing_at || !(version.file_path && version.file_path.length)) throw Object.assign(new Error('请选择一份仍然存在的资料文件。'), { code: 400 });
  const libraryId = clean(payload.resume_id || payload.material_id || version.material_id);
  const library = ensure(state, 'materialLibrary').find(item => item.material_id === libraryId);
  const prefix = role === 'Cover Letter' ? 'selected_cover_letter_' : 'selected_cv_';
  const file = {
    material_id: libraryId,
    version_id: version.material_version_id,
    editable_version_id: clean(payload.editable_version_id),
    submission_version_id: clean(payload.submission_version_id || version.material_version_id),
    file_name: version.file_name || '',
    file_path: version.file_path || '',
    hash: version.sha256 || '',
    modified_at: version.modified_at || '',
    material_name: clean(payload.resume_version_name || library?.display_name || version.file_name || '')
  };
  app[`${prefix}material_id`] = file.material_id;
  app[`${prefix}version_id`] = file.version_id;
  app[`${prefix}editable_version_id`] = file.editable_version_id;
  app[`${prefix}submission_version_id`] = file.submission_version_id;
  app[`${prefix}file_name`] = file.file_name;
  app[`${prefix}file_path`] = file.file_path;
  app[`${prefix}hash`] = file.hash;
  app[`${prefix}modified_at`] = file.modified_at;
  app[`${prefix}version_name`] = file.material_name;
  if (role === 'CV') app.selected_cv_resume_id = file.material_id;
  app[`${prefix}status`] = clean(payload.selection_status || 'Selected');
  app[`${prefix}updated_at`] = now();
  app.updated_at = now(); app.updated_by = 'ui'; app.version = Number(app.version || 1) + 1;
  return { application_id: app.application_id, role, selected: true, submitted: Boolean(role === 'CV' ? app.submitted_pdf_snapshot : app.cover_letter_used), status: app[`${prefix}status`], material_id: file.material_id, material_version_id: file.version_id, file_name: file.file_name };
}

async function confirmApplicationMaterial(state, payload) {
  if (clean(payload.role || 'CV') === 'CV') {
    const versionId = clean(payload.actual_submitted_version_id || payload.material_version_id || payload.submission_version_id || payload.editable_version_id);
    const version = ensure(state, 'materialVersions').find(item => item.material_version_id === versionId);
    const resumeId = clean(payload.resume_id || payload.resume_material_id || payload.material_id || version?.material_id);
    if (resumeId || versionId) return saveApplicationResume(state, { ...payload, resume_id: resumeId, actual_submitted_version_id: versionId });
  }
  return snapshotApplicationMaterial(state, payload);
}

function updateMaterialRecord(state, payload) { const materialId = clean(payload.material_id); const row = ensure(state, 'materials').find(item => item.material_id === materialId) || ensure(state, 'materialLibrary').find(item => item.material_id === materialId); if (!row) throw Object.assign(new Error('资料不存在，请重新扫描后重试。'), { code: 404 }); versionCheck(row, payload.expected_version); const versions = ensure(state, 'materialVersions'); if (payload.editable_version_id) { const version = versions.find(item => item.material_version_id === clean(payload.editable_version_id) && item.material_id === materialId && !item.missing_at); if (!version || !isEditableResumeVersion(version)) throw Object.assign(new Error('这里需要选择 Word 可编辑文件（.docx）。'), { code: 400 }); } if (payload.submission_version_id) { const version = versions.find(item => item.material_version_id === clean(payload.submission_version_id) && item.material_id === materialId && !item.missing_at); if (!version || !isSubmissionResumeVersion(version)) throw Object.assign(new Error('这里需要选择 PDF 投递文件。'), { code: 400 }); } for (const key of ['display_name', 'version_label', 'tags', 'target_role', 'default_for', 'status', 'notes', 'approved_for_use', 'format_template', 'content_reference', 'editable_version_id', 'submission_version_id', 'pairing_status', 'pairing_reason']) if (payload[key] !== undefined) row[key] = typeof payload[key] === 'boolean' ? payload[key] : clean(payload[key]); normalizeResumeVersions(state); row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { material_id: row.material_id, version: row.version, approved_for_use: row.approved_for_use === true, editable_version_id: row.editable_version_id || '', submission_version_id: row.submission_version_id || '', pairing_status: row.pairing_status || '' }; }

async function readResumeFileVersion(filePath, fileName, materialId, source = 'ui') {
  const resolved = path.resolve(clean(filePath));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw Object.assign(new Error('上传文件不存在，请重新选择。'), { code: 400 });
  const name = path.basename(clean(fileName) || resolved);
  const extension = path.extname(name).slice(1).toUpperCase();
  const hash = crypto.createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
  return { material_version_id: id('ver'), material_id: materialId, file_name: name, relative_path: path.relative(workspace, resolved).replaceAll(path.sep, '/'), file_path: resolved.replaceAll(path.sep, '/'), extension, file_size: stat.size, modified_at: stat.mtime.toISOString(), sha256: hash, version_label: '', format: extension, status: 'Active', scan_id: '', created_at: now(), updated_at: now(), updated_by: source, version: 1, missing_at: '' };
}

function resumeLibraryRecord(payload, materialId) {
  const when = now();
  return { material_id: materialId, resume_id: materialId, display_name: clean(payload.display_name || '未命名简历'), material_type: 'CV / Resume', library_section: 'General Library', role_family: clean(payload.role_family), company: clean(payload.company), job_title: clean(payload.target_role), default_for: '', latest_version_id: '', status: payload.one_time ? 'One-time' : 'Active', tags: clean(payload.tags), notes: clean(payload.notes), created_at: when, updated_at: when, updated_by: 'ui', version: 1, deleted_at: '', approved_for_use: payload.approved_for_use === true, content_reference: payload.content_reference === true, format_template: false, editable_version_id: '', submission_version_id: '' };
}

async function importResumeVersion(state, payload) {
  const editablePath = clean(payload.editable_file_path);
  const submissionPath = clean(payload.submission_pdf_path);
  if (!editablePath && !submissionPath) throw Object.assign(new Error('至少选择一个 Word 或 PDF 文件。'), { code: 400 });
  const editableName = path.basename(clean(payload.editable_file_name) || editablePath);
  const submissionName = path.basename(clean(payload.submission_pdf_filename || payload.submission_file_name) || submissionPath);
  if (editablePath && !/^\.docx$/i.test(path.extname(editableName))) throw Object.assign(new Error('编辑版需要 Word 文件（.docx）。'), { code: 400 });
  if (submissionPath && !/^\.pdf$/i.test(path.extname(submissionName))) throw Object.assign(new Error('投递版需要 PDF 文件（.pdf）。'), { code: 400 });
  const materialId = id('lib');
  const library = resumeLibraryRecord(payload, materialId);
  const versions = ensure(state, 'materialVersions');
  const editable = editablePath ? await readResumeFileVersion(editablePath, editableName, materialId) : null;
  const submission = submissionPath ? await readResumeFileVersion(submissionPath, submissionName, materialId) : null;
  if (editable) { versions.push(editable); library.editable_version_id = editable.material_version_id; library.latest_version_id = editable.material_version_id; }
  if (submission) { versions.push(submission); library.submission_version_id = submission.material_version_id; library.latest_version_id = submission.material_version_id; }
  ensure(state, 'materialLibrary').push(library);
  normalizeResumeVersions(state);
  return { material_id: materialId, resume_id: materialId, editable_version_id: library.editable_version_id || '', submission_version_id: library.submission_version_id || '', editable_docx_path: library.editable_docx_path || '', submission_pdf_path: library.submission_pdf_path || '' };
}

async function importResumeSlot(state, payload) {
  const materialId = clean(payload.resume_id || payload.material_id);
  const slot = clean(payload.slot);
  const library = ensure(state, 'materialLibrary').find(item => item.material_id === materialId && !item.deleted_at && item.status !== 'Merged' && item.status !== 'Trash');
  if (!library) throw Object.assign(new Error('简历版本不存在，请刷新后重试。'), { code: 404 });
  if (!['editable_docx', 'submission_pdf'].includes(slot)) throw Object.assign(new Error('简历文件槽位无效。'), { code: 400 });
  const fileName = path.basename(clean(payload.file_name) || payload.file_path);
  const expectedExtension = slot === 'editable_docx' ? '.docx' : '.pdf';
  if (path.extname(fileName).toLowerCase() !== expectedExtension) throw Object.assign(new Error(slot === 'editable_docx' ? '编辑版需要 Word 文件（.docx）。' : '投递版需要 PDF 文件（.pdf）。'), { code: 400 });
  const version = await readResumeFileVersion(payload.file_path, fileName, library.material_id);
  const versions = ensure(state, 'materialVersions');
  const oldId = slot === 'editable_docx' ? clean(library.editable_version_id) : clean(library.submission_version_id);
  const old = versions.find(item => item.material_version_id === oldId && !item.missing_at);
  if (old) { old.status = 'Superseded'; old.updated_at = now(); old.updated_by = 'ui'; }
  versions.push(version);
  if (slot === 'editable_docx') library.editable_version_id = version.material_version_id;
  else library.submission_version_id = version.material_version_id;
  library.updated_at = now(); library.updated_by = 'ui'; library.version = Number(library.version || 1) + 1;
  normalizeResumeVersions(state);
  return { material_id: library.material_id, resume_id: library.resume_id, slot, material_version_id: version.material_version_id, before_path: old?.file_path || '', after_path: version.file_path, editable_docx_path: library.editable_docx_path || '', submission_pdf_path: library.submission_pdf_path || '' };
}
function associateMaterialVersion(state, payload) { const targetId = clean(payload.material_id || payload.target_material_id); const versionId = clean(payload.material_version_id); const target = ensure(state, 'materialLibrary').find(item => item.material_id === targetId); const version = ensure(state, 'materialVersions').find(item => item.material_version_id === versionId && !item.missing_at); if (!target || !version) throw Object.assign(new Error('找不到要关联的简历版本或文件。'), { code: 404 }); if (!/DOCX|DOC|PDF/i.test(materialExtension(version))) throw Object.assign(new Error('只有 DOCX/DOC 或 PDF 可以关联到 Resume Version。'), { code: 400 }); version.material_id = target.material_id; version.updated_at = now(); version.updated_by = 'ui'; version.version = Number(version.version || 1) + 1; normalizeResumeVersions(state); target.updated_at = now(); target.updated_by = 'ui'; target.version = Number(target.version || 1) + 1; return { material_id: target.material_id, material_version_id: version.material_version_id, pairing_status: target.pairing_status }; }
function repairResumeMappings(state) {
  normalizeResumeVersions(state);
  const changes = [];
  const versions = ensure(state, 'materialVersions');
  for (const app of ensure(state, 'applications')) {
    const selectedSubmissionId = clean(app.selected_cv_submission_version_id);
    const selectedEditableId = clean(app.selected_cv_editable_version_id);
    const selectedSubmission = versions.find(version => version.material_version_id === selectedSubmissionId);
    const selectedEditable = versions.find(version => version.material_version_id === selectedEditableId);
    if (selectedSubmissionId && (!selectedSubmission || !isSubmissionResumeVersion(selectedSubmission))) {
      changes.push({ application_id: app.application_id, field: 'selected_cv_submission_version_id', from: selectedSubmissionId, to: '', reason: 'submission slot contained a non-PDF file; file preserved in its original version record' });
      app.selected_cv_submission_version_id = '';
      app.invalid_resume_role_mapping = true;
    }
    if (selectedEditableId && (!selectedEditable || !isEditableResumeVersion(selectedEditable))) {
      changes.push({ application_id: app.application_id, field: 'selected_cv_editable_version_id', from: selectedEditableId, to: '', reason: 'editable slot contained a non-DOCX/DOC file; file preserved in its original version record' });
      app.selected_cv_editable_version_id = '';
      app.invalid_resume_role_mapping = true;
    }
  }
  ensure(state, 'resumeMappingAudit').push({ audit_id: id('resume-audit'), audited_at: now(), changes });
  return { checked: ensure(state, 'materialLibrary').filter(item => /CV \/ Resume|Resume|简历/i.test(clean(item.material_type))).length, changes: changes.length, details: changes };
}
async function markAppliedWithSnapshot(state, payload) { const actualId = payload.actual_submitted_version_id || payload.submission_version_id || payload.resume_material_version_id; const result = markApplied(state, { ...payload, resume_material_version_id: actualId }); const app = findBy(ensure(state, 'applications'), 'application_id', result.application_id); if (clean(payload.resume_id || payload.resume_material_id || payload.material_id || payload.editable_version_id || actualId)) { const bundle = await saveApplicationResume(state, { ...payload, application_id: result.application_id, actual_submitted_version_id: actualId }); let cover = null; const coverVersionId = clean(payload.cover_letter_material_version_id || app.selected_cover_letter_version_id); if (coverVersionId) { cover = await snapshotApplicationMaterial(state, { application_id: result.application_id, role: 'Cover Letter', material_version_id: coverVersionId, material_id: app.selected_cover_letter_material_id }); app.selected_cover_letter_status = 'Submitted'; app.selected_cover_letter_updated_at = now(); } return { ...result, resume_id: bundle.resume_id, submission_snapshot_path: bundle.submission?.snapshot_path || '', editable_source_snapshot_path: bundle.editable?.snapshot_path || '', cover_letter_snapshot_path: cover?.snapshot_path || '', submission_file_missing: bundle.submission_file_missing }; } if (clean(payload.resume_material_version_id)) { const link = await snapshotApplicationMaterial(state, { application_id: result.application_id, role: 'CV', file_role: 'Actual Submitted File', material_version_id: payload.resume_material_version_id }); app.resume_used = link.snapshot_path; app.submitted_resume_id = link.resume_id; app.submitted_snapshot_path = link.snapshot_path; app.actual_submitted_file_path = link.original_file_path; app.actual_submitted_file_name = link.file_name; app.actual_submitted_file_type = materialExtension(ensure(state, 'materialVersions').find(v => v.material_version_id === link.material_version_id)); app.confirmed_by_user = true; app.confirmed_at = now(); return { ...result, submission_snapshot_path: link.snapshot_path }; } return result; }
async function rescanMaterialsWithMissing(state, payload) { const result = await rescanMaterials(state, payload); const root = path.resolve(result.path); const prefix = root.replaceAll(path.sep, '/').toLowerCase(); let missing = 0; for (const version of ensure(state, 'materialVersions')) { const filePath = clean(version.file_path).replaceAll(path.sep, '/'); if (version.missing_at || !filePath || !(filePath.toLowerCase() === prefix || filePath.toLowerCase().startsWith(`${prefix}/`))) continue; if (!(await fs.stat(version.file_path).catch(() => null))) { version.missing_at = now(); version.status = 'Missing'; missing++; } } return { ...result, missing }; }
function saveSetting(state, payload) { const rows = ensure(state, 'settings'); const key = clean(payload.key); let row = rows.find(item => item.key === key); if (!row) { row = { key, value: '', value_type: clean(payload.value_type || 'text'), description: clean(payload.description), updated_at: now(), updated_by: 'ui', version: 1 }; rows.push(row); } row.value = clean(payload.value); row.updated_at = now(); row.updated_by = 'ui'; row.version = Number(row.version || 1) + 1; return { key, value: row.value }; }
function saveReminderSettings(state, payload) {
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
  return saveSetting(state, { key: 'reminder_settings', value: JSON.stringify({ ...settings, updated_at: now() }), value_type: 'protected-reminder-settings', description: '邮件提醒设置；不包含 SMTP 授权码。' });
}
function reminderKey(payload) { return clean(payload.reminder_key || [payload.application_id || payload.job_id, payload.event_id || '', payload.deadline || '', payload.threshold || ''].join('|')); }
function claimReminder(state, payload) {
  const key = reminderKey(payload); if (!key) throw Object.assign(new Error('提醒缺少去重键。'), { code: 400 });
  const rows = ensure(state, 'reminderSendLog'); const current = rows.find(row => row.reminder_key === key && row.status !== 'Failed'); const nowValue = now();
  if (current?.status === 'Sent') return { claimed: false, reason: 'already-sent', log_id: current.log_id };
  if (current?.status === 'Claimed' && Date.parse(current.claimed_at || current.updated_at || '') > Date.now() - 15 * 60 * 1000) return { claimed: false, reason: 'in-progress', log_id: current.log_id };
  const row = current || { log_id: id('reminder'), reminder_key: key, created_at: nowValue };
  Object.assign(row, { application_id: clean(payload.application_id), event_id: clean(payload.event_id), job_id: clean(payload.job_id), company: clean(payload.company), job_title: clean(payload.job_title), kind: clean(payload.kind), deadline: clean(payload.deadline), threshold: clean(payload.threshold), recipient: clean(payload.recipient), status: 'Claimed', claimed_at: nowValue, updated_at: nowValue, sent_at: '', failed_at: '', error: '', version: Number(row.version || 0) + 1 });
  if (!current) rows.push(row);
  return { claimed: true, log_id: row.log_id };
}
function updateReminderLog(state, payload, status) {
  const row = findBy(ensure(state, 'reminderSendLog'), 'log_id', clean(payload.log_id)); const when = now();
  row.status = status; row.updated_at = when; row.version = Number(row.version || 1) + 1;
  if (status === 'Sent') { row.sent_at = when; row.smtp_code = clean(payload.smtp_code || '250'); row.error = ''; }
  else { row.failed_at = when; row.error = clean(payload.error || '邮件发送失败。').slice(0, 500); }
  return { log_id: row.log_id, status: row.status };
}
function logReminderTest(state, payload) {
  const row = { log_id: id('reminder-test'), reminder_key: `test|${Date.now()}`, application_id: '', event_id: '', job_id: '', company: 'CareerPilot', job_title: '测试邮件', kind: 'test', deadline: '', threshold: 'test', recipient: clean(payload.recipient), status: 'Sent', claimed_at: now(), sent_at: now(), failed_at: '', error: '', subject: clean(payload.subject), updated_at: now(), created_at: now(), version: 1, is_test: true };
  ensure(state, 'reminderSendLog').push(row); return { log_id: row.log_id, status: row.status };
}
function createSearchRun(state, payload) { const row = { search_run_id: id('search'), routine_id: clean(payload.routine_id), created_at: now(), requested_by: 'ui', status: 'Requested', location: clean(payload.location), role_families: clean(payload.role_families), graduation_year: clean(payload.graduation_year), company_types: clean(payload.company_types), keywords: clean(payload.keywords), negative_keywords: clean(payload.negative_keywords), sources: clean(payload.sources), progress_json: JSON.stringify({ phase: 'queued', message: '等待在 Codex 中执行搜索、验证和去重' }), employers_checked: 0, sources_checked: 0, found_count: 0, existing_count: 0, invalid_count: 0, new_count: 0, started_at: '', completed_at: '', notes: '本地 UI 只创建搜索请求，不假装已经联网搜索。', updated_at: now(), version: 1 }; ensure(state, 'searchRuns').push(row); return { search_run_id: row.search_run_id, status: row.status }; }
function updateSearchRun(state, payload) { const row = findBy(ensure(state, 'searchRuns'), 'search_run_id', clean(payload.search_run_id)); versionCheck(row, payload.expected_version); for (const key of ['status', 'progress_json', 'employers_checked', 'sources_checked', 'found_count', 'existing_count', 'invalid_count', 'new_count', 'started_at', 'completed_at', 'notes']) if (payload[key] !== undefined) row[key] = clean(payload[key]); row.updated_at = now(); row.version = Number(row.version || 1) + 1; return { search_run_id: row.search_run_id }; }

export async function applyAction(action, payload = {}) {
  const current = await loadState();
  const state = structuredClone(current);
  migrateResumeLibraryAssociations(state);
  let result;
  if (action === 'update-job') result = updateJob(state, payload);
  else if (action === 'recheck-job') result = updateJob(state, { ...payload, current_validity: 'Unknown', last_checked: dateToday(), validation_reason: '重新验证请求已创建；需要实际打开职位页面确认。' });
  else if (action === 'add-job') result = addJob(state, payload);
  else if (action === 'mark-applied') result = await markAppliedWithSnapshot(state, payload);
  else if (action === 'save-profile') result = saveRows(state, 'profile', payload.rows);
  else if (action === 'save-preferences') result = saveRows(state, 'preferences', payload.rows);
  else if (action === 'update-routine') result = updateRoutine(state, payload);
  else if (action === 'add-calendar-event') result = saveCalendarEvent(state, payload);
  else if (action === 'update-calendar-event') result = updateCalendarEvent(state, payload);
  else if (action === 'delete-calendar-event') result = deleteCalendarEvent(state, payload);
  else if (action === 'add-application-event') result = await addApplicationEvent(state, payload);
  else if (action === 'update-application-event') result = updateApplicationEvent(state, payload);
  else if (action === 'delete-application-event') result = deleteApplicationEvent(state, payload);
  else if (action === 'confirm-application-material') result = await confirmApplicationMaterial(state, payload);
  else if (action === 'set-application-selected-material') result = setApplicationSelectedMaterial(state, payload);
  else if (action === 'save-setting') result = saveSetting(state, payload);
  else if (action === 'save-reminder-settings') result = saveReminderSettings(state, payload);
  else if (action === 'claim-reminder') result = claimReminder(state, payload);
  else if (action === 'mark-reminder-sent') result = updateReminderLog(state, payload, 'Sent');
  else if (action === 'mark-reminder-failed') result = updateReminderLog(state, payload, 'Failed');
  else if (action === 'log-reminder-test') result = logReminderTest(state, payload);
  else if (action === 'rescan-materials') result = await rescanMaterialsWithMissing(state, payload);
  else if (action === 'rescan-approved-materials') result = await rescanMaterialsWithMissing(state, { ...payload, setting_key: 'approved_resumes_root' });
  else if (action === 'create-search-run') result = createSearchRun(state, payload);
  else if (action === 'update-search-run') result = updateSearchRun(state, payload);
  else if (action === 'update-material') result = updateMaterialRecord(state, payload);
  else if (action === 'import-resume-version') result = await importResumeVersion(state, payload);
  else if (action === 'import-resume-slot') result = await importResumeSlot(state, payload);
  else if (action === 'repair-resume-mappings') result = repairResumeMappings(state);
  else if (action === 'associate-material-version') result = associateMaterialVersion(state, payload);
  else if (action === 'add-material') result = addMaterial(state, payload);
  else if (action === 'set-material-default') result = setMaterialDefault(state, payload);
  else if (action === 'trash-material') result = trashMaterial(state, payload);
  else if (action === 'restore-material') result = restoreMaterial(state, payload);
  else if (action === 'trash-job') { const job = findBy(ensure(state, 'jobs'), 'job_id', clean(payload.job_id)); versionCheck(job, payload.expected_version); const when = now(); const original = job.status; Object.assign(job, { deleted_at: when, deleted_by: 'ui', status: 'Archived', lifecycle_status: 'Archived', trash_reason: clean(payload.reason || 'Deleted from UI'), updated_at: when, version: Number(job.version || 1) + 1 }); ensure(state, 'trash').push({ trash_id: id('trash'), entity_type: 'Job', entity_id: job.job_id, deleted_at: when, original_status: original, reason: job.trash_reason, deleted_by: 'ui', restored_at: '', permanently_deleted: 'No' }); result = { job_id: job.job_id }; }
  else if (action === 'restore-job') { const job = findBy(ensure(state, 'jobs'), 'job_id', clean(payload.job_id)); const trash = ensure(state, 'trash').find(item => item.entity_type === 'Job' && item.entity_id === job.job_id && !item.restored_at && item.permanently_deleted !== 'Yes'); const restored = clean(payload.status || trash?.original_status || 'To Review'); Object.assign(job, { deleted_at: '', deleted_by: '', trash_reason: '', status: restored, lifecycle_status: restored, updated_at: now(), updated_by: 'ui', version: Number(job.version || 1) + 1 }); if (trash) trash.restored_at = now(); result = { job_id: job.job_id }; }
  else if (action === 'permanent-delete-job') { const job = findBy(ensure(state, 'jobs'), 'job_id', clean(payload.job_id)); if (!job.deleted_at && job.status !== 'Archived') throw Object.assign(new Error('只有回收站中的岗位可以永久删除。'), { code: 400 }); const trash = ensure(state, 'trash').find(item => item.entity_type === 'Job' && item.entity_id === job.job_id && !item.restored_at && item.permanently_deleted !== 'Yes'); if (!trash) throw Object.assign(new Error('找不到回收站记录。'), { code: 404 }); job.permanently_deleted = 'Yes'; trash.permanently_deleted = 'Yes'; result = { job_id: job.job_id }; }
  else if (action === 'add-application-material-candidate') { const version = findBy(ensure(state, 'materialVersions'), 'material_version_id', clean(payload.material_version_id)); const row = { application_material_id: id('appmat'), application_id: clean(payload.application_id), role: clean(payload.role || 'CV'), material_version_id: version.material_version_id, original_file_path: version.file_path, snapshot_path: '', file_hash: version.sha256, file_modified_at: version.modified_at, mapping_status: 'Candidate', mapping_reason: clean(payload.mapping_reason || 'Possible historical match; user confirmation required.'), confirmed_at: '', created_at: now(), updated_at: now(), updated_by: 'migration-review', version: 1, deleted_at: '' }; ensure(state, 'applicationMaterials').push(row); result = { application_material_id: row.application_material_id }; }
  else throw Object.assign(new Error(`不支持的操作：${action}`), { code: 400 });
  await persist(state);
  return result;
}
