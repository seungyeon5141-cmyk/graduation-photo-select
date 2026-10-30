'use strict';
const $ = (id) => document.getElementById(id);
const state = { data: null, photos: null, picking: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || '요청에 실패했어요.'), { status: res.status });
  return body;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const isAdmin = () => state.data && state.data.role === 'admin';

// ---------- login ----------

function showLogin() {
  $('auth').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('who').textContent = '';
}

$('authTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-auth]');
  if (!b) return;
  document.querySelectorAll('#authTabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.auth));
  $('loginError').textContent = '';
});

function loginWith(form, path, payload) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('loginError').textContent = '';
    try {
      await api(path, { method: 'POST', body: JSON.stringify(payload()) });
      form.reset();
      load();
    } catch (e) { $('loginError').textContent = e.message; }
  });
}
loginWith($('teacherForm'), '/api/teacher/login', () => ({ name: $('tName').value, password: $('tPw').value }));
loginWith($('signupForm'), '/api/teacher/signup', () => ({ name: $('sName').value, classNo: $('sClass').value, code: $('sCode').value, password: $('sPw').value }));
loginWith($('adminForm'), '/api/admin/login', () => ({ password: $('aPw').value }));
$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); };

// ---------- tabs ----------

$('tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
  if (b.dataset.tab === 'pick' && !state.photos) loadPhotos();
});

// ---------- status ----------

async function load() {
  try {
    state.data = await api('/api/staff/overview');
  } catch (e) {
    if (e.status === 401) return showLogin();
    $('classes').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  const d = state.data;
  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  $('who').textContent = d.role === 'admin' ? '최종관리자' : `${d.name} 선생님 · ${d.classNo}반 담당`;
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', d.role !== 'admin'));
  $('lockedTag').classList.toggle('hidden', d.role === 'admin' || !d.locked);
  fillClassSelect($('classDialogNo'), d.classCount, d.classNo);
  render();
  if (isAdmin()) { renderTeachers(); renderLog(); }
  if (state.photos) renderPhotos();
}

function render() {
  const d = state.data;
  let total = 0;
  let done = 0;
  $('classes').innerHTML = d.classes.map((c) => {
    const picked = c.groups.filter((g) => g.selection).length;
    total += c.groups.length;
    done += picked;
    return `<section class="class">
      <h2>${c.classNo}반 <small>사진 ${c.photoCount}장 · 모둠 셀렉 ${picked}/${c.groups.length}조 · 단체사진 ${c.classPhoto ? '완료' : '미선택'}</small></h2>
      <div class="groups">${classCard(c)}${c.groups.map((g) => groupCard(c.classNo, g)).join('')}</div>
    </section>`;
  }).join('');
  $('progress').textContent = `모둠 셀렉 ${done}/${total}조 · 단체사진 ${d.classes.filter((c) => c.classPhoto).length}/${d.classes.length}반`;
  $('lock').textContent = d.locked ? '🔒 마감됨 · 다시 열기' : '전체 셀렉 마감하기';
}

function thumb(sel, alt, empty) {
  if (!sel) return empty;
  return sel.missing ? '드라이브에서 사진을 찾을 수 없어요'
    : `<img loading="lazy" src="/api/thumb/${sel.fileId}?s=500" alt="${esc(alt)}" data-zoom="${sel.fileId}" data-label="${esc(alt)}">`;
}

function classCard(c) {
  const s = c.classPhoto;
  return `<div class="group class-photo">
    <div class="thumb">${thumb(s, `${c.classNo}반 단체사진`, '단체사진 미선택')}</div>
    <div class="info">
      <div class="file">${c.classNo}반 단체사진 ${s ? '<span class="tag ok">셀렉 완료</span>' : '<span class="tag">대기</span>'}</div>
      ${s
        ? `<div>저장 파일명: <b>${esc(s.deliveryName)}</b></div>
           <div class="orig">선택: ${esc(s.teacherName)} · ${when(s.selectedAt)}</div>
           <div class="orig">원본: ${esc(s.originalName)}</div>`
        : '<div class="orig">‘반 단체사진 고르기’ 탭에서 선택하세요</div>'}
    </div>
    <div class="actions">
      ${s ? `<a href="/api/staff/download-class/${c.classNo}"><button class="small primary" type="button">원본 저장</button></a>
             <a href="${esc(s.driveUrl)}" target="_blank" rel="noopener"><button class="small" type="button">드라이브</button></a>
             <button class="small" data-clear-class="${c.classNo}">셀렉 취소</button>` : ''}
    </div>
  </div>`;
}

function groupCard(classNo, g) {
  const s = g.selection;
  return `<div class="group">
    <div class="thumb">${thumb(s, `${classNo}반 ${g.groupNo}조 셀렉 사진`, '아직 셀렉 안 함')}</div>
    <div class="info">
      <div class="file">${classNo}반 ${g.groupNo}조 ${s ? '<span class="tag ok">셀렉 완료</span>' : '<span class="tag">대기</span>'}</div>
      ${s
        ? `<div>저장 파일명: <b>${esc(s.deliveryName)}</b></div>
           <div class="orig">원본: ${esc(s.originalName)} · ${when(s.selectedAt)}</div>`
        : `<div class="orig">${g.registered ? '로그인함' : '아직 로그인 안 함'}</div>`}
    </div>
    <div class="actions">
      ${s ? `<a href="/api/staff/download/${classNo}/${g.groupNo}"><button class="small primary" type="button">원본 저장</button></a>
             <a href="${esc(s.driveUrl)}" target="_blank" rel="noopener"><button class="small" type="button">드라이브</button></a>
             <button class="small" data-clear="${classNo}-${g.groupNo}">셀렉 취소</button>` : ''}
      ${g.registered ? `<button class="small" data-reset="${classNo}-${g.groupNo}">비밀번호 초기화</button>` : ''}
    </div>
  </div>`;
}

$('classes').addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-clear],[data-reset],[data-clear-class]');
  if (!t) return;
  try {
    if (t.dataset.clearClass) {
      const classNo = Number(t.dataset.clearClass);
      if (!confirm(`${classNo}반 단체사진 셀렉을 취소할까요?`)) return;
      await api('/api/staff/class-photo/clear', { method: 'POST', body: JSON.stringify({ classNo }) });
    } else {
      const [classNo, groupNo] = (t.dataset.clear || t.dataset.reset).split('-').map(Number);
      if (t.dataset.clear) {
        if (!confirm(`${classNo}반 ${groupNo}조의 셀렉을 취소할까요?`)) return;
        await api('/api/staff/clear-selection', { method: 'POST', body: JSON.stringify({ classNo, groupNo }) });
      } else {
        if (!confirm(`${classNo}반 ${groupNo}조 비밀번호를 초기화할까요? 다음에 처음 로그인하는 사람이 새 비밀번호를 정해요. 셀렉한 사진은 그대로 남아요.`)) return;
        await api('/api/staff/reset-group', { method: 'POST', body: JSON.stringify({ classNo, groupNo }) });
      }
    }
    load();
  } catch (e) { alert(e.message); }
});

$('lock').onclick = async () => {
  const next = !state.data.locked;
  if (!confirm(next ? '셀렉을 마감할까요? 학생과 교사는 더 이상 바꿀 수 없어요.' : '셀렉을 다시 열까요?')) return;
  await api('/api/admin/lock', { method: 'POST', body: JSON.stringify({ locked: next }) }).catch((e) => alert(e.message));
  load();
};
$('csv').onclick = () => { location.href = '/api/staff/export.csv'; };

// Builds the ZIP in the browser; each file comes through the server already renamed.
$('zipAll').onclick = async () => {
  const items = state.data.classes.flatMap((c) => [
    ...(c.classPhoto ? [{ classNo: c.classNo, name: c.classPhoto.deliveryName, url: `/api/staff/download-class/${c.classNo}` }] : []),
    ...c.groups.filter((g) => g.selection).map((g) => ({ classNo: c.classNo, name: g.selection.deliveryName, url: `/api/staff/download/${c.classNo}/${g.groupNo}` })),
  ]);
  if (!items.length) return alert('아직 셀렉된 사진이 없어요.');
  if (typeof JSZip === 'undefined') return alert('ZIP 도구를 불러오지 못했어요. 각 사진의 원본 저장 버튼을 이용해 주세요.');
  const btn = $('zipAll');
  btn.disabled = true;
  const zip = new JSZip();
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    btn.textContent = `내려받는 중 ${i + 1}/${items.length}…`;
    try {
      const res = await fetch(items[i].url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      zip.folder(`${items[i].classNo}반`).file(items[i].name, await res.blob());
    } catch {
      failed.push(items[i].name);
    }
  }
  btn.textContent = 'ZIP 만드는 중…';
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = isAdmin() ? '졸업사진_셀렉_전체.zip' : `졸업사진_셀렉_${state.data.classNo}반.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  btn.disabled = false;
  btn.textContent = '셀렉 사진 전체 ZIP 저장';
  if (failed.length) alert('다음 파일은 받지 못했어요. 드라이브 버튼으로 직접 받아 주세요:\n' + failed.join('\n'));
};

// ---------- whole-class photo picking ----------

function fillClassSelect(select, count, preferred) {
  select.innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i + 1}">${i + 1}반</option>`).join('');
  if (preferred) select.value = String(preferred);
}

async function loadPhotos(refresh = false) {
  $('pickList').innerHTML = '<p class="empty">드라이브에서 사진을 불러오는 중…</p>';
  try {
    state.photos = await api('/api/staff/photos' + (refresh ? '?refresh=1' : ''));
  } catch (e) {
    $('pickList').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  const keep = $('folderFilter').value;
  $('folderFilter').innerHTML = '<option value="">모든 폴더</option>' +
    state.photos.folders.map((f) => `<option value="${f.classNo}">${esc(f.label)} (${f.photos.length})</option>`).join('');
  $('folderFilter').value = keep || (state.data.classNo ? String(state.data.classNo) : '');
  if ($('folderFilter').selectedIndex < 0) $('folderFilter').value = '';
  renderPhotos();
}

function renderPhotos() {
  const p = state.photos;
  const filter = $('folderFilter').value;
  const pickedBy = new Map();
  for (const pick of p.picks) pickedBy.set(pick.fileId, [...(pickedBy.get(pick.fileId) || []), pick]);
  const folders = p.folders.filter((f) => filter === '' || String(f.classNo) === filter);
  $('pickList').innerHTML = folders.map((f) => `<section class="class">
    <h2>${esc(f.label)} <small>${f.photos.length}장</small></h2>
    <div class="grid">${f.photos.map((ph) => {
      const picks = pickedBy.get(ph.id) || [];
      return `<div class="photo ${picks.length ? 'picked' : ''}">
        <div class="img" data-view="${ph.id}"><img loading="lazy" src="/api/thumb/${ph.id}?s=600" alt="${esc(ph.name)}"></div>
        <div class="meta">
          <span class="name">${esc(ph.name)}${picks.map((k) => `<br><span class="tag ok">${k.classNo}반 단체사진 · ${esc(k.teacherName)}</span>`).join('')}</span>
          <button class="small primary" data-choose="${ph.id}">단체사진 셀렉</button>
        </div>
      </div>`;
    }).join('') || '<p class="empty">사진이 없어요.</p>'}</div>
  </section>`).join('') || '<p class="empty">드라이브에 사진이 없어요.</p>';
}

$('folderFilter').onchange = renderPhotos;
$('refresh').onclick = () => loadPhotos(true);

// Selected photos on the status cards open full screen, browsable one after another.
$('classes').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-zoom]');
  if (!t) return;
  const all = [...$('classes').querySelectorAll('[data-zoom]')].map((el) => ({ id: el.dataset.zoom, label: el.dataset.label }));
  PhotoZoom.open({ photos: all, index: all.findIndex((p) => p.id === t.dataset.zoom) });
});

function chooseClass(id) {
  state.picking = id;
  $('classDialogImg').src = `/api/thumb/${state.picking}?s=1200`;
  $('classDialog').returnValue = '';
  $('classDialog').showModal();
}

$('pickList').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-choose],[data-view]');
  if (!t) return;
  if (t.dataset.choose) return chooseClass(t.dataset.choose);
  const filter = $('folderFilter').value;
  const photos = state.photos.folders.filter((f) => filter === '' || String(f.classNo) === filter)
    .flatMap((f) => f.photos.map((ph) => ({ id: ph.id, label: `${f.label} · ${ph.name}` })));
  PhotoZoom.open({
    photos,
    index: photos.findIndex((p) => p.id === t.dataset.view),
    actions: [{
      primary: true,
      label: (p) => {
        const picks = state.photos.picks.filter((k) => k.fileId === p.id);
        return picks.length ? `✅ ${picks.map((k) => k.classNo + '반').join(', ')} 단체사진 · 다시 고르기` : '이 사진을 단체사진으로 셀렉';
      },
      onClick: (p) => chooseClass(p.id),
    }],
  });
});

$('classDialog').addEventListener('close', async () => {
  if ($('classDialog').returnValue !== 'ok') return;
  const classNo = Number($('classDialogNo').value);
  const existing = state.photos.picks.find((k) => k.classNo === classNo);
  if (existing && existing.fileId !== state.picking &&
      !confirm(`${classNo}반 단체사진은 이미 ${existing.teacherName}이(가) 골랐어요. 이 사진으로 바꿀까요?`)) return;
  try {
    await api('/api/staff/class-photo', { method: 'POST', body: JSON.stringify({ fileId: state.picking, classNo }) });
    await loadPhotos();
    PhotoZoom.refresh();
    load();
  } catch (e) { alert(e.message); }
});

// ---------- final admin: teachers & history ----------

function renderTeachers() {
  const d = state.data;
  const rows = d.classes.map((c) => {
    const s = c.classPhoto;
    const groupsDone = c.groups.filter((g) => g.selection);
    return `<tr>
      <td>${c.classNo}반</td>
      <td>${s ? `${s.missing ? '' : `<img class="mini" src="/api/thumb/${s.fileId}?s=200" alt="">`}<b>${esc(s.deliveryName)}</b><br><span class="orig">${esc(s.originalName)}</span>` : '<span class="tag">미선택</span>'}</td>
      <td>${s ? `${esc(s.teacherName)}<br><span class="orig">${when(s.selectedAt)}</span>` : '-'}</td>
      <td>${groupsDone.map((g) => `${g.groupNo}조: ${esc(g.selection.originalName)}`).join('<br>') || '-'}</td>
    </tr>`;
  }).join('');
  const teachers = d.teachers.map((t) => `<tr>
      <td>${esc(t.name)}</td><td>${t.classNo}반</td><td>${when(t.createdAt)}</td>
      <td><button class="small" data-del-teacher="${t.id}" data-name="${esc(t.name)}">계정 삭제</button></td>
    </tr>`).join('');
  $('teacherTable').innerHTML = `
    <h2 class="sub">반별 선택 현황</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>반</th><th>단체사진</th><th>선택한 교사</th><th>모둠 셀렉 (원본 파일명)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <h2 class="sub">등록된 교사 (${d.teachers.length}명)</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>이름</th><th>담당 반</th><th>등록</th><th></th></tr></thead>
      <tbody>${teachers || '<tr><td colspan="4">아직 등록한 교사가 없어요.</td></tr>'}</tbody>
    </table></div>`;
}

$('teacherTable').addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-del-teacher]');
  if (!t || !confirm(`${t.dataset.name} 선생님 계정을 삭제할까요? 이미 고른 단체사진 기록은 남아요.`)) return;
  await api('/api/admin/delete-teacher', { method: 'POST', body: JSON.stringify({ id: Number(t.dataset.delTeacher) }) }).catch((e) => alert(e.message));
  load();
});

function renderLog() {
  const rows = state.data.log.map((r) => `<tr>
    <td>${when(r.at)}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td>
    <td>${r.classNo ? `${r.classNo}반${r.groupNo ? ` ${r.groupNo}조` : ''}` : ''}</td><td>${esc(r.fileName || '')}</td>
  </tr>`).join('');
  $('logTable').innerHTML = `<h2 class="sub">전체 기록 (최근 300건)</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>시각</th><th>누가</th><th>무엇을</th><th>대상</th><th>사진</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">기록이 없어요.</td></tr>'}</tbody>
    </table></div>`;
}

// ---------- start ----------

api('/api/config').then((c) => fillClassSelect($('sClass'), c.classCount)).catch(() => fillClassSelect($('sClass'), 5));
api('/api/me').then((me) => (me.role === 'admin' || me.role === 'teacher' ? load() : showLogin())).catch(showLogin);
