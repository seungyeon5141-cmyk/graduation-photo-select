// Single Vercel function for every /api/* route. vercel.json rewrites /api/<path> to
// /api/index?__path=/api/<path>; the original path is restored before routing.
//
// Roles
//   student : one login per class group (반+조). Picks one photo of its own class.
//   teacher : registers with TEACHER_SIGNUP_CODE. Picks the whole-class photo (any folder, enters the class),
//             sees and downloads its own class's group picks.
//   admin   : final admin (ADMIN_PASSWORD). Sees every class, every teacher's pick and the full history.
import {
  clearCookie, clearFailures, hashPassword, pwTag, readSession, recordFailure,
  safeEqual, sessionCookie, tooManyAttempts, verifyPassword,
} from '../lib/auth.js';
import { getGroup, getSetting, getTeacher, hasDatabase, log, query, setSetting } from '../lib/db.js';
import { classPhotoName, deliveryName, driveConfigured, fetchOriginal, fetchThumbnail, loadPhotos } from '../lib/drive.js';

const CLASS_COUNT = () => Number(process.env.CLASS_COUNT) || 5;
const GROUP_COUNT = () => Number(process.env.GROUP_COUNT) || 8;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const fail = (message, status = 400) => json({ error: message }, status);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function intIn(value, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

// Student session is valid only while the group's password is unchanged.
async function student(request) {
  const s = readSession(request);
  if (!s || s.role !== 'student') throw new HttpError(401, '로그인이 필요해요.');
  const group = await getGroup(s.classNo, s.groupNo);
  if (!group || pwTag(group.pw_hash) !== s.pw) throw new HttpError(401, '다시 로그인해 주세요.');
  return s;
}

// Teacher or final admin. Returns { role, teacherId?, name, classNo? }.
async function staff(request, { adminOnly = false } = {}) {
  const s = readSession(request);
  if (s?.role === 'admin') return { role: 'admin', name: '최종관리자' };
  if (!adminOnly && s?.role === 'teacher') {
    const t = await getTeacher(s.teacherId);
    if (t && pwTag(t.pw_hash) === s.pw) return { role: 'teacher', teacherId: t.id, name: t.name, classNo: t.class_no };
    throw new HttpError(401, '다시 로그인해 주세요.');
  }
  throw new HttpError(401, adminOnly ? '최종관리자만 할 수 있어요.' : '교사 로그인이 필요해요.');
}

function ownClass(who, classNo) {
  if (who.role === 'teacher' && who.classNo !== classNo) throw new HttpError(403, '담당 반만 관리할 수 있어요.');
}

// Rejects cross-site form posts: state-changing requests must come from this site.
function sameOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, '허용되지 않은 요청이에요.');
}

async function selectionFor(classNo, groupNo) {
  const rows = await query(
    'SELECT file_id, file_name, selected_at FROM photo_selections WHERE class_no = $1 AND group_no = $2',
    [classNo, groupNo],
  );
  return rows[0] ? { fileId: rows[0].file_id, fileName: rows[0].file_name, selectedAt: rows[0].selected_at } : null;
}

const isLocked = async () => (await getSetting('locked', '0')) === '1';

function attachment(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const driveUrl = (id) => `https://drive.google.com/file/d/${id}/view`;
const groupActor = (classNo, groupNo) => `${classNo}반 ${groupNo}조`;
const teacherActor = (who) => (who.role === 'admin' ? '최종관리자' : `${who.name} 선생님(${who.classNo}반)`);

async function streamOriginal(fileId, name) {
  const res = await fetchOriginal(fileId);
  if (!res.ok) return fail('원본 사진을 내려받지 못했어요. 드라이브 링크로 직접 받아 주세요.', 502);
  const headers = {
    'content-type': res.headers.get('content-type') || 'application/octet-stream',
    'content-disposition': attachment(name),
    'cache-control': 'no-store',
  };
  if (res.headers.get('content-length')) headers['content-length'] = res.headers.get('content-length');
  return new Response(res.body, { headers });
}

const routes = {
  'GET /api/health': async () => {
    const out = {
      database: hasDatabase() ? 'configured' : 'missing DATABASE_URL',
      drive: driveConfigured() ? 'configured' : 'missing GOOGLE_API_KEY',
      admin: process.env.ADMIN_PASSWORD ? 'configured' : 'missing ADMIN_PASSWORD',
      teacherSignup: process.env.TEACHER_SIGNUP_CODE ? 'configured' : 'missing TEACHER_SIGNUP_CODE',
      session: (process.env.SESSION_SECRET || '').length >= 16 ? 'configured' : 'missing SESSION_SECRET',
    };
    if (hasDatabase()) {
      try { await query('SELECT 1'); out.database = 'ok'; } catch (e) { out.database = 'error: ' + String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, '[url]'); }
    }
    if (driveConfigured()) {
      try {
        const { classes } = await loadPhotos();
        out.drive = Object.fromEntries([...classes].map(([c, list]) => [c ? `${c}반` : '기타', `${list.length}장`]));
      } catch (e) { out.drive = 'error: ' + e.message; }
    }
    return json(out);
  },

  'GET /api/config': async () => json({ classCount: CLASS_COUNT(), groupCount: GROUP_COUNT() }),

  'GET /api/me': async (request) => {
    const s = readSession(request);
    if (!s) return json({ role: null });
    try {
      if (s.role === 'student') {
        await student(request);
        return json({ role: 'student', classNo: s.classNo, groupNo: s.groupNo });
      }
      const who = await staff(request);
      return json({ role: who.role, name: who.name, classNo: who.classNo || null });
    } catch {
      return json({ role: null });
    }
  },

  // ---------- students ----------

  // First login for a group sets its password; later logins must match it.
  'POST /api/login': async (request) => {
    const b = await body(request);
    const classNo = intIn(b.classNo, CLASS_COUNT());
    const groupNo = intIn(b.groupNo, GROUP_COUNT());
    const password = String(b.password || '');
    if (!classNo || !groupNo) return fail('반과 조를 다시 확인해 주세요.');
    if (password.length < 4 || password.length > 40) return fail('비밀번호는 4자 이상 40자 이하로 입력해 주세요.');
    const key = `s:${classNo}:${groupNo}`;
    if (tooManyAttempts(key)) return fail('비밀번호를 여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.', 429);

    let group = await getGroup(classNo, groupNo);
    let created = false;
    if (!group) {
      const rows = await query(
        'INSERT INTO photo_groups (class_no, group_no, pw_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING pw_hash',
        [classNo, groupNo, hashPassword(password)],
      );
      created = rows.length > 0;
      group = created ? rows[0] : await getGroup(classNo, groupNo);
    }
    if (!created && !verifyPassword(password, group.pw_hash)) {
      recordFailure(key);
      return fail('비밀번호가 맞지 않아요. 모둠원에게 확인하거나 선생님께 초기화를 요청하세요.', 401);
    }
    clearFailures(key);
    return json({ ok: true, created, classNo, groupNo }, 200, {
      'set-cookie': sessionCookie({ role: 'student', classNo, groupNo, pw: pwTag(group.pw_hash) }),
    });
  },

  'POST /api/logout': async () => json({ ok: true }, 200, { 'set-cookie': clearCookie() }),

  'GET /api/photos': async (request) => {
    const s = await student(request);
    const { classes } = await loadPhotos();
    const photos = (classes.get(s.classNo) || []).map(({ id, name, width, height }) => ({ id, name, width, height }));
    return json({
      classNo: s.classNo,
      groupNo: s.groupNo,
      photos,
      selection: await selectionFor(s.classNo, s.groupNo),
      deliveryName: deliveryName(s.classNo, s.groupNo),
      locked: await isLocked(),
    });
  },

  // Upsert on the (class, group) key: choosing again replaces the previous photo, so a group never holds two.
  'POST /api/select': async (request) => {
    const s = await student(request);
    if (await isLocked()) return fail('선생님이 셀렉을 마감했어요.', 423);
    const { fileId } = await body(request);
    const { byId } = await loadPhotos();
    const photo = byId.get(String(fileId || ''));
    if (!photo || photo.classNo !== s.classNo) return fail('우리 반 사진만 고를 수 있어요.', 403);
    await query(
      `INSERT INTO photo_selections (class_no, group_no, file_id, file_name, selected_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (class_no, group_no) DO UPDATE SET file_id = EXCLUDED.file_id, file_name = EXCLUDED.file_name, selected_at = now()`,
      [s.classNo, s.groupNo, photo.id, photo.name],
    );
    await log(groupActor(s.classNo, s.groupNo), '모둠 사진 셀렉', { classNo: s.classNo, groupNo: s.groupNo, fileId: photo.id, fileName: photo.name });
    return json({ ok: true, selection: await selectionFor(s.classNo, s.groupNo) });
  },

  'DELETE /api/select': async (request) => {
    const s = await student(request);
    if (await isLocked()) return fail('선생님이 셀렉을 마감했어요.', 423);
    await query('DELETE FROM photo_selections WHERE class_no = $1 AND group_no = $2', [s.classNo, s.groupNo]);
    await log(groupActor(s.classNo, s.groupNo), '모둠 사진 셀렉 취소', { classNo: s.classNo, groupNo: s.groupNo });
    return json({ ok: true });
  },

  // ---------- teachers & final admin ----------

  'POST /api/teacher/signup': async (request) => {
    const code = process.env.TEACHER_SIGNUP_CODE;
    if (!code) return fail('TEACHER_SIGNUP_CODE 환경 변수를 먼저 설정해 주세요.', 503);
    if (tooManyAttempts('signup')) return fail('여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.', 429);
    const b = await body(request);
    const name = String(b.name || '').trim();
    const classNo = intIn(b.classNo, CLASS_COUNT());
    const password = String(b.password || '');
    if (!safeEqual(String(b.code || ''), code)) {
      recordFailure('signup');
      return fail('교사 가입 코드가 맞지 않아요.', 401);
    }
    if (!name || name.length > 20) return fail('이름을 20자 이내로 입력해 주세요.');
    if (!classNo) return fail('담당 반을 골라 주세요.');
    if (password.length < 4 || password.length > 40) return fail('비밀번호는 4자 이상 40자 이하로 입력해 주세요.');
    const rows = await query(
      'INSERT INTO photo_teachers (name, class_no, pw_hash) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING RETURNING id, pw_hash',
      [name, classNo, hashPassword(password)],
    );
    if (!rows.length) return fail('같은 이름의 교사가 이미 있어요. 이름 뒤에 반을 붙여 주세요 (예: 홍길동3).', 409);
    await log(`${name} 선생님(${classNo}반)`, '교사 등록', { classNo });
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie({ role: 'teacher', teacherId: rows[0].id, pw: pwTag(rows[0].pw_hash) }) });
  },

  'POST /api/teacher/login': async (request) => {
    const b = await body(request);
    const name = String(b.name || '').trim();
    const key = `t:${name}`;
    if (tooManyAttempts(key)) return fail('여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.', 429);
    const rows = await query('SELECT id, pw_hash FROM photo_teachers WHERE name = $1', [name]);
    if (!rows[0] || !verifyPassword(String(b.password || ''), rows[0].pw_hash)) {
      recordFailure(key);
      return fail('이름 또는 비밀번호가 맞지 않아요.', 401);
    }
    clearFailures(key);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie({ role: 'teacher', teacherId: rows[0].id, pw: pwTag(rows[0].pw_hash) }) });
  },

  'POST /api/admin/login': async (request) => {
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return fail('ADMIN_PASSWORD 환경 변수를 먼저 설정해 주세요.', 503);
    if (tooManyAttempts('admin')) return fail('여러 번 틀렸어요. 5분 뒤에 다시 해 주세요.', 429);
    const { password } = await body(request);
    if (!safeEqual(String(password || ''), expected)) {
      recordFailure('admin');
      return fail('최종관리자 비밀번호가 맞지 않아요.', 401);
    }
    clearFailures('admin');
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie({ role: 'admin' }) });
  },

  // Every photo in the Drive folder, by folder, for choosing whole-class photos.
  'GET /api/staff/photos': async (request) => {
    await staff(request);
    const force = new URL(request.url).searchParams.get('refresh') === '1';
    const { classes } = await loadPhotos({ force });
    const folders = [...classes.keys()].sort((a, b) => (a || 99) - (b || 99)).map((c) => ({
      classNo: c,
      label: c ? `${c}반 폴더` : '기타 폴더',
      photos: classes.get(c).map(({ id, name }) => ({ id, name })),
    }));
    const picks = (await query('SELECT class_no, file_id, teacher_name FROM photo_class_picks ORDER BY class_no'))
      .map((r) => ({ classNo: r.class_no, fileId: r.file_id, teacherName: r.teacher_name }));
    return json({ folders, picks, classCount: CLASS_COUNT() });
  },

  // Teacher picks a whole-class photo and says which class it is. One per class; picking again replaces it.
  'POST /api/staff/class-photo': async (request) => {
    const who = await staff(request);
    if (who.role === 'teacher' && await isLocked()) return fail('최종관리자가 셀렉을 마감했어요.', 423);
    const b = await body(request);
    const classNo = intIn(b.classNo, CLASS_COUNT());
    if (!classNo) return fail('몇 반 단체사진인지 입력해 주세요.');
    const { byId } = await loadPhotos();
    const photo = byId.get(String(b.fileId || ''));
    if (!photo) return fail('사진을 찾을 수 없어요. 드라이브 새로고침 후 다시 해 주세요.', 404);
    await query(
      `INSERT INTO photo_class_picks (class_no, file_id, file_name, teacher_id, teacher_name, selected_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (class_no) DO UPDATE SET file_id = EXCLUDED.file_id, file_name = EXCLUDED.file_name,
         teacher_id = EXCLUDED.teacher_id, teacher_name = EXCLUDED.teacher_name, selected_at = now()`,
      [classNo, photo.id, photo.name, who.teacherId || null, teacherActor(who)],
    );
    await log(teacherActor(who), '반 단체사진 셀렉', { classNo, fileId: photo.id, fileName: photo.name });
    return json({ ok: true });
  },

  'POST /api/staff/class-photo/clear': async (request) => {
    const who = await staff(request);
    const classNo = intIn((await body(request)).classNo, CLASS_COUNT());
    if (!classNo) return fail('반을 확인해 주세요.');
    const rows = await query('SELECT teacher_id FROM photo_class_picks WHERE class_no = $1', [classNo]);
    if (!rows[0]) return json({ ok: true });
    if (who.role === 'teacher' && who.classNo !== classNo && rows[0].teacher_id !== who.teacherId) {
      return fail('담당 반이거나 직접 고른 단체사진만 취소할 수 있어요.', 403);
    }
    await query('DELETE FROM photo_class_picks WHERE class_no = $1', [classNo]);
    await log(teacherActor(who), '반 단체사진 셀렉 취소', { classNo });
    return json({ ok: true });
  },

  // Teacher: own class only. Final admin: every class + teachers + history.
  'GET /api/staff/overview': async (request) => {
    const who = await staff(request);
    const [{ classes, byId }, groups, selections, picks, locked] = await Promise.all([
      loadPhotos(),
      query('SELECT class_no, group_no FROM photo_groups'),
      query('SELECT class_no, group_no, file_id, file_name, selected_at FROM photo_selections ORDER BY class_no, group_no'),
      query('SELECT class_no, file_id, file_name, teacher_id, teacher_name, selected_at FROM photo_class_picks'),
      isLocked(),
    ]);
    const registered = new Set(groups.map((g) => `${g.class_no}-${g.group_no}`));
    const picked = new Map(selections.map((r) => [`${r.class_no}-${r.group_no}`, r]));
    const classPick = new Map(picks.map((r) => [r.class_no, r]));
    const out = [];
    for (let c = 1; c <= CLASS_COUNT(); c++) {
      if (who.role === 'teacher' && c !== who.classNo) continue;
      const rows = [];
      const maxGroup = Math.max(GROUP_COUNT(), ...groups.filter((g) => g.class_no === c).map((g) => g.group_no));
      for (let g = 1; g <= maxGroup; g++) {
        const sel = picked.get(`${c}-${g}`);
        const photo = sel ? byId.get(sel.file_id) : null;
        rows.push({
          groupNo: g,
          registered: registered.has(`${c}-${g}`),
          selection: sel ? {
            fileId: sel.file_id,
            originalName: sel.file_name,
            deliveryName: deliveryName(c, g, photo || { name: sel.file_name }),
            selectedAt: sel.selected_at,
            missing: !photo,
            driveUrl: driveUrl(sel.file_id),
          } : null,
        });
      }
      const cp = classPick.get(c);
      const cpPhoto = cp ? byId.get(cp.file_id) : null;
      out.push({
        classNo: c,
        photoCount: (classes.get(c) || []).length,
        groups: rows,
        classPhoto: cp ? {
          fileId: cp.file_id,
          originalName: cp.file_name,
          deliveryName: classPhotoName(c, cpPhoto || { name: cp.file_name }),
          teacherName: cp.teacher_name,
          selectedAt: cp.selected_at,
          missing: !cpPhoto,
          driveUrl: driveUrl(cp.file_id),
        } : null,
      });
    }
    const result = { role: who.role, name: who.name, classNo: who.classNo || null, locked, classCount: CLASS_COUNT(), classes: out };
    if (who.role === 'admin') {
      result.teachers = (await query('SELECT id, name, class_no, created_at FROM photo_teachers ORDER BY class_no, name'))
        .map((t) => ({ id: t.id, name: t.name, classNo: t.class_no, createdAt: t.created_at }));
      result.log = (await query('SELECT at, actor, action, class_no, group_no, file_name FROM photo_log ORDER BY id DESC LIMIT 300'))
        .map((r) => ({ at: r.at, actor: r.actor, action: r.action, classNo: r.class_no, groupNo: r.group_no, fileName: r.file_name }));
    }
    return json(result);
  },

  'POST /api/admin/lock': async (request) => {
    await staff(request, { adminOnly: true });
    const { locked } = await body(request);
    await setSetting('locked', locked ? '1' : '0');
    await log('최종관리자', locked ? '셀렉 마감' : '셀렉 다시 열기');
    return json({ ok: true, locked: Boolean(locked) });
  },

  'POST /api/admin/delete-teacher': async (request) => {
    await staff(request, { adminOnly: true });
    const id = intIn((await body(request)).id, 2 ** 31 - 1);
    const rows = id ? await query('DELETE FROM photo_teachers WHERE id = $1 RETURNING name, class_no', [id]) : [];
    if (rows[0]) await log('최종관리자', `교사 계정 삭제: ${rows[0].name}(${rows[0].class_no}반)`, { classNo: rows[0].class_no });
    return json({ ok: true });
  },

  // Removes the group's password so the next login sets a new one. The selection is kept.
  'POST /api/staff/reset-group': async (request) => {
    const who = await staff(request);
    const b = await body(request);
    const classNo = intIn(b.classNo, CLASS_COUNT());
    const groupNo = intIn(b.groupNo, 999);
    if (!classNo || !groupNo) return fail('반과 조를 확인해 주세요.');
    ownClass(who, classNo);
    await query('DELETE FROM photo_groups WHERE class_no = $1 AND group_no = $2', [classNo, groupNo]);
    await log(teacherActor(who), '모둠 비밀번호 초기화', { classNo, groupNo });
    return json({ ok: true });
  },

  'POST /api/staff/clear-selection': async (request) => {
    const who = await staff(request);
    const b = await body(request);
    const classNo = intIn(b.classNo, CLASS_COUNT());
    const groupNo = intIn(b.groupNo, 999);
    if (!classNo || !groupNo) return fail('반과 조를 확인해 주세요.');
    ownClass(who, classNo);
    await query('DELETE FROM photo_selections WHERE class_no = $1 AND group_no = $2', [classNo, groupNo]);
    await log(teacherActor(who), '모둠 사진 셀렉 취소', { classNo, groupNo });
    return json({ ok: true });
  },

  'GET /api/staff/export.csv': async (request) => {
    const who = await staff(request);
    const { byId } = await loadPhotos();
    const only = who.role === 'teacher' ? who.classNo : null;
    const sels = await query(
      'SELECT class_no, group_no, file_id, file_name, selected_at FROM photo_selections WHERE $1::int IS NULL OR class_no = $1 ORDER BY class_no, group_no',
      [only],
    );
    const picks = await query(
      'SELECT class_no, file_id, file_name, teacher_name, selected_at FROM photo_class_picks WHERE $1::int IS NULL OR class_no = $1 ORDER BY class_no',
      [only],
    );
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const at = (t) => new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const lines = [['구분', '반', '조', '저장 파일명', '원본 파일명', '선택한 사람', '선택 시각', '드라이브 링크'].map(cell).join(',')];
    for (const r of picks) {
      lines.push(['반 단체사진', r.class_no, '', classPhotoName(r.class_no, byId.get(r.file_id) || { name: r.file_name }),
        r.file_name, r.teacher_name, at(r.selected_at), driveUrl(r.file_id)].map(cell).join(','));
    }
    for (const r of sels) {
      lines.push(['모둠 사진', r.class_no, r.group_no, deliveryName(r.class_no, r.group_no, byId.get(r.file_id) || { name: r.file_name }),
        r.file_name, groupActor(r.class_no, r.group_no), at(r.selected_at), driveUrl(r.file_id)].map(cell).join(','));
    }
    // BOM so Excel opens the Korean text as UTF-8.
    return new Response('﻿' + lines.join('\r\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': attachment(only ? `졸업사진_셀렉_${only}반.csv` : '졸업사진_셀렉_전체.csv'),
        'cache-control': 'no-store',
      },
    });
  },
};

async function dynamicRoute(request, path) {
  if (request.method !== 'GET') return null;

  let m = path.match(/^\/api\/thumb\/([\w-]{10,})$/);
  if (m) {
    const s = readSession(request);
    const { byId } = await loadPhotos();
    const photo = byId.get(m[1]);
    if (!photo) return fail('사진을 찾을 수 없어요.', 404);
    if (s?.role === 'student') {
      const me = await student(request);
      if (photo.classNo !== me.classNo) return fail('우리 반 사진만 볼 수 있어요.', 403);
    } else {
      await staff(request);
    }
    const size = Math.min(Math.max(Number(new URL(request.url).searchParams.get('s')) || 600, 200), 2000);
    const res = await fetchThumbnail(photo.id, size);
    if (!res.ok) return fail('미리보기를 불러오지 못했어요.', 502);
    return new Response(res.body, {
      headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=3600' },
    });
  }

  // Group pick original, renamed to "<반>반_<조>조.<ext>" for the vendor.
  m = path.match(/^\/api\/staff\/download\/(\d+)\/(\d+)$/);
  if (m) {
    const who = await staff(request);
    const [classNo, groupNo] = [Number(m[1]), Number(m[2])];
    ownClass(who, classNo);
    const sel = await selectionFor(classNo, groupNo);
    if (!sel) return fail('이 모둠은 아직 사진을 고르지 않았어요.', 404);
    const { byId } = await loadPhotos();
    return streamOriginal(sel.fileId, deliveryName(classNo, groupNo, byId.get(sel.fileId) || { name: sel.fileName }));
  }

  // Whole-class photo original, renamed to "<반>반_단체.<ext>".
  m = path.match(/^\/api\/staff\/download-class\/(\d+)$/);
  if (m) {
    const who = await staff(request);
    const classNo = Number(m[1]);
    const rows = await query('SELECT file_id, file_name, teacher_id FROM photo_class_picks WHERE class_no = $1', [classNo]);
    if (!rows[0]) return fail('이 반은 아직 단체사진을 고르지 않았어요.', 404);
    if (who.role === 'teacher' && who.classNo !== classNo && rows[0].teacher_id !== who.teacherId) {
      return fail('담당 반이거나 직접 고른 단체사진만 받을 수 있어요.', 403);
    }
    const { byId } = await loadPhotos();
    return streamOriginal(rows[0].file_id, classPhotoName(classNo, byId.get(rows[0].file_id) || { name: rows[0].file_name }));
  }
  return null;
}

function originalPath(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('__path');
  return path === null ? url.pathname : (path.startsWith('/') ? path : '/' + path);
}

export default {
  async fetch(request) {
    const path = originalPath(request).replace(/\/+$/, '') || '/';
    try {
      sameOrigin(request);
      const handler = routes[`${request.method} ${path}`];
      const res = handler ? await handler(request) : await dynamicRoute(request, path);
      return res || fail('없는 주소예요.', 404);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message, e.status);
      console.error(e);
      return fail('서버 오류: ' + String(e && e.message || e).replace(/postgres(ql)?:\/\/\S+/gi, '[url]'), 500);
    }
  },
};
