/**
 * Online English Language Assessment Portal - Core Server
 * Engineered for 200+ Concurrent Connections on Low-Tier Container Hosting
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Hardcoded / Env Teacher Credentials
const TEACHER_USER = process.env.TEACHER_USER || 'DREXWEB';
const TEACHER_PASS = process.env.TEACHER_PASS || 'DRDREX';
const TEACHER_TOKEN = Buffer.from(`${TEACHER_USER}:${TEACHER_PASS}`).toString('base64');

// Ensure backup directory exists
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_FILE = path.join(DATA_DIR, 'state-backup.json');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware Setup
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ============================================================================
// IN-MEMORY HIGH-CONCURRENCY STATE STORE
// ============================================================================

let examConfig = {
  title: 'English Language Proficiency & Comprehension Assessment',
  durationMinutes: 60,
  paperType: 'text', // 'text' | 'pdf'
  paperContent: `SECTION A: MULTIPLE CHOICE QUESTIONS (Questions 1 - 10)
Read the sentences carefully and choose the most appropriate option (A, B, C, or D) on your digital answer sheet.

1. Neither the teacher nor the students _______ present at the symposium yesterday.
   A) was    B) were    C) are    D) have been

2. Choose the word that is closest in meaning to "EPHEMERAL":
   A) Eternal    B) Short-lived    C) Fragile    D) Dramatic

3. Had she known about the traffic delay, she _______ an earlier train.
   A) will take    B) would take    C) would have taken    D) took

4. Identify the grammatically correct sentence:
   A) Each of the participants have received a certificate.
   B) One of my friend is studying abroad.
   C) Scarcely had the bell rung when the students left.
   D) He insisted to pay for the meal.

5. Select the antonym of "MAGNANIMOUS":
   A) Generous    B) Petty    C) Noble    D) Courageous

------------------------------------------------------------------------
SECTION B: FILL IN THE BLANKS & DESCRIPTIVE WRITING

Part 1: Fill in the Blanks (Questions 1 - 3)
Type the exact word(s) in the corresponding Section B blanks on the right panel.
Blank 1: She has been living in this city _______ 2018. (since / for)
Blank 2: The committee _______ divided in their opinions regarding the new policy. (was / were)
Blank 3: Hardly had I reached the station _______ the train departed. (when / than)

Part 2: Essay / Descriptive Writing
Write an analytical essay of 200-250 words on the following topic:
"The Impact of Artificial Intelligence on Modern Communication and Critical Thinking."

------------------------------------------------------------------------
SECTION C: LISTENING COMPREHENSION
Listen to the attached audio track (maximum 2 plays allowed) and summarize the speaker's primary argument and two supporting examples in the Section C response box.`,
  pdfUrl: '',
  audioUrl: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
  mcqCount: 5,
  answerKey: {
    '1': 'B',
    '2': 'B',
    '3': 'C',
    '4': 'C',
    '5': 'B'
  },
  markingScheme: 'standard', // 'standard' | 'negative'
  negativeMark: -0.25,
  fillInBlanksCount: 3,
  fillInKeys: {
    '1': 'since',
    '2': 'were',
    '3': 'when'
  },
  essayEnabled: true,
  essayMaxMarks: 10,
  listeningEnabled: true,
  googleScriptUrl: process.env.GAS_WEBHOOK_URL || '',
  updatedAt: new Date().toISOString()
};

// Map<admissionNo, StudentSession>
const students = new Map();

// Pending Google Sheets Sync Queue
let syncQueue = [];
let syncStats = {
  totalSynced: 0,
  failedAttempts: 0,
  lastSyncTime: null,
  lastSyncError: null,
  isSyncing: false
};

// ============================================================================
// CRASH RECOVERY SNAPSHOT LOAD & PERIODIC PERSISTENCE
// ============================================================================
function loadBackupState() {
  try {
    if (fs.existsSync(BACKUP_FILE)) {
      const raw = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.examConfig) examConfig = { ...examConfig, ...parsed.examConfig };
      if (Array.isArray(parsed.students)) {
        parsed.students.forEach(([k, v]) => students.set(k, v));
      }
      if (Array.isArray(parsed.syncQueue)) {
        syncQueue = parsed.syncQueue;
      }
      console.log(`[INIT] Restored ${students.size} student sessions and ${syncQueue.length} queued sync items.`);
    }
  } catch (err) {
    console.error('[INIT] Failed to load state backup:', err.message);
  }
}

function saveBackupState() {
  try {
    const payload = JSON.stringify({
      examConfig,
      students: Array.from(students.entries()),
      syncQueue
    });
    fs.writeFile(BACKUP_FILE, payload, (err) => {
      if (err) console.error('[BACKUP] Write error:', err.message);
    });
  } catch (err) {
    console.error('[BACKUP] Serialization error:', err.message);
  }
}

loadBackupState();
setInterval(saveBackupState, 15000);

// ============================================================================
// HELPERS: AUTHENTICATION, PARSING & AUTO-GRADING
// ============================================================================

function requireTeacherAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (token !== TEACHER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Teacher Credentials' });
  }
  next();
}

/**
 * Rapid Bulk MCQ Parser
 * Supports formats like:
 * "1:A, 2:C, 3:D" OR "1-A\n2-C\n3-D" OR "1.A 2.B 3.C" OR plain "ABCD..."
 */
function parseBulkMcqKey(rawString, maxLimit = 300) {
  const keyMap = {};
  if (!rawString || typeof rawString !== 'string') return keyMap;

  const cleaned = rawString.trim().toUpperCase();

  // Pattern 1: Explicit number-to-option pairs (e.g., 1:A, 2-B, 3.C, 4=D, 5 A)
  const pairRegex = /(\d{1,3})\s*[:\-.,=\s]\s*([A-D])/g;
  let match;
  let foundPairs = 0;

  while ((match = pairRegex.exec(cleaned)) !== null) {
    const qNum = parseInt(match[1], 10);
    const opt = match[2];
    if (qNum >= 1 && qNum <= maxLimit) {
      keyMap[String(qNum)] = opt;
      foundPairs++;
    }
  }

  // Pattern 2: If user pasted a continuous string of letters like "ABCDABCD"
  if (foundPairs === 0 && /^[A-D\s,]+$/.test(cleaned)) {
    const letters = cleaned.replace(/[^A-D]/g, '');
    for (let i = 0; i < Math.min(letters.length, maxLimit); i++) {
      keyMap[String(i + 1)] = letters[i];
    }
  }

  return keyMap;
}

/**
 * Auto-Grading Engine
 * Computes MCQ score (standard or negative marking) and exact case-insensitive Fill-in-Blanks
 */
function evaluateSubmission(studentAnswers) {
  const mcqSubmitted = (studentAnswers && studentAnswers.mcq) || {};
  const blanksSubmitted = (studentAnswers && studentAnswers.blanks) || {};

  let mcqCorrect = 0;
  let mcqWrong = 0;
  let mcqUnattempted = 0;
  let mcqScore = 0;

  const totalMcqs = Number(examConfig.mcqCount) || 0;
  const isNegative = examConfig.markingScheme === 'negative';
  const negPenalty = isNegative ? Number(examConfig.negativeMark || -0.25) : 0;

  for (let i = 1; i <= totalMcqs; i++) {
    const qKey = String(i);
    const correctOpt = examConfig.answerKey[qKey];
    const studentOpt = mcqSubmitted[qKey];

    if (!studentOpt || studentOpt === '') {
      mcqUnattempted++;
    } else if (correctOpt && studentOpt.toUpperCase() === correctOpt.toUpperCase()) {
      mcqCorrect++;
      mcqScore += 1;
    } else {
      mcqWrong++;
      if (isNegative) {
        mcqScore += negPenalty; // negPenalty is negative (e.g. -0.25)
      }
    }
  }

  // Round floating point to 2 decimal places
  mcqScore = Math.round(mcqScore * 100) / 100;

  // Grade Fill-in-the-Blanks (if teacher provided keys)
  let blanksCorrect = 0;
  let blanksTotal = Number(examConfig.fillInBlanksCount) || 0;
  for (let i = 1; i <= blanksTotal; i++) {
    const bKey = String(i);
    const expected = (examConfig.fillInKeys && examConfig.fillInKeys[bKey] || '').trim().toLowerCase();
    const actual = (blanksSubmitted[bKey] || '').trim().toLowerCase();
    if (expected && actual && expected === actual) {
      blanksCorrect++;
    }
  }

  const totalAutoScore = Math.round((mcqScore + blanksCorrect) * 100) / 100;
  const maxAutoScore = totalMcqs + blanksTotal;

  return {
    mcqCorrect,
    mcqWrong,
    mcqUnattempted,
    mcqScore,
    totalMcqs,
    blanksCorrect,
    blanksTotal,
    totalAutoScore,
    maxAutoScore
  };
}

// ============================================================================
// STUDENT API ENDPOINTS
// ============================================================================

const ALLOWED_GRADES = ['Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 11'];

// 1. Student Login & Duplicate Session Guard
app.post('/api/student/login', (req, res) => {
  const { fullName, admissionNo, grade, sessionToken } = req.body;

  if (!fullName || !admissionNo || !grade) {
    return res.status(400).json({ error: 'Full Name, Admission Number, and Grade are required.' });
  }

  if (!ALLOWED_GRADES.includes(grade)) {
    return res.status(400).json({ error: 'Invalid Grade selected. Allowed: Grade 6, 7, 8, 9, 11.' });
  }

  const cleanAdm = String(admissionNo).trim().toUpperCase();
  const cleanName = String(fullName).trim();
  const now = Date.now();

  const existing = students.get(cleanAdm);

  if (existing) {
    if (existing.status === 'SUBMITTED') {
      return res.status(403).json({
        error: 'This Admission Number has already submitted the examination.',
        alreadySubmitted: true,
        scoreSummary: existing.scoreSummary
      });
    }

    // Active session collision check:
    // If another device has sent a heartbeat within the last 35 seconds with a different sessionToken, block login.
    const isRecentlyActive = (now - existing.lastSeen) < 35000;
    if (isRecentlyActive && existing.sessionToken !== sessionToken) {
      return res.status(409).json({
        error: `Duplicate Login Blocked: Admission Number ${cleanAdm} is already logged in on an active session. Ask your teacher to reset your session if your browser crashed.`
      });
    }

    // Allow reconnect (same token or stale session > 35s)
    existing.sessionToken = sessionToken || existing.sessionToken;
    existing.lastSeen = now;
    return res.json({
      student: {
        admissionNo: existing.admissionNo,
        fullName: existing.fullName,
        grade: existing.grade,
        status: existing.status,
        violations: existing.violations,
        audioPlaysUsed: existing.audioPlaysUsed,
        answers: existing.answers,
        warnings: existing.warnings,
        startedAt: existing.startedAt
      }
    });
  }

  // Create fresh student session
  const newToken = sessionToken || `${cleanAdm}-${now}-${Math.random().toString(36).substring(2, 8)}`;
  const newSession = {
    admissionNo: cleanAdm,
    fullName: cleanName,
    grade,
    sessionToken: newToken,
    status: 'ACTIVE', // 'ACTIVE' | 'LOCKED' | 'SUBMITTED'
    violations: 0,
    lastViolationReason: null,
    lastViolationTime: null,
    audioPlaysUsed: 0,
    answers: {
      mcq: {},
      blanks: {},
      essay: '',
      listeningResponse: ''
    },
    warnings: [], // Array of { id, message, timestamp, read }
    scoreSummary: null,
    startedAt: new Date(now).toISOString(),
    lastSeen: now,
    submittedAt: null,
    syncedToSheet: false
  };

  students.set(cleanAdm, newSession);

  return res.json({
    student: {
      admissionNo: newSession.admissionNo,
      fullName: newSession.fullName,
      grade: newSession.grade,
      sessionToken: newSession.sessionToken,
      status: newSession.status,
      violations: newSession.violations,
      audioPlaysUsed: newSession.audioPlaysUsed,
      answers: newSession.answers,
      warnings: newSession.warnings,
      startedAt: newSession.startedAt
    }
  });
});

// 2. Fetch Student Safe Exam Configuration (Conceals Master Answer Keys)
app.get('/api/student/config', (req, res) => {
  res.json({
    title: examConfig.title,
    durationMinutes: examConfig.durationMinutes,
    paperType: examConfig.paperType,
    paperContent: examConfig.paperContent,
    pdfUrl: examConfig.pdfUrl,
    audioUrl: examConfig.audioUrl,
    mcqCount: examConfig.mcqCount,
    markingScheme: examConfig.markingScheme,
    negativeMark: examConfig.negativeMark,
    fillInBlanksCount: examConfig.fillInBlanksCount,
    essayEnabled: examConfig.essayEnabled,
    essayMaxMarks: examConfig.essayMaxMarks,
    listeningEnabled: examConfig.listeningEnabled,
    updatedAt: examConfig.updatedAt
  });
});

// 3. Lightweight Student Heartbeat & Answer Buffer Sync
app.post('/api/student/heartbeat', (req, res) => {
  const { admissionNo, sessionToken, answers } = req.body;
  if (!admissionNo) return res.status(400).json({ error: 'Missing admissionNo' });

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Session not found. Please log in again.' });

  if (student.sessionToken && sessionToken && student.sessionToken !== sessionToken) {
    return res.status(409).json({ error: 'Session superseded by another login.' });
  }

  student.lastSeen = Date.now();

  // Only update buffered answers if student is ACTIVE
  if (student.status === 'ACTIVE' && answers && typeof answers === 'object') {
    if (answers.mcq) student.answers.mcq = answers.mcq;
    if (answers.blanks) student.answers.blanks = answers.blanks;
    if (typeof answers.essay === 'string') student.answers.essay = answers.essay;
    if (typeof answers.listeningResponse === 'string') {
      student.answers.listeningResponse = answers.listeningResponse;
    }
  }

  // Deliver unread warnings
  const unreadWarnings = student.warnings.filter(w => !w.read);
  unreadWarnings.forEach(w => { w.read = true; });

  return res.json({
    status: student.status,
    violations: student.violations,
    audioPlaysUsed: student.audioPlaysUsed,
    newWarnings: unreadWarnings
  });
});

// 4. Proctoring Violation & Immediate Automatic Lockdown
app.post('/api/student/lock', (req, res) => {
  const { admissionNo, reason } = req.body;
  if (!admissionNo) return res.status(400).json({ error: 'Missing admissionNo' });

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Student session not found' });

  if (student.status !== 'SUBMITTED') {
    student.status = 'LOCKED';
    student.violations += 1;
    student.lastViolationReason = reason || 'Tab/Window Switch Detected';
    student.lastViolationTime = new Date().toISOString();
    student.lastSeen = Date.now();
  }

  return res.json({
    status: student.status,
    violations: student.violations,
    lastViolationReason: student.lastViolationReason
  });
});

// 5. Server-Enforced Listening Audio Play Tracker (Hard Cap: 2 Plays)
app.post('/api/student/audio-play', (req, res) => {
  const { admissionNo } = req.body;
  if (!admissionNo) return res.status(400).json({ error: 'Missing admissionNo' });

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (student.status === 'LOCKED') {
    return res.status(403).json({ error: 'Exam is currently locked by proctor.' });
  }

  if (student.audioPlaysUsed >= 2) {
    return res.status(403).json({
      allowed: false,
      audioPlaysUsed: student.audioPlaysUsed,
      playsRemaining: 0,
      error: 'Maximum of 2 audio plays reached.'
    });
  }

  student.audioPlaysUsed += 1;
  student.lastSeen = Date.now();

  return res.json({
    allowed: true,
    audioPlaysUsed: student.audioPlaysUsed,
    playsRemaining: Math.max(0, 2 - student.audioPlaysUsed)
  });
});

// 6. Final Exam Submission, Instant Auto-Grading & Async Sheet Queueing
app.post('/api/student/submit', (req, res) => {
  const { admissionNo, answers } = req.body;
  if (!admissionNo) return res.status(400).json({ error: 'Missing admissionNo' });

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Student session not found' });

  if (student.status === 'LOCKED') {
    return res.status(403).json({
      error: 'Cannot submit while exam is suspended. Please wait for the teacher to unlock your screen.'
    });
  }

  if (student.status === 'SUBMITTED') {
    return res.json({
      alreadySubmitted: true,
      scoreSummary: student.scoreSummary
    });
  }

  if (answers && typeof answers === 'object') {
    student.answers = {
      mcq: answers.mcq || student.answers.mcq || {},
      blanks: answers.blanks || student.answers.blanks || {},
      essay: typeof answers.essay === 'string' ? answers.essay : student.answers.essay,
      listeningResponse: typeof answers.listeningResponse === 'string'
        ? answers.listeningResponse
        : student.answers.listeningResponse
    };
  }

  const scoreSummary = evaluateSubmission(student.answers);
  student.scoreSummary = scoreSummary;
  student.status = 'SUBMITTED';
  student.submittedAt = new Date().toISOString();
  student.lastSeen = Date.now();

  // Enqueue for non-blocking Google Sheets batch sync
  enqueueForSheetSync(student);

  return res.json({
    success: true,
    submittedAt: student.submittedAt,
    scoreSummary
  });
});

// ============================================================================
// TEACHER ADMIN CONSOLE API ENDPOINTS
// ============================================================================

app.post('/api/teacher/login', (req, res) => {
  const { userId, password } = req.body;
  if (userId === TEACHER_USER && password === TEACHER_PASS) {
    return res.json({ token: TEACHER_TOKEN, userId: TEACHER_USER });
  }
  return res.status(401).json({ error: 'Invalid Teacher User ID or Password.' });
});

app.get('/api/teacher/dashboard', requireTeacherAuth, (req, res) => {
  const now = Date.now();
  const studentList = Array.from(students.values()).map(s => ({
    admissionNo: s.admissionNo,
    fullName: s.fullName,
    grade: s.grade,
    status: s.status,
    isOnline: (now - s.lastSeen) < 25000 && s.status !== 'SUBMITTED',
    violations: s.violations,
    lastViolationReason: s.lastViolationReason,
    lastViolationTime: s.lastViolationTime,
    audioPlaysUsed: s.audioPlaysUsed,
    answeredMcqCount: Object.keys(s.answers?.mcq || {}).filter(k => s.answers.mcq[k]).length,
    scoreSummary: s.scoreSummary,
    startedAt: s.startedAt,
    submittedAt: s.submittedAt,
    syncedToSheet: s.syncedToSheet,
    answers: s.answers
  }));

  res.json({
    examConfig,
    students: studentList,
    syncStats: {
      ...syncStats,
      pendingQueueCount: syncQueue.length
    }
  });
});

app.post('/api/teacher/config', requireTeacherAuth, (req, res) => {
  const {
    title,
    durationMinutes,
    paperType,
    paperContent,
    pdfUrl,
    audioUrl,
    mcqCount,
    bulkKeyRaw,
    markingScheme,
    negativeMark,
    fillInBlanksCount,
    fillInKeysRaw,
    essayEnabled,
    essayMaxMarks,
    listeningEnabled,
    googleScriptUrl
  } = req.body;

  if (title !== undefined) examConfig.title = String(title).trim();
  if (durationMinutes !== undefined) examConfig.durationMinutes = Math.max(1, Number(durationMinutes));
  if (paperType !== undefined) examConfig.paperType = paperType;
  if (paperContent !== undefined) examConfig.paperContent = paperContent;
  if (pdfUrl !== undefined) examConfig.pdfUrl = String(pdfUrl).trim();
  if (audioUrl !== undefined) examConfig.audioUrl = String(audioUrl).trim();
  if (mcqCount !== undefined) examConfig.mcqCount = Math.min(300, Math.max(0, Number(mcqCount)));
  if (markingScheme !== undefined) examConfig.markingScheme = markingScheme;
  if (negativeMark !== undefined) {
    const val = Number(negativeMark);
    examConfig.negativeMark = val > 0 ? -val : val;
  }
  if (fillInBlanksCount !== undefined) {
    examConfig.fillInBlanksCount = Math.min(50, Math.max(0, Number(fillInBlanksCount)));
  }
  if (essayEnabled !== undefined) examConfig.essayEnabled = Boolean(essayEnabled);
  if (essayMaxMarks !== undefined) examConfig.essayMaxMarks = Number(essayMaxMarks);
  if (listeningEnabled !== undefined) examConfig.listeningEnabled = Boolean(listeningEnabled);
  if (googleScriptUrl !== undefined) examConfig.googleScriptUrl = String(googleScriptUrl).trim();

  if (typeof bulkKeyRaw === 'string' && bulkKeyRaw.trim().length > 0) {
    examConfig.answerKey = parseBulkMcqKey(bulkKeyRaw, 300);
  }

  if (typeof fillInKeysRaw === 'string') {
    const parsedBlanks = {};
    fillInKeysRaw.split(/\r?\n|,/).forEach(line => {
      const idx = line.indexOf(':');
      if (idx > -1) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && v) parsedBlanks[k] = v;
      }
    });
    if (Object.keys(parsedBlanks).length > 0) {
      examConfig.fillInKeys = parsedBlanks;
    }
  }

  examConfig.updatedAt = new Date().toISOString();
  saveBackupState();

  return res.json({
    success: true,
    parsedMcqKeysCount: Object.keys(examConfig.answerKey).length,
    examConfig
  });
});

// Unlock a suspended student
app.post('/api/teacher/unlock', requireTeacherAuth, (req, res) => {
  const { admissionNo } = req.body;
  if (admissionNo === 'ALL') {
    let count = 0;
    students.forEach(s => {
      if (s.status === 'LOCKED') {
        s.status = 'ACTIVE';
        count++;
      }
    });
    return res.json({ success: true, unlockedCount: count });
  }

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (student.status === 'LOCKED') {
    student.status = 'ACTIVE';
  }
  student.warnings.push({
    id: Date.now().toString(),
    message: 'Proctor Notice: Your exam screen has been unlocked. Avoid switching tabs again.',
    timestamp: new Date().toISOString(),
    read: false
  });

  return res.json({ success: true, status: student.status });
});

// Reset a student's active session lock or clear their attempt
app.post('/api/teacher/reset-session', requireTeacherAuth, (req, res) => {
  const { admissionNo, fullReset } = req.body;
  const key = String(admissionNo).toUpperCase();
  const student = students.get(key);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (fullReset) {
    students.delete(key);
    return res.json({ success: true, message: `Deleted session for ${key}` });
  } else {
    // Allow immediate re-login from a new browser tab
    student.lastSeen = 0;
    student.sessionToken = null;
    if (student.status === 'LOCKED') student.status = 'ACTIVE';
    return res.json({ success: true, message: `Cleared active device lock for ${key}` });
  }
});

// Push Live Warning Banner/Toast to Student(s)
app.post('/api/teacher/warn', requireTeacherAuth, (req, res) => {
  const { admissionNo, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Warning message is required.' });

  const warningObj = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    message: String(message).trim(),
    timestamp: new Date().toISOString(),
    read: false
  };

  if (admissionNo === 'ALL') {
    students.forEach(s => {
      if (s.status !== 'SUBMITTED') {
        s.warnings.push({ ...warningObj });
      }
    });
    return res.json({ success: true, broadcast: true });
  }

  const student = students.get(String(admissionNo).toUpperCase());
  if (!student) return res.status(404).json({ error: 'Student not found' });

  student.warnings.push(warningObj);
  return res.json({ success: true });
});

// Trigger Immediate Manual Sync + Re-queue Unsynced Submissions
app.post('/api/teacher/sync-now', requireTeacherAuth, async (req, res) => {
  const { forceAllSubmitted } = req.body || {};

  if (forceAllSubmitted) {
    students.forEach(s => {
      if (s.status === 'SUBMITTED') {
        s.syncedToSheet = false;
        enqueueForSheetSync(s);
      }
    });
  } else {
    students.forEach(s => {
      if (s.status === 'SUBMITTED' && !s.syncedToSheet) {
        enqueueForSheetSync(s);
      }
    });
  }

  await processSheetSyncQueue();
  return res.json({
    success: true,
    syncStats: {
      ...syncStats,
      pendingQueueCount: syncQueue.length
    }
  });
});

// ============================================================================
// ASYNCHRONOUS BATCH GOOGLE SHEETS SYNC WORKER
// ============================================================================

function enqueueForSheetSync(student) {
  // Prevent duplicate entries in queue for the same admissionNo
  const exists = syncQueue.some(item => item.admissionNo === student.admissionNo);
  if (exists) return;

  syncQueue.push({
    admissionNo: student.admissionNo,
    fullName: student.fullName,
    grade: student.grade,
    mcqScore: student.scoreSummary?.mcqScore ?? 0,
    mcqCorrect: student.scoreSummary?.mcqCorrect ?? 0,
    mcqWrong: student.scoreSummary?.mcqWrong ?? 0,
    mcqUnattempted: student.scoreSummary?.mcqUnattempted ?? 0,
    blanksScore: student.scoreSummary?.blanksCorrect ?? 0,
    totalAutoScore: student.scoreSummary?.totalAutoScore ?? 0,
    maxAutoScore: student.scoreSummary?.maxAutoScore ?? 0,
    violations: student.violations,
    audioPlaysUsed: student.audioPlaysUsed,
    blanksJson: JSON.stringify(student.answers?.blanks || {}),
    essay: student.answers?.essay || '',
    listeningResponse: student.answers?.listeningResponse || '',
    mcqResponsesJson: JSON.stringify(student.answers?.mcq || {}),
    submittedAt: student.submittedAt || new Date().toISOString()
  });
}

async function processSheetSyncQueue() {
  if (syncStats.isSyncing || syncQueue.length === 0) return;
  if (!examConfig.googleScriptUrl) {
    syncStats.lastSyncError = 'Google Apps Script Web App URL not configured.';
    return;
  }

  syncStats.isSyncing = true;
  const batch = syncQueue.slice(0, 25); // Process up to 25 submissions per HTTP call

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(examConfig.googleScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        examTitle: examConfig.title,
        records: batch
      }),
      redirect: 'follow',
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Remove synced batch from queue
    syncQueue.splice(0, batch.length);
    batch.forEach(item => {
      const st = students.get(item.admissionNo);
      if (st) st.syncedToSheet = true;
    });

    syncStats.totalSynced += batch.length;
    syncStats.lastSyncTime = new Date().toISOString();
    syncStats.lastSyncError = null;
    saveBackupState();
  } catch (err) {
    syncStats.failedAttempts += 1;
    syncStats.lastSyncError = err.message;
    console.error('[SHEET-SYNC] Batch sync failed:', err.message);
  } finally {
    syncStats.isSyncing = false;
  }
}

// Run background batch sync worker every 8 seconds
setInterval(processSheetSyncQueue, 8000);

// Healthcheck endpoint for Render / Koyeb / Railway / Docker
app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    activeStudents: students.size,
    queuedSyncs: syncQueue.length,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
  });
});

app.listen(PORT, () => {
  console.log(`================================================================`);
  console.log(` Online English Assessment Portal Running on Port ${PORT}`);
  console.log(` Student Portal  : http://localhost:${PORT}/`);
  console.log(` Teacher Console : http://localhost:${PORT}/teacher.html`);
  console.log(`================================================================`);
});