/* 全站客户端：一律事件委托 + data 属性（行内 handler 会被服务端模板求值吃掉）。
   禁止乐观更新：启停/删除等操作等后端返回真实状态再渲染 + toast。
   带行内 display 样式的元素 hidden 属性无效，用 style.display 控制显隐。 */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  var toastEl;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 源详情弹窗 ---------- */
  function openModal(html) {
    var mask = $('#modal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'modal-mask';
      mask.className = 'modal-mask';
      document.body.appendChild(mask);
    }
    mask.innerHTML = '<div class="modal">' + html + '</div>';
    mask.classList.add('open');
  }
  function closeModal() {
    var mask = $('#modal-mask');
    if (mask) mask.classList.remove('open');
  }

  function renderSourceModal(d) {
    var s = d.source;
    var diag = d.diagnostics;
    var stats = d.stats;
    var changes = d.changes || [];
    var html = '' +
      '<h3>' + esc(s.name) + ' <span class="kv">[' + esc(s.channel) + ']</span></h3>' +
      '<div class="zone"><h4>基本信息（可编辑）</h4>' +
      '<form data-action="save-source" data-id="' + s.id + '">' +
      '<label>名称</label><input type="text" name="name" value="' + esc(s.name) + '">' +
      '<label>行业标签</label><select name="industry_tag"><option value="">—</option>' +
      d.xIndustryTags.map(function (t) { return '<option ' + (s.industry_tag === t ? 'selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select>' +
      '<label>角色</label><select name="role"><option value="">—</option>' +
      d.roles.map(function (t) { return '<option ' + (s.role === t ? 'selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select>' +
      '<label>优先级</label><select name="priority">' +
      d.priorities.map(function (p) { return '<option value="' + p.key + '" ' + (s.priority === p.key ? 'selected' : '') + '>' + p.key + ' ' + esc(p.label) + '</option>'; }).join('') + '</select>' +
      '<label>备注</label><textarea name="notes" rows="2">' + esc(s.notes || '') + '</textarea>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" type="submit">保存</button></div>' +
      '</form></div>' +
      '<div class="zone"><h4>诊断（只读）</h4><div class="kv">' +
      '状态：<b>' + esc(diag.statusLabel) + '</b><br>' +
      '最近尝试：' + esc(diag.lastAttempt || '从未被调度') + '　最近成功：' + esc(diag.lastSuccess || '从未成功') + '<br>' +
      '最新内容：' + esc(diag.lastNewItem || '尚无条目') + '<br>' +
      (diag.lastError ? '失败原因：' + esc(diag.lastError) + '<br>' : '') +
      '30天统计：' + (stats ? ('条目 ' + stats.items_30d + ' · 4-5级占比 ' + stats.highRatio + '（截至 ' + esc(stats.computedAt) + '）') : '统计待生成') + '<br>' +
      '下次调度：' + esc(diag.nextRun) + '<br>' +
      '最近变更：' + (changes.length ? changes.map(function (c) { return esc(c.created_at + ' ' + c.action); }).join('；') : '—') +
      '</div></div>' +
      '<div class="zone"><h4>操作</h4>' +
      '<button class="btn" data-action="toggle-source" data-id="' + s.id + '">' + (s.enabled ? '停用' : '启用') + '</button> ' +
      '<button class="btn" data-action="test-fetch" data-id="' + s.id + '">测试抓取</button> ' +
      '<button class="btn btn-danger" data-action="delete-source" data-id="' + s.id + '" data-name="' + esc(s.name) + '">删除</button>' +
      '<span id="test-fetch-result" class="kv" style="display:block;margin-top:8px"></span>' +
      '</div>' +
      '<div style="margin-top:14px;text-align:right"><button class="btn" data-action="close-modal">关闭</button></div>';
    openModal(html);
  }

  /* ---------- 添加源弹窗 ---------- */
  function renderAddModal(channels) {
    var opts = channels.map(function (c) { return '<option value="' + c.key + '">' + esc(c.label) + '</option>'; }).join('');
    openModal('' +
      '<h3>添加信息源</h3>' +
      '<div class="toolbar"><button class="btn chip on" data-action="add-mode" data-mode="single">单条</button>' +
      '<button class="btn chip" data-action="add-mode" data-mode="batch">批量</button></div>' +
      '<form data-action="create-source" id="add-single">' +
      '<label>渠道</label><select name="channel">' + opts + '</select>' +
      '<label>标识（feed URL / handle / channel_id）</label><input type="text" name="identifier" required>' +
      '<label>名称</label><input type="text" name="name" placeholder="留空自动取">' +
      '<div style="margin-top:10px"><button class="btn btn-primary" type="submit">添加</button></div></form>' +
      '<form data-action="detect-batch" id="add-batch" style="display:none">' +
      '<label>每行一个链接/handle（自动识别渠道）</label>' +
      '<textarea name="lines" rows="6" placeholder="https://example.com/feed&#10;@sama&#10;https://www.youtube.com/channel/UC..."></textarea>' +
      '<div style="margin-top:10px"><button class="btn btn-primary" type="submit">识别预览</button></div>' +
      '<div id="batch-preview"></div></form>' +
      '<div style="margin-top:14px;text-align:right"><button class="btn" data-action="close-modal">关闭</button></div>');
  }

  function renderBatchPreview(rows) {
    var box = $('#batch-preview');
    if (!box) return;
    box.innerHTML = rows.map(function (r, i) {
      if (r.error) {
        return '<div class="kv" style="color:var(--red)">✗ ' + esc(r.input) + ' — ' + esc(r.error) + '</div>';
      }
      return '<div class="kv">✓ [' + esc(r.channel) + '] ' + esc(r.identifier) +
        ' <input type="text" data-batch-name data-i="' + i + '" value="' + esc(r.name || '') + '" placeholder="名称可改" style="width:180px"></div>';
    }).join('') +
      '<div style="margin-top:8px"><button class="btn btn-primary" data-action="confirm-batch">确认添加通过行</button></div>';
    box._rows = rows;
  }

  /* ---------- 批量操作条 ---------- */
  function refreshBatchBar() {
    var bar = $('#batch-bar');
    if (!bar) return;
    var checked = $all('.source-card input[type=checkbox]:checked');
    bar.classList.toggle('visible', checked.length > 0);
    var count = $('#batch-count');
    if (count) count.textContent = checked.length + ' 项选中';
    // 双态按钮：全启用→“停用” / 混合→“全部启用”+计数小字
    var allEnabled = checked.length > 0 && checked.every(function (c) { return c.closest('.source-card').dataset.enabled === '1'; });
    var toggleBtn = $('#batch-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = allEnabled ? '停用' : '全部启用';
      toggleBtn.dataset.enable = allEnabled ? '0' : '1';
    }
    var allCore = checked.length > 0 && checked.every(function (c) { return c.closest('.source-card').dataset.priority === 'P0'; });
    var prioBtn = $('#batch-priority');
    if (prioBtn) {
      prioBtn.textContent = allCore ? '设为标准' : '设为核心';
      prioBtn.dataset.priority = allCore ? 'P1' : 'P0';
    }
  }

  function selectedSourceIds() {
    return $all('.source-card input[type=checkbox]:checked').map(function (c) {
      return Number(c.closest('.source-card').dataset.id);
    });
  }

  /* ---------- 筛选面板（staged 应用制，状态写 URL 可分享） ---------- */
  function applyFilters() {
    var panel = $('.filter-panel');
    if (!panel) return;
    var params = new URLSearchParams();
    $all('.chip.on[data-filter]', panel).forEach(function (chip) {
      var k = chip.dataset.filter;
      var prev = params.get(k);
      params.set(k, prev ? prev + ',' + chip.dataset.value : chip.dataset.value);
    });
    var q = $('input[name=q]', panel);
    if (q && q.value.trim()) params.set('q', q.value.trim());
    ['from', 'to'].forEach(function (k) {
      var el = $('input[name=' + k + ']', panel);
      if (el && el.value) params.set(k, el.value);
    });
    location.href = '/items?' + params.toString();
  }

  /* ---------- 事件委托 ---------- */
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-action]');

    // 源卡片点击打开详情（复选框与外链不冒泡触发）
    var card = ev.target.closest('.source-card');
    if (card && !t && !ev.target.closest('a') && ev.target.type !== 'checkbox') {
      api('GET', '/api/sources/' + card.dataset.id).then(renderSourceModal).catch(function (e) { toast(e.message); });
      return;
    }

    // 日报列表行展开
    var head = ev.target.closest('.report-row .head');
    if (head && !ev.target.closest('a')) {
      head.closest('.report-row').classList.toggle('open');
      return;
    }

    // 低等级折叠行展开
    var collapse = ev.target.closest('.collapse-line');
    if (collapse) {
      $all('.item-row.low-grade').forEach(function (r) { r.style.display = 'flex'; });
      collapse.style.display = 'none';
      return;
    }

    // 筛选 chip 切换（staged，不立即请求）
    var chip = ev.target.closest('.chip[data-filter]');
    if (chip) { chip.classList.toggle('on'); return; }

    if (!t) return;
    var action = t.dataset.action;

    if (action === 'close-modal') { closeModal(); return; }
    if (ev.target.id === 'modal-mask') { closeModal(); return; }

    if (action === 'open-add') {
      api('GET', '/api/sources/channels').then(function (d) { renderAddModal(d.channels); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (action === 'add-mode') {
      $all('[data-action=add-mode]').forEach(function (b) { b.classList.toggle('on', b === t); });
      $('#add-single').style.display = t.dataset.mode === 'single' ? 'block' : 'none';
      $('#add-batch').style.display = t.dataset.mode === 'batch' ? 'block' : 'none';
      return;
    }
    if (action === 'confirm-batch') {
      var box = $('#batch-preview');
      var rows = (box && box._rows || []).filter(function (r) { return !r.error; });
      $all('[data-batch-name]', box).forEach(function (inp) {
        var r = box._rows[Number(inp.dataset.i)];
        if (r) r.name = inp.value;
      });
      api('POST', '/api/sources/batch', { rows: rows })
        .then(function (d) { toast('已添加 ' + d.created + ' 个源，初始化中'); location.reload(); })
        .catch(function (e) { toast(e.message); });
      return;
    }

    if (action === 'toggle-source') {
      api('POST', '/api/sources/' + t.dataset.id + '/toggle')
        .then(function (d) {
          toast(d.enabled ? '已启用，已加入调度' : '已停用，已移出调度');
          location.reload(); // 只按后端响应渲染
        }).catch(function (e) { toast(e.message); });
      return;
    }
    if (action === 'test-fetch') {
      var out = $('#test-fetch-result');
      if (out) out.textContent = '测试中…';
      api('POST', '/api/sources/' + t.dataset.id + '/test-fetch')
        .then(function (d) { if (out) out.textContent = d.message; })
        .catch(function (e) { if (out) out.textContent = '失败：' + e.message; });
      return;
    }
    if (action === 'delete-source') {
      // 删除时必须询问是否连带删除该源全部条目
      var withItems = confirm('删除源「' + t.dataset.name + '」。\n\n是否连带删除该源全部条目？\n[确定]=连带删除条目　[取消]=保留条目（源名显示“已归档”）');
      api('POST', '/api/sources/' + t.dataset.id + '/delete', { deleteItems: withItems })
        .then(function () { toast('已删除'); location.href = '/sources'; })
        .catch(function (e) { toast(e.message); });
      return;
    }

    if (action === 'batch-toggle') {
      api('POST', '/api/sources/batch-op', { ids: selectedSourceIds(), op: 'toggle', enable: t.dataset.enable === '1' })
        .then(function () { location.reload(); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (action === 'batch-priority') {
      api('POST', '/api/sources/batch-op', { ids: selectedSourceIds(), op: 'priority', priority: t.dataset.priority })
        .then(function () { location.reload(); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (action === 'batch-delete') {
      if (!confirm('确认删除选中的源？条目将保留。')) return;
      api('POST', '/api/sources/batch-op', { ids: selectedSourceIds(), op: 'delete' })
        .then(function () { location.reload(); }).catch(function (e) { toast(e.message); });
      return;
    }

    if (action === 'apply-filters') { applyFilters(); return; }
    if (action === 'reset-filters') { location.href = '/items'; return; }
    if (action === 'print-report') { window.print(); return; }
    if (action === 'run-job') {
      api('POST', '/api/admin/jobs/' + t.dataset.id + '/run')
        .then(function () { toast('已触发'); }).catch(function (e) { toast(e.message); });
      return;
    }
    if (action === 'toggle-job') {
      api('POST', '/api/admin/jobs/' + t.dataset.id + '/toggle')
        .then(function () { location.reload(); }).catch(function (e) { toast(e.message); });
      return;
    }
  });

  document.addEventListener('change', function (ev) {
    if (ev.target.matches('.source-card input[type=checkbox]')) refreshBatchBar();
    if (ev.target.matches('select[data-nav-report]')) {
      location.href = '/reports/' + ev.target.value + '?type=' + ev.target.dataset.type;
    }
  });

  document.addEventListener('submit', function (ev) {
    var form = ev.target.closest('form[data-action]');
    if (!form) return;
    ev.preventDefault();
    var action = form.dataset.action;
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });

    if (action === 'save-source') {
      api('POST', '/api/sources/' + form.dataset.id + '/update', data)
        .then(function () { toast('已保存'); location.reload(); })
        .catch(function (e) { toast(e.message); });
    } else if (action === 'create-source') {
      api('POST', '/api/sources', data)
        .then(function (d) { toast('已添加：' + d.name + '，初始化中'); location.reload(); })
        .catch(function (e) { toast(e.message); });
    } else if (action === 'detect-batch') {
      api('POST', '/api/sources/detect', { lines: data.lines })
        .then(function (d) { renderBatchPreview(d.rows); })
        .catch(function (e) { toast(e.message); });
    } else if (action === 'add-watchlist') {
      api('POST', '/api/admin/watchlist', data)
        .then(function () { location.reload(); }).catch(function (e) { toast(e.message); });
    }
  });
})();
