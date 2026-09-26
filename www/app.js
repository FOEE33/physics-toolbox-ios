/* ============================================================
   物理工具箱 · 渲染逻辑
   四个模块：公式库 / 量纲 / 常数 / 校验
   - 量纲 ↔ 公式 双向跳转
   - 符号反查：点符号表里的符号 → 列出用到它的公式
   - 校验器：任选两个物理量，判断是否同量纲
   ============================================================ */
(() => {
  'use strict';

  const FORMULAS = window.FORMULAS || [];
  const CONSTANTS = window.CONSTANTS || [];
  const ORDER = ['M', 'L', 'T', 'I', 'Θ', 'N', 'J'];
  const BASIC = { M: '质量', L: '长度', T: '时间', I: '电流', 'Θ': '温度', N: '物质的量', J: '发光强度' };
  const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

  const sup = n => String(n).split('').map(c => SUP[c] ?? c).join('');
  const dimText = d => ORDER.filter(k => d && d[k]).map(k => k + sup(d[k])).join(' ') || '无量纲';
  const dimKey = d => ORDER.filter(k => d && d[k]).map(k => `${k}:${d[k]}`).join('|') || 'none';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const tex = (t, display) => {
    try {
      return katex.renderToString(t, { displayMode: !!display, throwOnError: false, strict: false, output: 'html' });
    } catch (e) {
      return '<code>' + esc(t) + '</code>';
    }
  };

  /* ---------- 量纲分组 ---------- */
  const dimGroups = new Map();
  FORMULAS.forEach(f => {
    if (!f.dim || !ORDER.some(k => f.dim[k])) return;
    const k = dimKey(f.dim);
    if (!dimGroups.has(k)) dimGroups.set(k, { key: k, dim: f.dim, qtys: [], ids: [] });
    const g = dimGroups.get(k);
    if (f.qty && !g.qtys.includes(f.qty)) g.qtys.push(f.qty);
    g.ids.push(f.id);
  });

  /* ---------- 物理量索引（校验器用） ---------- */
  const qtyMap = new Map();
  FORMULAS.forEach(f => {
    if (!f.qty || !f.dim) return;
    if (!qtyMap.has(f.qty)) qtyMap.set(f.qty, { qty: f.qty, dim: f.dim, ids: [] });
    qtyMap.get(f.qty).ids.push(f.id);
  });
  const qtyList = [...qtyMap.values()].sort((a, b) => a.qty.localeCompare(b.qty, 'zh'));

  const byId = new Map(FORMULAS.map(f => [f.id, f]));

  /* 符号规范化：\varepsilon_{0} / ε_0 / ε0 视为同一符号 */
  const normSym = s => String(s).replace(/\\/g, '').replace(/[{}_\s]/g, '').toLowerCase();

  /* ---------- 状态 ---------- */
  const state = {
    mode: 'formula', filter: '全部', q: '',
    sel: null, dimSel: null, cursor: -1,
    checkA: null, checkB: null
  };

  const $ = id => document.getElementById(id);

  /* ---------- 主题：5 套配色，点色点整套切换（深浅已并入主题） ---------- */
  const THEMES = [
    { id: 'mist',   label: '晨雾（浅）', g: ['#b2cdff', '#d6c8ff'] },
    { id: 'sakura', label: '樱野（浅）', g: ['#ffd0e0', '#ffe2cd'] },
    { id: 'amber',  label: '琥珀（浅）', g: ['#ffe0b2', '#ffd0ad'] },
    { id: 'abyss',  label: '深海（深）', g: ['#1a4a7a', '#0e5460'] },
    { id: 'violet', label: '夜阑（深）', g: ['#4a2878', '#6e2464'] }
  ];
  const THEME_KEY = 'pt.theme';
  const themeIds = THEMES.map(t => t.id);

  function applyTheme(id) {
    if (!themeIds.includes(id)) id = THEMES[0].id;
    document.documentElement.dataset.theme = id;
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.t === id));
  }

  function initTheme() {
    const box = $('swatches');
    box.innerHTML = THEMES.map(t =>
      `<button class="swatch" data-t="${t.id}" title="${t.label}" style="background:linear-gradient(135deg,${t.g[0]},${t.g[1]})"></button>`
    ).join('');
    box.addEventListener('click', e => {
      const b = e.target.closest('.swatch'); if (!b) return;
      localStorage.setItem(THEME_KEY, b.dataset.t);
      applyTheme(b.dataset.t);
    });
    applyTheme(localStorage.getItem(THEME_KEY) || THEMES[0].id);
  }

  /* ---------- 过滤/切换后保证右栏选中项仍在中栏列表里 ---------- */
  function syncSelection() {
    if (state.mode === 'formula') {
      const items = currentList();
      if (!items.some(f => f.id === state.sel)) state.sel = items.length ? items[0].id : null;
    } else if (state.mode === 'dimension') {
      const groups = currentList();
      if (!groups.some(g => g.key === state.dimSel)) state.dimSel = groups.length ? groups[0].key : null;
    } else if (state.mode === 'constant') {
      const items = currentList();
      if (!items.some(c => c.sym === state.sel)) state.sel = items.length ? items[0].sym : null;
    }
  }

  /* ---------- 侧栏 ---------- */
  function renderFilters() {
    const box = $('filters');
    let rows;
    if (state.mode === 'formula') {
      const levels = ['高中', '物竞', '普物'];
      rows = [['全部', FORMULAS.length]].concat(levels.map(l => [l, FORMULAS.filter(f => f.level === l).length]));
      $('sideLabel').textContent = '适用范围';
    } else if (state.mode === 'dimension') {
      rows = [['全部', dimGroups.size]].concat(
        ORDER.map(k => [k, [...dimGroups.values()].filter(g => g.dim[k]).length]).filter(r => r[1] > 0));
      $('sideLabel').textContent = '按基本量筛选';
    } else if (state.mode === 'constant') {
      rows = [['全部', CONSTANTS.length]];
      $('sideLabel').textContent = '常数表';
    } else {
      rows = [['全部', qtyList.length]];
      $('sideLabel').textContent = '物理量（点两个对比）';
    }

    box.innerHTML = rows.map(([k, n]) => {
      let label = '全部';
      if (k !== '全部') {
        if (state.mode === 'dimension') label = k + ' · ' + BASIC[k];
        else label = k;
      }
      return `<button class="filter ${state.filter === k ? 'active' : ''}" data-k="${k}">
         <span>${esc(label)}</span><span class="n">${n}</span></button>`;
    }).join('');
  }

  /* ---------- 列表 ---------- */
  function matches(f, q) {
    if (!q) return true;
    const hay = [
      f.name, f.en, f.id, f.chapter, f.qty, f.cond, dimText(f.dim),
      (f.tags || []).join(' '), (f.variants || []).join(' '), f.latex,
      (f.vars || []).map(v => v[0] + ' ' + v[1]).join(' ')
    ].join(' ').toLowerCase();
    return hay.includes(q);
  }

  /* 搜索相关性：名称完全匹配 > 名称包含 > 英文名包含 > 仅正文命中 */
  function relevance(f, q) {
    const name = (f.name || '').toLowerCase();
    if (name === q) return 3;
    if (name.includes(q)) return 2;
    if ((f.en || '').toLowerCase().includes(q)) return 1;
    return 0;
  }

  function currentList() {
    const q = state.q.trim().toLowerCase();
    if (state.mode === 'formula') {
      const items = FORMULAS.filter(f => (state.filter === '全部' || f.level === state.filter) && matches(f, q));
      if (q) items.sort((a, b) => relevance(b, q) - relevance(a, q));
      return items;
    }
    if (state.mode === 'dimension') {
      return [...dimGroups.values()]
        .filter(g => (state.filter === '全部' || g.dim[state.filter]) &&
          (!q || (dimText(g.dim) + ' ' + g.qtys.join(' ') + ' ' + g.ids.join(' ')).toLowerCase().includes(q)))
        .sort((a, b) => b.ids.length - a.ids.length);
    }
    if (state.mode === 'constant') {
      return CONSTANTS.filter(c =>
        !q || (c.sym + ' ' + c.name + ' ' + (c.note || '') + ' ' + c.unit).toLowerCase().includes(q));
    }
    return qtyList.filter(x => !q || (x.qty + ' ' + dimText(x.dim)).toLowerCase().includes(q));
  }

  function renderList() {
    const items = currentList();
    const list = $('list');

    if (state.mode === 'formula') {
      $('listMeta').textContent = `${items.length} 条公式`;
      list.innerHTML = items.map((f, i) => `
        <div class="item ${state.sel === f.id ? 'active' : ''}" data-id="${f.id}" data-i="${i}">
          <div class="t">${esc(f.name)}</div>
          <div class="s">${tex(f.latex, false)}</div>
          <span class="dim-badge">${dimText(f.dim)}</span>
        </div>`).join('') || '<div class="empty" style="height:auto;padding:30px">没有匹配的公式</div>';

    } else if (state.mode === 'dimension') {
      $('listMeta').textContent = `${items.length} 组量纲`;
      list.innerHTML = items.map(g => `
        <div class="item ${state.dimSel === g.key ? 'active' : ''}" data-dim="${g.key}">
          <div class="t" style="font-family:var(--mono);color:var(--accent)">${dimText(g.dim)}</div>
          <div class="s">${esc(g.qtys.join(' / '))}</div>
          <span class="dim-badge">${g.ids.length} 条公式</span>
        </div>`).join('') || '<div class="empty" style="height:auto;padding:30px">没有匹配的量纲</div>';

    } else if (state.mode === 'constant') {
      $('listMeta').textContent = `${items.length} 个物理常数`;
      list.innerHTML = items.map(c => `
        <div class="item ${state.sel === c.sym ? 'active' : ''}" data-sym="${esc(c.sym)}">
          <div class="t">${tex(c.sym, false)} <span style="font-weight:400;color:var(--text-dim);font-size:12.5px">${esc(c.name)}</span></div>
          <div class="s">${esc(c.value)} ${esc(c.unit)}</div>
        </div>`).join('') || '<div class="empty" style="height:auto;padding:30px">没有匹配的常数</div>';

    } else {
      $('listMeta').textContent = `${items.length} 种物理量 · 点两个做对比`;
      list.innerHTML = items.map(x => {
        const tag = state.checkA === x.qty ? 'A' : (state.checkB === x.qty ? 'B' : '');
        return `<div class="item ${tag ? 'active' : ''}" data-qty="${esc(x.qty)}">
          <div class="t">${esc(x.qty)}${tag ? `<span class="ab-tag">${tag}</span>` : ''}</div>
          <div class="s">${dimText(x.dim)}</div>
          <span class="dim-badge">${x.ids.length} 条公式</span>
        </div>`;
      }).join('');
    }
  }

  /* ---------- 详情 ---------- */
  function renderDetail() {
    const box = $('detail');

    /* --- 常数详情 --- */
    if (state.mode === 'constant') {
      const c = CONSTANTS.find(x => x.sym === state.sel);
      if (!c) {
        box.innerHTML = `<div class="empty"><div><div class="big">∑</div>从左边选一个常数</div></div>`;
        return;
      }
      const n = normSym(c.sym);
      const used = FORMULAS.filter(f =>
        (f.vars || []).some(v => {
          const nv = normSym(v[0]);
          return nv === n || nv.includes(n) || n.includes(nv);
        })).slice(0, 24);

      box.innerHTML = `
        <div class="d-head"><h1>${esc(c.name)}</h1></div>
        <div class="chips">
          <span class="chip accent">${tex(c.sym, false)}</span>
          <span class="chip">${esc(c.note || '')}</span>
        </div>
        <div class="formula-card" style="display:flex;align-items:baseline;justify-content:center;gap:16px;flex-wrap:wrap">
          <span style="font-size:24px">${tex(c.sym, false)}</span>
          <span style="font-family:var(--mono);font-size:26px;color:var(--accent)">= ${esc(c.value)}</span>
          <span style="font-size:15px;color:var(--text-dim)">${esc(c.unit)}</span>
        </div>
        <div class="sec-title">来源与精度</div>
        <div class="note">${esc(c.note || '—')}</div>
        ${used.length ? `
          <div class="sec-title">出现在这些公式的符号表中（${used.length}）</div>
          <div class="related-list">
            ${used.map(f => `<div class="related" data-goto-id="${f.id}"><span>${esc(f.name)}</span><span style="color:var(--text-faint);font-size:12px">${esc(f.level)}</span></div>`).join('')}
          </div>` : ''}
      `;
      return;
    }

    /* --- 量纲校验器 --- */
    if (state.mode === 'check') {
      const A = state.checkA ? qtyMap.get(state.checkA) : null;
      const B = state.checkB ? qtyMap.get(state.checkB) : null;
      if (!A) {
        box.innerHTML = `<div class="empty"><div><div class="big">⚖</div>
          在中栏点选两个物理量，判断它们是否同量纲<br>
          <span style="font-size:12px">例如：力 ↔ 重力、能量 ↔ 功、动量 ↔ 冲量</span></div></div>`;
        return;
      }
      const card = (x, tag) => x ? `
        <div class="cmp-card">
          <div class="cmp-tag">${tag}</div>
          <div class="cmp-qty">${esc(x.qty)}</div>
          <div class="cmp-dim">${dimText(x.dim)}</div>
          <div class="cmp-n">${x.ids.length} 条公式</div>
        </div>` : `<div class="cmp-card empty-card"><div class="cmp-tag">${tag}</div><div style="color:var(--text-faint);font-size:13px">待选</div></div>`;

      let verdict = '';
      if (A && B) {
        const same = dimKey(A.dim) === dimKey(B.dim);
        verdict = `<div class="verdict ${same ? 'ok' : 'no'}">${same ? '✓ 同量纲' : '✗ 不同量纲'}</div>`;
        if (same) {
          verdict += `<div class="note" style="text-align:center">两者可以相加减或相等，公式里可以互相替换</div>`;
        } else {
          const diffs = ORDER.filter(k => (A.dim[k] || 0) !== (B.dim[k] || 0))
            .map(k => `<code>${k}(${BASIC[k]})</code> ${A.dim[k] || 0} → ${B.dim[k] || 0}`);
          verdict += `<div class="sec-title">差在哪</div>
            <div class="note">${diffs.join('　')}</div>
            <div class="note" style="margin-top:10px">若两个式子的量纲不同，它们**不可能相等**（除非中间漏了常数或系数有量纲）</div>`;
        }
      } else {
        verdict = `<div class="note" style="text-align:center;color:var(--text-faint)">再选一个物理量即可对比</div>`;
      }

      box.innerHTML = `
        <div class="d-head"><h1>量纲校验</h1><span class="en">dimension check</span></div>
        <div class="cmp-row">${card(A, 'A')}${card(B, 'B')}</div>
        ${verdict}
      `;
      return;
    }

    /* --- 量纲详情 --- */
    if (state.mode === 'dimension' && state.dimSel) {
      const g = dimGroups.get(state.dimSel);
      if (!g) { box.innerHTML = ''; return; }
      const cells = ORDER.map(k => `
        <div class="dim-cell ${g.dim[k] ? 'on' : ''}">
          <div class="b">${k}${g.dim[k] ? sup(g.dim[k]) : ''}</div>
          <div class="e">${BASIC[k]}</div>
        </div>`).join('');
      box.innerHTML = `
        <div class="dim-hero">
          <div class="expr">${dimText(g.dim)}</div>
          <div class="qty">${esc(g.qtys.join(' / '))}</div>
        </div>
        <div class="dim-grid">${cells}</div>
        <div class="sec-title">该量纲下的公式（${g.ids.length}）</div>
        <div class="related-list">
          ${g.ids.map(id => {
            const f = byId.get(id);
            return `<div class="related" data-goto-id="${id}"><span>${esc(f.name)}</span><span style="color:var(--text-faint);font-size:12px">${esc(f.level)}</span></div>`;
          }).join('')}
        </div>`;
      return;
    }

    /* --- 公式详情 --- */
    const f = byId.get(state.sel);
    if (!f) {
      box.innerHTML = `<div class="empty"><div><div class="big">φ</div>
        从左边选一条公式，或直接搜索<br>公式与量纲可以互相跳转</div></div>`;
      return;
    }

    const vars = (f.vars || []).map(v =>
      `<tr>
        <td class="sym"><span class="sym-link" data-sym-q="${esc(v[0])}" title="查看用到 ${esc(v[0])} 的所有公式">${tex(v[0], false)}</span></td>
        <td>${esc(v[1])}</td>
        <td style="font-family:var(--mono);color:var(--text-dim)">${esc(v[2] || '—')}</td>
      </tr>`
    ).join('');

    const variants = (f.variants || []).map(v => `<div class="variant">${tex(v, true)}</div>`).join('');

    const rel = (f.rel || []).filter(id => byId.has(id))
      .map(id => `<div class="related" data-goto-id="${id}"><span>${esc(byId.get(id).name)}</span><span style="color:var(--text-faint);font-size:12px">${dimText(byId.get(id).dim)}</span></div>`).join('');

    const dg = dimGroups.get(dimKey(f.dim));

    box.innerHTML = `
      <div class="d-head">
        <h1>${esc(f.name)}</h1>
        ${f.en ? `<span class="en">${esc(f.en)}</span>` : ''}
      </div>
      <div class="chips">
        <span class="chip">${esc(f.level)}</span>
        <span class="chip">${esc(f.chapter || '')}</span>
        <span class="chip link accent" data-goto-dim="${dimKey(f.dim)}" title="跳到量纲视图">量纲 ${dimText(f.dim)}</span>
        ${(f.tags || []).map(t => `<span class="chip">${esc(t)}</span>`).join('')}
      </div>

      <div class="formula-card">${tex(f.latex, true)}</div>

      <div class="sec-title">符号含义 <span style="text-transform:none;font-weight:400">（点符号可反查）</span></div>
      <table class="vars">
        <thead><tr><th>符号</th><th>含义</th><th>单位</th></tr></thead>
        <tbody>${vars}</tbody>
      </table>

      <div class="sec-title">量纲</div>
      <div class="note">基本量分解：<code>${dimText(f.dim)}</code>${dg ? `　共 ${dg.ids.length} 条公式共享此量纲` : ''}</div>

      ${f.cond ? `<div class="sec-title">适用条件</div><div class="note">${esc(f.cond)}</div>` : ''}
      ${variants ? `<div class="sec-title">常见变形</div>${variants}` : ''}
      ${rel ? `<div class="sec-title">相关公式</div><div class="related-list">${rel}</div>` : ''}
    `;
  }

  /* ---------- 总渲染 ---------- */
  function render() {
    renderFilters();
    renderList();
    renderDetail();
  }

  /* ---------- 模式与跳转 ---------- */
  function markMode(mode) {
    document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  }

  function setMode(mode) {
    state.mode = mode;
    state.filter = '全部';
    state.q = '';
    $('search').value = '';
    if (mode === 'formula') state.dimSel = null;
    if (mode === 'dimension') state.sel = null;
    if (mode === 'constant') { state.sel = CONSTANTS.length ? CONSTANTS[0].sym : null; state.filter = '全部'; }
    if (mode === 'check') { state.checkA = null; state.checkB = null; }
    markMode(mode);
    render();
  }

  function goDim(key) {
    state.mode = 'dimension';
    state.filter = '全部';
    state.q = ''; $('search').value = '';
    state.dimSel = key;
    markMode('dimension');
    render();
    $('detail').scrollTop = 0;
  }

  function goFormula(id) {
    state.mode = 'formula';
    state.filter = '全部';
    state.q = ''; $('search').value = '';
    state.sel = id;
    markMode('formula');
    render();
    $('detail').scrollTop = 0;
  }

  /* 符号反查：把符号丢进搜索框，切回公式模式 */
  function searchSymbol(sym) {
    state.mode = 'formula';
    state.filter = '全部';
    state.q = sym;
    $('search').value = sym;
    markMode('formula');
    render();
  }

  /* ---------- 事件 ---------- */
  function bind() {
    $('search').addEventListener('input', e => { state.q = e.target.value; renderList(); });

    $('filters').addEventListener('click', e => {
      const b = e.target.closest('.filter'); if (!b) return;
      state.filter = b.dataset.k;
      syncSelection();
      render();
    });

    document.querySelectorAll('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

    $('list').addEventListener('click', e => {
      const it = e.target.closest('.item'); if (!it) return;
      if (it.dataset.id) {
        state.sel = it.dataset.id;
      } else if (it.dataset.dim) {
        state.dimSel = it.dataset.dim;
      } else if (it.dataset.sym) {
        state.sel = it.dataset.sym;
      } else if (it.dataset.qty) {
        const q = it.dataset.qty;
        if (state.checkA === q) state.checkA = null;
        else if (state.checkB === q) state.checkB = null;
        else if (!state.checkA) state.checkA = q;
        else if (!state.checkB) state.checkB = q;
        else { state.checkA = q; state.checkB = null; }   // 两个都满 → 重新开始
      }
      render();
      $('detail').scrollTop = 0;
    });

    $('detail').addEventListener('click', e => {
      const sq = e.target.closest('[data-sym-q]');
      if (sq) return searchSymbol(sq.dataset.symQ);
      const d = e.target.closest('[data-goto-dim]');
      if (d) return goDim(d.dataset.gotoDim);
      const g = e.target.closest('[data-goto-id]');
      if (g) return goFormula(g.dataset.gotoId);
    });

    document.addEventListener('keydown', e => {
      if (e.key === '/' && document.activeElement !== $('search')) { e.preventDefault(); $('search').focus(); return; }
      if (e.key === 'Escape') { $('search').value = ''; state.q = ''; renderList(); $('search').blur(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...document.querySelectorAll('#list .item')];
        if (!items.length) return;
        e.preventDefault();
        state.cursor = Math.max(0, Math.min(items.length - 1, state.cursor + (e.key === 'ArrowDown' ? 1 : -1)));
        items[state.cursor].click();
        items[state.cursor].scrollIntoView({ block: 'nearest' });
      }
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    bind();
    state.sel = FORMULAS.length ? FORMULAS[3].id : null;
    render();
  });
})();
