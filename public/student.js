'use strict';
const $ = (id) => document.getElementById(id);
const state = { data: null };

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '요청에 실패했어요.'), { status: res.status });
  return data;
}

function options(select, count, unit) {
  select.innerHTML = '<option value="">선택</option>' +
    Array.from({ length: count }, (_, i) => `<option value="${i + 1}">${i + 1}${unit}</option>`).join('');
}

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('logout').classList.add('hidden');
  $('who').textContent = '';
}

async function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  try {
    state.data = await api('/api/photos');
  } catch (e) {
    if (e.status === 401) return showLogin();
    $('grid').innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
    return;
  }
  render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function render() {
  const d = state.data;
  $('who').textContent = `${d.classNo}반 ${d.groupNo}조`;
  const picked = d.selection && d.selection.fileId;
  $('status').textContent = picked ? `✅ 셀렉 완료 — '${d.deliveryName}' 이름을 붙여 선생님께 전달돼요` : '아직 셀렉하지 않았어요';
  $('statusHint').textContent = d.locked
    ? '🔒 선생님이 셀렉을 마감했어요. 더 이상 바꿀 수 없어요.'
    : '모둠마다 딱 한 장만 고를 수 있어요. 다른 사진을 누르면 셀렉이 그 사진으로 바뀌어요.';

  if (!d.photos.length) {
    $('grid').innerHTML = '<p class="empty">아직 우리 반 사진이 올라오지 않았어요.</p>';
    return;
  }
  $('grid').innerHTML = d.photos.map((p, i) => {
    const on = p.id === picked;
    return `<div class="photo ${on ? 'picked' : ''}" data-id="${p.id}">
      <div class="img" data-view="${p.id}"><img loading="lazy" src="/api/thumb/${p.id}?s=600" alt="${i + 1}번 사진"></div>
      <div class="meta">
        <span class="name">${i + 1}. ${escapeHtml(p.name)}</span>
        ${on
          ? `<button class="small" data-unpick ${d.locked ? 'disabled' : ''}>셀렉 취소</button>`
          : `<button class="small primary" data-pick="${p.id}" ${d.locked ? 'disabled' : ''}>셀렉</button>`}
      </div>
    </div>`;
  }).join('');
}

async function pick(fileId) {
  const d = state.data;
  const current = d.selection && d.selection.fileId;
  if (current && current !== fileId && !confirm('이미 고른 사진이 있어요. 이 사진으로 바꿀까요?')) return;
  try {
    const r = await api('/api/select', { method: 'POST', body: JSON.stringify({ fileId }) });
    d.selection = r.selection;
    render();
  } catch (e) {
    alert(e.message);
    if (e.status === 401) showLogin();
  }
}

async function unpick() {
  if (!confirm('셀렉을 취소할까요?')) return;
  try {
    await api('/api/select', { method: 'DELETE' });
    state.data.selection = null;
    render();
  } catch (e) { alert(e.message); }
}

$('grid').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-pick],[data-unpick],[data-view]');
  if (!t) return;
  if (t.dataset.pick) return pick(t.dataset.pick);
  if ('unpick' in t.dataset) return unpick();
  openZoom(t.dataset.view);
});

function openZoom(id) {
  const d = state.data;
  const photos = d.photos.map((p, i) => ({ id: p.id, label: `${i + 1}. ${p.name}` }));
  PhotoZoom.open({
    photos,
    index: Math.max(0, photos.findIndex((p) => p.id === id)),
    actions: [{
      primary: true,
      label: (p) => (state.data.selection && state.data.selection.fileId === p.id ? '✅ 우리 모둠이 셀렉한 사진' : '이 사진으로 셀렉'),
      disabled: (p) => state.data.locked || (state.data.selection && state.data.selection.fileId === p.id),
      onClick: async (p) => { await pick(p.id); PhotoZoom.refresh(); },
    }],
  });
}

$('login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginError').textContent = '';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ classNo: $('classNo').value, groupNo: $('groupNo').value, password: $('password').value }),
    });
    $('password').value = '';
    if (r.created) alert(`${r.classNo}반 ${r.groupNo}조 비밀번호가 정해졌어요. 모둠원들에게 알려 주세요.`);
    showApp();
  } catch (e) {
    $('loginError').textContent = e.message;
  }
});

$('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); };

// The group list follows the chosen class: only as many groups as that class's teacher set.
function groupOptions(cfg) {
  const count = cfg.groupCounts[$('classNo').value];
  const sel = $('groupNo');
  if (!$('classNo').value) {
    sel.innerHTML = '<option value="">반을 먼저 고르세요</option>';
  } else if (!count) {
    sel.innerHTML = '<option value="">아직 준비 중</option>';
  } else {
    options(sel, count, '조');
  }
  sel.disabled = !count;
  $('groupHint').textContent = $('classNo').value && !count
    ? `${$('classNo').value}반은 선생님이 아직 조 수를 정하지 않았어요. 선생님께 말씀드려 주세요.`
    : '';
}

(async function init() {
  const cfg = await api('/api/config').catch(() => ({ classCount: 5, groupCounts: {} }));
  options($('classNo'), cfg.classCount, '반');
  groupOptions(cfg);
  // Re-read the counts on every class change, in case the teacher set them after this page opened.
  $('classNo').addEventListener('change', async () => {
    groupOptions(cfg);
    const fresh = await api('/api/config').catch(() => null);
    if (fresh) { cfg.groupCounts = fresh.groupCounts; groupOptions(cfg); }
  });
  const me = await api('/api/me').catch(() => ({}));
  if (me.role === 'student') showApp(); else showLogin();
})();
