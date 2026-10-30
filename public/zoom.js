'use strict';
// Full-screen photo viewer with zoom and pan, for checking faces (closed eyes etc.).
// Zoom: mouse wheel, pinch, double-click/double-tap, +/− buttons or keys. Pan: drag.
// Shows a 1600px image at once, then swaps in a 3200px one for sharp zooming.
// PhotoZoom.open({ photos: [{ id, label }], index, actions: [{ label, primary, disabled, onClick(photo) }] })
window.PhotoZoom = (function () {
  const MAX = 8;
  let root, stage, img, caption, counter, actionsBox, level;
  let photos = [], index = 0, actions = [];
  let scale = 1, x = 0, y = 0;
  const pointers = new Map();
  let pinch = null, drag = null, lastTap = 0;

  function build() {
    root = document.createElement('div');
    root.className = 'zoom hidden';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '사진 크게 보기');
    root.innerHTML = `
      <div class="zoom-top">
        <span class="zoom-caption"></span><span class="zoom-counter"></span>
        <span class="zoom-spacer"></span>
        <button type="button" class="zoom-btn" data-z="out" aria-label="축소">−</button>
        <span class="zoom-level">100%</span>
        <button type="button" class="zoom-btn" data-z="in" aria-label="확대">+</button>
        <button type="button" class="zoom-btn" data-z="fit">맞춤</button>
        <button type="button" class="zoom-btn" data-z="close" aria-label="닫기">✕</button>
      </div>
      <div class="zoom-stage"><img alt="" draggable="false"></div>
      <button type="button" class="zoom-nav prev" data-z="prev" aria-label="이전 사진">‹</button>
      <button type="button" class="zoom-nav next" data-z="next" aria-label="다음 사진">›</button>
      <div class="zoom-bottom">
        <span class="zoom-tip">휠·두 손가락으로 확대, 끌어서 이동, 두 번 누르면 확대/맞춤</span>
        <span class="zoom-actions"></span>
      </div>`;
    document.body.appendChild(root);
    stage = root.querySelector('.zoom-stage');
    img = stage.querySelector('img');
    caption = root.querySelector('.zoom-caption');
    counter = root.querySelector('.zoom-counter');
    actionsBox = root.querySelector('.zoom-actions');
    level = root.querySelector('.zoom-level');

    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-z]');
      if (!b) return;
      const z = b.dataset.z;
      if (z === 'close') close();
      else if (z === 'prev') go(-1);
      else if (z === 'next') go(1);
      else if (z === 'fit') reset();
      else zoomAt(z === 'in' ? 1.6 : 1 / 1.6, centre());
    });
    actionsBox.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-action]');
      if (b) actions[Number(b.dataset.action)].onClick(photos[index]);
    });
    stage.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), { x: ev.clientX, y: ev.clientY });
    }, { passive: false });
    stage.addEventListener('dblclick', (ev) => toggleZoom({ x: ev.clientX, y: ev.clientY }));
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    document.addEventListener('keydown', (ev) => {
      if (root.classList.contains('hidden')) return;
      if (ev.key === 'Escape') close();
      else if (ev.key === 'ArrowLeft') go(-1);
      else if (ev.key === 'ArrowRight') go(1);
      else if (ev.key === '+' || ev.key === '=') zoomAt(1.6, centre());
      else if (ev.key === '-') zoomAt(1 / 1.6, centre());
      else if (ev.key === '0') reset();
      else return;
      ev.preventDefault();
    });
    window.addEventListener('resize', () => { if (!root.classList.contains('hidden')) apply(); });
  }

  const centre = () => {
    const r = stage.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  function apply() {
    // Keep the photo from being dragged completely out of view.
    const r = stage.getBoundingClientRect();
    const maxX = Math.max(0, (img.offsetWidth * scale - r.width) / 2);
    const maxY = Math.max(0, (img.offsetHeight * scale - r.height) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    level.textContent = Math.round(scale * 100) + '%';
    stage.classList.toggle('zoomed', scale > 1.01);
  }

  // Zoom by factor k keeping the point under the cursor/fingers fixed.
  function zoomAt(k, p) {
    const next = Math.min(MAX, Math.max(1, scale * k));
    const c = centre();
    const px = p.x - c.x, py = p.y - c.y;
    x = px - (px - x) * (next / scale);
    y = py - (py - y) * (next / scale);
    scale = next;
    apply();
  }

  function toggleZoom(p) {
    if (scale > 1.01) reset();
    else zoomAt(3, p);
  }

  function reset() { scale = 1; x = 0; y = 0; apply(); }

  function down(ev) {
    stage.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    } else {
      drag = { x: ev.clientX, y: ev.clientY, moved: false };
    }
  }

  function move(ev) {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(dist / pinch.dist, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      pinch.dist = dist;
    } else if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.x = ev.clientX; drag.y = ev.clientY;
      if (scale > 1.01) { x += dx; y += dy; apply(); }
      else drag.swipe = (drag.swipe || 0) + dx;
    }
  }

  function up(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag || pointers.size) return;
    // Swipe left/right at normal size moves between photos.
    if (scale <= 1.01 && Math.abs(drag.swipe || 0) > 60) go(drag.swipe < 0 ? 1 : -1);
    else if (!drag.moved && ev.pointerType !== 'mouse') {
      const now = Date.now();
      if (now - lastTap < 300) { toggleZoom({ x: ev.clientX, y: ev.clientY }); lastTap = 0; } else lastTap = now;
    }
    drag = null;
  }

  function show() {
    const p = photos[index];
    reset();
    caption.textContent = p.label || '';
    counter.textContent = photos.length > 1 ? ` · ${index + 1} / ${photos.length}` : '';
    root.querySelector('.prev').hidden = photos.length < 2;
    root.querySelector('.next').hidden = photos.length < 2;
    root.classList.add('loading');
    img.onload = null;
    img.src = `/api/thumb/${p.id}?s=1600`;
    // Swap in the sharper version once it has downloaded, without moving the view.
    const hi = new Image();
    hi.onload = () => { if (photos[index] === p) { img.src = hi.src; root.classList.remove('loading'); } };
    hi.onerror = () => { if (photos[index] === p) root.classList.remove('loading'); };
    hi.src = `/api/thumb/${p.id}?s=3200`;
    renderActions();
  }

  function renderActions() {
    const p = photos[index];
    actionsBox.innerHTML = actions.map((a, i) => {
      const off = typeof a.disabled === 'function' ? a.disabled(p) : a.disabled;
      const label = typeof a.label === 'function' ? a.label(p) : a.label;
      return `<button type="button" data-action="${i}" class="${a.primary ? 'primary' : ''}" ${off ? 'disabled' : ''}>${label}</button>`;
    }).join('');
  }

  function go(step) {
    if (photos.length < 2) return;
    index = (index + step + photos.length) % photos.length;
    show();
  }

  function open(opts) {
    if (!root) build();
    photos = opts.photos;
    index = opts.index || 0;
    actions = opts.actions || [];
    root.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    show();
    root.querySelector('[data-z="close"]').focus();
  }

  function close() {
    root.classList.add('hidden');
    document.body.style.overflow = '';
    img.removeAttribute('src');
  }

  // refresh() redraws the action buttons (e.g. after a pick) without resetting the zoom.
  return { open, close, refresh: () => root && !root.classList.contains('hidden') && renderActions() };
})();
