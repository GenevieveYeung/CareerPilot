import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import projectPaths from './project_paths.cjs';

const paths = projectPaths.getProjectPaths({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const workspace = paths.repoRoot;
const statePath = process.env.CAREERPILOT_RUNTIME_STATE_PATH || paths.runtimeStatePath;
const outputPath = process.env.CAREERPILOT_RUNTIME_MIRROR_PATH || paths.masterPath;
let SpreadsheetFile;
let Workbook;
try {
  const artifactModule = process.env.CAREERPILOT_ARTIFACT_TOOL_MODULE || '@oai/artifact-tool';
  ({ SpreadsheetFile, Workbook } = await import(artifactModule));
} catch (_) {
  // The local JSON runtime remains fully usable without the optional Excel mirror package.
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: 'optional Excel mirror dependency is not installed' }));
  process.exit(0);
}
const text = value => value == null ? '' : String(value);
const staticHeaders = {
  Trash: ['trash_id','entity_type','entity_id','deleted_at','original_status','reason','deleted_by','restored_at','permanently_deleted'],
  Search_Results: ['search_result_id','search_run_id','job_id','company','job_title','job_url','source','validation_status','dedupe_key','match_reason','last_checked','notes','created_at','updated_at','version','status','official_url','application_status'],
  Reminder_Send_Log: ['log_id','reminder_key','application_id','event_id','job_id','company','job_title','kind','deadline','threshold','recipient','status','claimed_at','sent_at','failed_at','smtp_code','error','subject','created_at','updated_at','version','is_test'],
};
function rowsFor(snapshot, key) { return Array.isArray(snapshot[key]) ? snapshot[key] : []; }
function headersFor(snapshot, key) {
  const seen = new Set(); const headers = [];
  for (const row of rowsFor(snapshot, key)) for (const name of Object.keys(row)) if (name !== '__rowNumber' && !seen.has(name)) { seen.add(name); headers.push(name); }
  return headers.length ? headers : (staticHeaders[key] || ['value']);
}
function matrix(snapshot, key) { const headers = headersFor(snapshot, key); return { headers, values: [headers, ...rowsFor(snapshot, key).map(row => headers.map(header => row[header] ?? ''))] }; }
function columnName(index) { let value = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) value = String.fromCharCode(65 + ((n - 1) % 26)) + value; return value; }
const stateKeyBySheet = { Applications:'applications', Profile:'profile', Preferences:'preferences', Search_Routines:'routines', Search_History:'searchHistory', Status_History:'statusHistory', Trash:'trash', Audit_Log:'auditLog', Sync_Metadata:'syncMetadata', Materials:'materials', Material_Defaults:'materialDefaults', Calendar_Events:'calendarEvents', Companies:'companies', Application_Events:'applicationEvents', Material_Library:'materialLibrary', Material_Versions:'materialVersions', Application_Materials:'applicationMaterials', Search_Runs:'searchRuns', Search_Results:'searchResults', Settings:'settings', Reminder_Send_Log:'reminderSendLog' };
function addSheet(workbook, snapshot, sheetName) { const { headers, values } = matrix(snapshot, stateKeyBySheet[sheetName] || sheetName); const sheet = workbook.worksheets.add(sheetName); sheet.showGridLines = false; const endColumn = columnName(headers.length - 1); sheet.getRange(`A1:${endColumn}${values.length}`).values = values; sheet.freezePanes.freezeRows(1); return sheet; }

const envelope = JSON.parse(await fs.readFile(statePath, 'utf8'));
const snapshot = envelope.snapshot || envelope;
const jobMatrix = matrix(snapshot, 'jobs');
const jobsCsv = jobMatrix.values.map(row => row.map(value => { const cell = text(value); return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell; }).join(',')).join('\n');
const workbook = await Workbook.fromCSV(jobsCsv, { sheetName: 'Jobs' });
const order = ['Applications','Profile','Preferences','Search_Routines','Search_History','Status_History','Trash','Audit_Log','Sync_Metadata','Materials','Material_Defaults','Calendar_Events','Companies','Application_Events','Material_Library','Material_Versions','Application_Materials','Search_Runs','Search_Results','Settings','Reminder_Send_Log'];
for (const key of order) addSheet(workbook, snapshot, key);
const output = await SpreadsheetFile.exportXlsx(workbook);
const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await output.save(tempPath);
await fs.rename(tempPath, outputPath);
console.log(JSON.stringify({ ok: true, output: outputPath, jobs: rowsFor(snapshot, 'jobs').length, applications: rowsFor(snapshot, 'applications').length }));
