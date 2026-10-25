// Creates the default folders and categories so the app is usable straight after setup (BUILD_SPEC §12).
// Safe to re-run: each collection is only seeded while it is empty. Run with: npm run seed
// Also: SLA policies, sample filing rules and settings (auto-acknowledgement linked but OFF).

import mongoose from 'mongoose';
import { env } from '../src/config/env.ts';
import { CategoryModel } from '../src/models/Category.ts';
import { DepartmentModel } from '../src/models/Department.ts';
import { FolderModel } from '../src/models/Folder.ts';
import { TemplateModel } from '../src/models/Template.ts';
import { AssignmentRuleModel } from '../src/models/AssignmentRule.ts';
import { SettingsModel } from '../src/models/Settings.ts';
import { SlaPolicyModel } from '../src/models/SlaPolicy.ts';

const FOLDERS = [
  'Dividend',
  'E-Mandate',
  'Probate / Transmission',
  'KYC & Record Updates',
  'Share Certificates',
  'Complaints',
  'General',
];

const CATEGORIES = [
  { name: 'Dividend', type: 'enquiry', color: '#0f6cbd' },
  { name: 'E-Mandate', type: 'enquiry', color: '#038387' },
  { name: 'Probate', type: 'enquiry', color: '#8764b8' },
  { name: 'KYC', type: 'enquiry', color: '#005b70' },
  { name: 'Complaint', type: 'enquiry', color: '#d13438' },
  { name: 'Awaiting documents', type: 'status', color: '#c19c00' },
  { name: 'Escalated', type: 'status', color: '#ca5010' },
  { name: 'Call back', type: 'status', color: '#107c10' },
] as const;

const SIGN_OFF = '<p>Kind regards,<br>{{officer.name}}<br>Shareholder Enquiries</p>';

// Sample canned responses; edit or replace them in Admin → Templates (Phase 7).
const TEMPLATES = [
  {
    name: 'Acknowledgement',
    subject: 'We have received your enquiry',
    bodyHtml: `<p>Dear {{contact.name}},</p><p>Thank you for contacting us. Your enquiry has been received and given the reference <strong>{{ticket.reference}}</strong>. Please quote this reference in any further correspondence.</p><p>An officer will respond as soon as possible.</p>${SIGN_OFF}`,
  },
  {
    name: 'Dividend mandate requirements',
    subject: 'E-dividend mandate requirements',
    bodyHtml: `<p>Dear {{contact.name}},</p><p>To have your dividends paid directly into your bank account, please complete the e-dividend mandate form and return it with:</p><ul><li>a valid means of identification;</li><li>your bank's stamp and an authorised signatory's signature on the form.</li></ul><p>Once we receive the completed form, your mandate will be updated and future dividends paid directly.</p>${SIGN_OFF}`,
  },
  {
    name: 'Change of address — documents required',
    subject: 'Updating your address',
    bodyHtml: `<p>Dear {{contact.name}},</p><p>To update your address on the register, please send a signed request letter stating your old and new addresses, together with a valid means of identification and a recent utility bill for the new address.</p>${SIGN_OFF}`,
  },
  {
    name: 'Transmission (probate) requirements',
    subject: 'Transmission of shares — documents required',
    bodyHtml: `<p>Dear {{contact.name}},</p><p>We are sorry for your loss. To transmit the shares of the deceased shareholder, please provide a certified true copy of the probate or letters of administration, the death certificate, and valid identification for each administrator or executor.</p><p>Once received, we will confirm the next steps.</p>${SIGN_OFF}`,
  },
  {
    name: 'Request for more information',
    subject: '',
    bodyHtml: `<p>Dear {{contact.name}},</p><p>Thank you for your message regarding "{{ticket.subject}}". To help us resolve this, please could you send the following:</p><ul><li></li></ul>${SIGN_OFF}`,
  },
];

await mongoose.connect(env.MONGODB_URI);

if ((await FolderModel.countDocuments()) === 0) {
  await FolderModel.insertMany(FOLDERS.map((name, i) => ({ name, order: i + 1 })));
  console.log(`Created ${FOLDERS.length} folders`);
} else {
  console.log('Folders already exist — skipped');
}

if ((await CategoryModel.countDocuments()) === 0) {
  await CategoryModel.insertMany(CATEGORIES);
  console.log(`Created ${CATEGORIES.length} categories`);
} else {
  console.log('Categories already exist — skipped');
}

if ((await TemplateModel.countDocuments()) === 0) {
  await TemplateModel.insertMany(TEMPLATES);
  console.log(`Created ${TEMPLATES.length} templates`);
} else {
  console.log('Templates already exist — skipped');
}

const folderId = async (name: string) => (await FolderModel.findOne({ name }).lean())?._id ?? null;
const categoryId = async (name: string) => (await CategoryModel.findOne({ name }).lean())?._id ?? null;

// Targets are in WORKING minutes (Mon–Fri 08:00–17:00 Lagos = 540 a day).
if ((await SlaPolicyModel.countDocuments()) === 0) {
  await SlaPolicyModel.insertMany([
    { name: 'Standard', firstResponseMins: 540, resolutionMins: 1620 },
    {
      name: 'Complaints',
      appliesTo: { folderId: await folderId('Complaints') },
      firstResponseMins: 240,
      resolutionMins: 1080,
    },
  ]);
  console.log('Created 2 SLA policies (Standard: reply in 1 working day, resolve in 3; Complaints: 4 hours / 2 days)');
} else {
  console.log('SLA policies already exist — skipped');
}

// Sample filing rules: subject keywords → folder + category. They never send mail or assign.
if ((await AssignmentRuleModel.countDocuments()) === 0) {
  const file = async (name: string, priority: number, keyword: string, folder: string, category: string | null) => ({
    name,
    priority,
    conditions: [{ field: 'subject', op: 'contains', value: keyword }],
    action: {
      setFolderId: await folderId(folder),
      addCategoryIds: category ? [await categoryId(category)].filter(Boolean) : [],
    },
  });
  const rules = await Promise.all([
    file('Complaints', 10, 'complaint', 'Complaints', 'Complaint'),
    file('Probate', 20, 'probate', 'Probate / Transmission', 'Probate'),
    file('Transmission', 21, 'transmission', 'Probate / Transmission', 'Probate'),
    file('Deceased shareholder', 22, 'deceased', 'Probate / Transmission', 'Probate'),
    file('E-mandate', 30, 'mandate', 'E-Mandate', 'E-Mandate'),
    file('Change of address', 40, 'change of address', 'KYC & Record Updates', 'KYC'),
    file('Change of name', 41, 'change of name', 'KYC & Record Updates', 'KYC'),
    file('KYC', 42, 'kyc', 'KYC & Record Updates', 'KYC'),
    file('Dividend', 50, 'dividend', 'Dividend', 'Dividend'),
    file('Share certificate', 60, 'certificate', 'Share Certificates', null),
  ]);
  await AssignmentRuleModel.insertMany(rules);
  console.log(`Created ${rules.length} sample filing rules`);
} else {
  console.log('Rules already exist — skipped');
}

const ack = await TemplateModel.findOne({ name: 'Acknowledgement' }).lean();
const settings = await SettingsModel.findById('app').lean();
if (!settings) {
  await SettingsModel.create({ _id: 'app', autoAcknowledge: { enabled: false, templateId: ack?._id ?? null } });
  console.log('Created settings (auto-acknowledgement: OFF, using the "Acknowledgement" template)');
} else if (!settings.autoAcknowledge?.templateId && ack) {
  // Created with defaults by the running app before seeding: just link the template (still OFF).
  await SettingsModel.updateOne({ _id: 'app' }, { $set: { 'autoAcknowledge.templateId': ack._id } });
  console.log('Linked the "Acknowledgement" template to auto-acknowledgement (still OFF)');
} else {
  console.log('Settings already exist — skipped');
}

// Departments are deliberately not seeded: their addresses are real inboxes that escalations go to.
const departments = await DepartmentModel.countDocuments();
const autoAckOn = Boolean((await SettingsModel.findById('app').lean())?.autoAcknowledge?.enabled);

console.log(`
Done. Still to do in the app (Admin, signed in as an admin):
  • Departments: ${departments ? `${departments} in the escalation directory` : 'add the teams and people officers escalate to (none yet)'}
  • Users: set roles once staff have signed in (first admin: BOOTSTRAP_ADMIN_EMAILS in .env)
  • Settings: auto-acknowledgement is ${autoAckOn ? 'ON' : 'OFF — switch it on when ready'}`);

await mongoose.disconnect();
