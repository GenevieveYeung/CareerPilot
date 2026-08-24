// Shared profile facts helpers.
// Profile remains stored as the existing generic Profile rows so the
// migration is additive and old data is preserved. Structured records live in
// JSON values under stable row keys.

const clean = value => value == null ? '' : String(value).trim();

function parseValue(rows, key, fallback) {
  const row = (rows || []).find(item => item.key === key);
  if (!row) return fallback;
  try {
    const value = JSON.parse(row.value || '');
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}
export function profileObject(rows, key) {
  const value = parseValue(rows, key, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function profileList(rows, key) {
  const value = parseValue(rows, key, []);
  return Array.isArray(value) ? value : [];
}

const normaliseDate = value => /^\d{4}-\d{2}$/.test(clean(value)) ? clean(value) : '';

function uniqueIds(records, label) {
  const ids = records.map(record => clean(record?.[label])).filter(Boolean);
  if (new Set(ids).size !== ids.length) {
    throw Object.assign(new Error(`个人资料中的 ${label} 不能重复。`), { code: 400 });
  }
}

export function validateProfileRows(rows) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('个人资料格式不正确。'), { code: 400 });
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw Object.assign(new Error('个人资料记录格式不正确。'), { code: 400 });
    const key = clean(row.key);
    if (!['education_records', 'work_authorization_records', 'language_records'].includes(key)) continue;
    let records;
    try { records = JSON.parse(row.value || '[]'); } catch (_) { throw Object.assign(new Error(`${key} 格式不正确。`), { code: 400 }); }
    if (!Array.isArray(records)) throw Object.assign(new Error(`${key} 必须是记录列表。`), { code: 400 });
    if (key === 'education_records') {
      uniqueIds(records, 'education_id');
      for (const record of records) for (const field of ['start_date', 'end_date', 'expected_graduation_date']) {
        if (clean(record?.[field]) && !/^\d{4}-\d{2}$/.test(clean(record[field]))) {
          throw Object.assign(new Error(`教育经历的日期必须是 YYYY-MM：${field}。`), { code: 400 });
        }
      }
    }
    if (key === 'work_authorization_records') uniqueIds(records, 'authorization_id');
    if (key === 'language_records') uniqueIds(records, 'language_id');
  }
  return true;
}

function educationMatches(record, requested) {
  const value = clean(requested).toLowerCase();
  if (!value) return true;
  const level = `${clean(record.level)} ${clean(record.education_level)} ${clean(record.degree)}`.toLowerCase();
  if (/post|master|硕士|研究生|phd|doctor|博士/.test(value)) return /master|硕士|研究生|phd|doctor|博士|post/.test(level);
  if (/under|bachelor|本科|大学|associate|副学士|diploma|文凭/.test(value)) return /bachelor|本科|大学|associate|副学士|diploma|文凭|under/.test(level);
  return level.includes(value);
}

function dateFor(record, current) {
  if (current && record.currently_studying) return clean(record.expected_graduation_date || record.end_date);
  return clean(record.end_date || record.expected_graduation_date);
}

export function buildProfileAutofill(rows, options = {}) {
  const candidate = profileObject(rows, 'candidate');
  const legacyAuth = profileObject(rows, 'work_authorization');
  const education = profileList(rows, 'education_records');
  const authorizations = profileList(rows, 'work_authorization_records');
  const requestedLevel = clean(options.education_level || options.educationLevel);
  const selectedEducation = education.find(record => educationMatches(record, requestedLevel)) || education[0] || {};
  const selectedAuth = authorizations.find(record => clean(options.region || options.country_region) && clean(record.country_region).toLowerCase() === clean(options.region || options.country_region).toLowerCase()) || authorizations[0] || legacyAuth;
  const result = {
    legal_first_name: clean(candidate.legal_first_name),
    legal_last_name: clean(candidate.legal_last_name),
    preferred_name: clean(candidate.preferred_name),
    chinese_name: clean(candidate.chinese_name),
    email: clean(candidate.email),
    phone_country_code: clean(candidate.phone_country_code),
    phone: clean(candidate.phone),
    current_location: clean(candidate.current_location || candidate.location),
    university: clean(selectedEducation.institution_official || selectedEducation.institution_display),
    school_faculty: clean(selectedEducation.school_faculty),
    degree: clean(selectedEducation.degree),
    major: clean(selectedEducation.programme || selectedEducation.major),
    secondary_major_or_minor: clean(selectedEducation.secondary_major_or_minor || selectedEducation.minor),
    education_start_date: clean(selectedEducation.start_date),
    education_end_date: dateFor(selectedEducation, false),
    expected_graduation_date: clean(selectedEducation.expected_graduation_date || (selectedEducation.currently_studying ? selectedEducation.end_date : '')),
    visa_type: clean(selectedAuth.visa_type),
    visa_status: clean(selectedAuth.current_status),
    work_authorization: clean(selectedAuth.work_authorization || selectedAuth.current_authorization),
    sponsorship_requirement: clean(selectedAuth.sponsorship_requirement),
    source_education_id: clean(selectedEducation.education_id),
    source_authorization_id: clean(selectedAuth.authorization_id),
  };
  return { profile: result, selected_education: selectedEducation, selected_authorization: selectedAuth, available_education_records: education.length, available_authorization_records: authorizations.length };
}
