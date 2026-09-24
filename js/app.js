(function () {
  'use strict';

  /* =========================================================================
   * HELPERS
   * ========================================================================= */

  /** Generate a unique ID (UUID v4 preferred, timestamp+random fallback). */
  function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /** Round a number to 2 decimal places (avoids float drift). */
  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /** Convert "YYYY-MM-DD" → "DD/MM/YYYY". */
  function formatDate(isoDate) {
    if (!isoDate) return '';
    var parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  /** Return the current month as "YYYY-MM". */
  function currentMonthKey() {
    return new Date().toISOString().substring(0, 7);
  }

  /** Return today's date as "YYYY-MM-DD". */
  function todayISO() {
    return new Date().toISOString().split('T')[0];
  }

  /* ─── Notification helpers ────────────────────────────────────────────── */

  function _showNotification(message, type) {
    var area = document.getElementById('notification-area');
    if (!area) return;

    // Remove existing notification of same type to avoid stacking
    var existing = area.querySelector('.notification.' + type);
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.className = 'notification ' + type;
    div.setAttribute('role', 'alert');

    var text = document.createElement('span');
    text.textContent = message;

    var close = document.createElement('button');
    close.className = 'notification-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', function () { div.remove(); });

    div.appendChild(text);
    div.appendChild(close);
    area.appendChild(div);

    // Auto-dismiss warnings after 6 s
    if (type === 'warning') {
      setTimeout(function () { if (div.parentNode) div.remove(); }, 6000);
    }
  }

  function showWarning(msg) { _showNotification(msg, 'warning'); }
  function showError(msg)   { _showNotification(msg, 'error'); }

  /* =========================================================================
   * MODULE 1 — EventBus
   * =========================================================================
   * Lightweight pub/sub. All inter-module communication goes through here.
   * ========================================================================= */
  var EventBus = (function () {
    var _listeners = {};

    return {
      on: function (event, callback) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(callback);
      },

      off: function (event, callback) {
        if (!_listeners[event]) return;
        _listeners[event] = _listeners[event].filter(function (cb) {
          return cb !== callback;
        });
      },

      emit: function (event, payload) {
        if (!_listeners[event]) return;
        // Iterate shallow copy so off() inside a handler is safe
        _listeners[event].slice().forEach(function (cb) {
          cb(payload);
        });
      }
    };
  }());

  /* =========================================================================
   * MODULE 2 — StorageManager
   * =========================================================================
   * Single source of truth for localStorage. All reads/writes go here.
   * ========================================================================= */
  var StorageManager = (function () {
    var KEYS = {
      TRANSACTIONS: 'ebv_transactions',
      CATEGORIES:   'ebv_categories',
      LIMITS:       'ebv_limits'
    };

    var MAX_BYTES = 5 * 1024 * 1024; // 5 MB

    function _read(key) {
      try {
        var raw = localStorage.getItem(key);
        if (raw === null) return null;
        return JSON.parse(raw);
      } catch (e) {
        showWarning('Some stored data could not be read and has been reset.');
        return null;
      }
    }

    function _write(key, value) {
      try {
        var serialized = JSON.stringify(value);
        // Approximate total storage usage
        var total = serialized.length;
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k !== key) {
            total += (localStorage.getItem(k) || '').length;
          }
        }
        if (total > MAX_BYTES) {
          showWarning('Storage capacity reached. New data was not saved.');
          return false;
        }
        localStorage.setItem(key, serialized);
        return true;
      } catch (e) {
        showWarning('Could not write to storage: ' + e.message);
        return false;
      }
    }

    return {
      KEYS: KEYS,
      _read: _read,
      _write: _write,

      getTransactions: function () {
        return _read(KEYS.TRANSACTIONS) || [];
      },
      getCategories: function () {
        return _read(KEYS.CATEGORIES) || [];
      },
      getLimits: function () {
        return _read(KEYS.LIMITS) || {};
      },

      saveTransaction: function (tx) {
        var all = this.getTransactions();
        all.push(tx);
        var ok = _write(KEYS.TRANSACTIONS, all);
        if (ok) EventBus.emit('transactions:changed', { transactions: all });
        return ok;
      },

      deleteTransaction: function (id) {
        var all = this.getTransactions();
        var filtered = all.filter(function (t) { return t.id !== id; });
        var ok = _write(KEYS.TRANSACTIONS, filtered);
        if (ok) EventBus.emit('transactions:changed', { transactions: filtered });
        return ok;
      },

      saveCategory: function (name) {
        var cats = this.getCategories();
        cats.push(name);
        var ok = _write(KEYS.CATEGORIES, cats);
        if (ok) EventBus.emit('categories:changed', { categories: cats });
        return ok;
      },

      deleteCategory: function (name) {
        var cats = this.getCategories().filter(function (c) { return c !== name; });
        var ok = _write(KEYS.CATEGORIES, cats);
        if (ok) EventBus.emit('categories:changed', { categories: cats });
        return ok;
      },

      saveLimit: function (category, amount) {
        var limits = this.getLimits();
        limits[category] = amount;
        var ok = _write(KEYS.LIMITS, limits);
        if (ok) EventBus.emit('limits:changed', { limits: limits });
        return ok;
      },

      removeLimit: function (category) {
        var limits = this.getLimits();
        delete limits[category];
        var ok = _write(KEYS.LIMITS, limits);
        if (ok) EventBus.emit('limits:changed', { limits: limits });
        return ok;
      }
    };
  }());

  /* =========================================================================
   * MODULE 3 — TransactionManager
   * =========================================================================
   * Business logic: validation, creation, deletion, aggregation.
   * ========================================================================= */

  /** Validate raw form data. Returns { valid, errors }. */
  function validateTransaction(data) {
    var errors = {};

    // description
    if (!data.description || data.description.trim().length === 0) {
      errors.description = 'Description is required.';
    } else if (data.description.trim().length > 100) {
      errors.description = 'Description must be 100 characters or fewer.';
    }

    // amount
    var amt = parseFloat(data.amount);
    if (isNaN(amt) || amt < 0.01 || amt > 999999999.99) {
      errors.amount = 'Amount must be between 0.01 and 999,999,999.99.';
    }

    // type
    if (!data.type || ['income', 'expense'].indexOf(data.type) === -1) {
      errors.type = 'Type must be income or expense.';
    }

    // category
    if (!data.category || data.category.trim().length === 0) {
      errors.category = 'Category is required.';
    }

    // date
    if (!data.date || isNaN(Date.parse(data.date))) {
      errors.date = 'A valid date is required.';
    }

    return { valid: Object.keys(errors).length === 0, errors: errors };
  }

  /** Calculate income/expense/balance totals from a transaction array. */
  function calculateTotals(transactions) {
    var income = 0, expense = 0;
    transactions.forEach(function (tx) {
      var amt = parseFloat(tx.amount);
      if (!isFinite(amt) || amt <= 0) return; // skip invalid
      if (tx.type === 'income')  income  += amt;
      else                       expense += amt;
    });
    return {
      income:  round2(income),
      expense: round2(expense),
      balance: round2(income - expense)
    };
  }

  /** Sort transactions by date descending; tie-break by createdAt. */
  function sortByDateDesc(transactions) {
    return transactions.slice().sort(function (a, b) {
      var diff = Date.parse(b.date) - Date.parse(a.date);
      if (diff !== 0) return diff;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  }

  /** Aggregate expense totals by category, optionally filtered to a month. */
  function expensesByCategory(transactions, monthKey) {
    var totals = {};
    transactions.forEach(function (tx) {
      if (tx.type !== 'expense') return;
      if (monthKey && !tx.date.startsWith(monthKey)) return;
      var cat = (tx.category && tx.category.trim()) ? tx.category : 'Uncategorized';
      totals[cat] = round2((totals[cat] || 0) + parseFloat(tx.amount));
    });
    return totals;
  }

  /**
   * Return a Set of category names whose current-month spend meets
   * or exceeds the configured limit.
   */
  function evaluateAlerts(categoryTotals, limits) {
    var exceeded = new Set ? new Set() : { _data: [], has: function(v){ return this._data.indexOf(v) !== -1; }, add: function(v){ this._data.push(v); } };
    Object.keys(limits).forEach(function (cat) {
      if ((categoryTotals[cat] || 0) >= limits[cat]) {
        exceeded.add(cat);
      }
    });
    return exceeded;
  }

  var TransactionManager = (function () {
    return {
      add: function (formData) {
        var result = validateTransaction(formData);
        if (!result.valid) {
          return { ok: false, errors: result.errors };
        }
        var tx = {
          id:          generateId(),
          description: formData.description.trim(),
          amount:      round2(parseFloat(formData.amount)),
          type:        formData.type,
          category:    formData.category,
          date:        formData.date,
          createdAt:   Date.now()
        };
        var saved = StorageManager.saveTransaction(tx);
        if (!saved) return { ok: false, error: 'Could not save transaction.' };
        return { ok: true };
      },

      delete: function (id) {
        var ok = StorageManager.deleteTransaction(id);
        return { ok: ok };
      },

      getAll: function () {
        return StorageManager.getTransactions();
      },

      getSortedByDateDesc: function () {
        return sortByDateDesc(StorageManager.getTransactions());
      },

      getExpensesByCategory: function (monthKey) {
        return expensesByCategory(StorageManager.getTransactions(), monthKey || null);
      },

      getTotals: function (monthKey) {
        var all = StorageManager.getTransactions();
        var filtered = monthKey
          ? all.filter(function (tx) { return tx.date.startsWith(monthKey); })
          : all;
        return calculateTotals(filtered);
      }
    };
  }());

  /* =========================================================================
   * MODULE 4 — CategoryManager
   * =========================================================================
   * Manages default and custom categories; keeps #tx-category in sync.
   * ========================================================================= */
  var CategoryManager = (function () {
    var DEFAULT_CATEGORIES = ['Food', 'Transport', 'Entertainment', 'Health', 'Shopping', 'General'];

    return {
      DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,

      getAllCategories: function () {
        return DEFAULT_CATEGORIES.concat(StorageManager.getCategories());
      },

      getCustomCategories: function () {
        return StorageManager.getCategories();
      },

      buildCategorySelects: function () {
        var select = document.getElementById('tx-category');
        if (!select) return;
        var current = select.value;
        select.innerHTML = '';
        this.getAllCategories().forEach(function (cat) {
          var opt = document.createElement('option');
          opt.value = cat;
          opt.textContent = cat;
          select.appendChild(opt);
        });
        // Restore selection if still valid
        if (current) select.value = current;
      },

      addCategory: function (name) {
        name = name.trim();
        if (name.length === 0 || name.length > 50) {
          return { ok: false, error: 'Category name must be 1–50 characters.' };
        }
        var all = this.getAllCategories();
        var lower = name.toLowerCase();
        if (all.some(function (c) { return c.toLowerCase() === lower; })) {
          return { ok: false, error: 'A category with this name already exists.' };
        }
        var ok = StorageManager.saveCategory(name);
        return { ok: ok };
      },

      deleteCategory: function (name) {
        var all = StorageManager.getTransactions();
        var affected = all.filter(function (tx) { return tx.category === name; });

        if (affected.length > 0) {
          var msg = 'Deleting "' + name + '" will reassign ' + affected.length +
                    ' transaction(s) to "General". Continue?';
          if (!window.confirm(msg)) return { ok: false };

          // Reassign affected transactions
          var updated = all.map(function (tx) {
            if (tx.category === name) {
              return Object.assign({}, tx, { category: 'General' });
            }
            return tx;
          });
          StorageManager._write(StorageManager.KEYS.TRANSACTIONS, updated);
          EventBus.emit('transactions:changed', { transactions: updated });
        }

        StorageManager.deleteCategory(name);
        return { ok: true };
      },

      renderList: function () {
        var list = document.getElementById('category-list');
        if (!list) return;
        list.innerHTML = '';

        DEFAULT_CATEGORIES.forEach(function (cat) {
          var li = document.createElement('li');
          li.className = 'category-item';
          li.innerHTML = '<span>' + _esc(cat) + '</span><span class="default-badge">default</span>';
          list.appendChild(li);
        });

        StorageManager.getCategories().forEach(function (cat) {
          var li = document.createElement('li');
          li.className = 'category-item';
          var btn = document.createElement('button');
          btn.className = 'btn btn-danger delete-cat-btn';
          btn.dataset.category = cat;
          btn.setAttribute('aria-label', 'Delete ' + cat + ' category');
          btn.textContent = '×';
          li.innerHTML = '<span>' + _esc(cat) + '</span>';
          li.appendChild(btn);
          list.appendChild(li);
        });
      },

      bindEvents: function () {
        var self = this;

        var form = document.getElementById('category-form');
        if (form) {
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = document.getElementById('cat-name');
            var errSpan = document.getElementById('err-category-name');
            var result = self.addCategory(input.value);
            if (!result.ok) {
              errSpan.textContent = result.error || 'Could not add category.';
            } else {
              errSpan.textContent = '';
              input.value = '';
              self.renderList();
              self.buildCategorySelects();
            }
          });
        }

        var catList = document.getElementById('category-list');
        if (catList) {
          catList.addEventListener('click', function (e) {
            var btn = e.target.closest('.delete-cat-btn');
            if (!btn) return;
            var cat = btn.dataset.category;
            var result = self.deleteCategory(cat);
            if (result.ok) {
              self.renderList();
              self.buildCategorySelects();
              // SpendingLimitsController may not be defined yet at bind time;
              // rely on EventBus categories:changed subscription instead
            }
          });
        }
      },

      init: function () {
        this.buildCategorySelects();
        this.renderList();
        this.bindEvents();
      }
    };
  }());

  /* =========================================================================
   * MODULE 5 — UIController
   * =========================================================================
   * Renders dashboard, transaction list, alert styles, and wires form events.
   * ========================================================================= */
  var UIController = (function () {

    function renderDashboard(totals) {
      var bi = document.getElementById('total-income');
      var be = document.getElementById('total-expenses');
      var bb = document.getElementById('total-balance');
      if (bi) bi.textContent = totals.income.toFixed(2);
      if (be) be.textContent = totals.expense.toFixed(2);
      if (bb) bb.textContent = totals.balance.toFixed(2);
    }

    function renderTransactionList(transactions) {
      var list = document.getElementById('transaction-list');
      if (!list) return;
      list.innerHTML = '';

      if (!transactions || transactions.length === 0) {
        var li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'No transactions yet. Add your first one above!';
        list.appendChild(li);
        return;
      }

      var limits     = StorageManager.getLimits();
      var catTotals  = expensesByCategory(StorageManager.getTransactions(), currentMonthKey());
      var exceeded   = evaluateAlerts(catTotals, limits);

      transactions.forEach(function (tx) {
        var li = document.createElement('li');
        li.className = 'transaction-item ' + tx.type;
        li.dataset.id       = tx.id;
        li.dataset.category = tx.category;

        var isOver = exceeded.has(tx.category) && tx.type === 'expense';
        if (isOver) li.classList.add('alert');

        var badgeClass = isOver ? 'category-badge over-limit' : 'category-badge';
        var sign = tx.type === 'income' ? '+' : '-';

        li.innerHTML =
          '<div class="tx-info">' +
            '<div class="tx-description">' + _esc(tx.description) + '</div>' +
            '<div class="tx-meta">' +
              '<span class="tx-date">' + formatDate(tx.date) + '</span>' +
              '<span class="' + badgeClass + '">' + _esc(tx.category) + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="tx-amount">' + sign + '$' + tx.amount.toFixed(2) + '</span>' +
          '<button class="delete-btn" data-id="' + tx.id + '" ' +
                  'aria-label="Delete transaction: ' + _esc(tx.description) + '">×</button>';

        list.appendChild(li);
      });
    }

    function renderAlerts(limits, categoryTotals) {
      var exceeded = evaluateAlerts(categoryTotals, limits);
      var items = document.querySelectorAll('#transaction-list .transaction-item[data-category]');
      items.forEach(function (li) {
        var cat = li.dataset.category;
        var isExpense = li.classList.contains('expense');
        var isOver = isExpense && exceeded.has(cat);
        li.classList.toggle('alert', isOver);
        var badge = li.querySelector('.category-badge');
        if (badge) badge.className = isOver ? 'category-badge over-limit' : 'category-badge';
        var amtEl = li.querySelector('.tx-amount');
        // color is handled by CSS class, nothing extra needed
      });
    }

    function showFormError(field, message) {
      var el = document.getElementById('err-' + field);
      if (el) el.textContent = message;
    }

    function clearFormErrors() {
      document.querySelectorAll('.field-error').forEach(function (el) {
        el.textContent = '';
      });
    }

    function clearForm() {
      var form = document.getElementById('transaction-form');
      if (form) form.reset();
      var dateEl = document.getElementById('tx-date');
      if (dateEl) dateEl.value = todayISO();
    }

    function bindFormEvents() {
      var form = document.getElementById('transaction-form');
      if (!form) return;

      // Set today as default date
      var dateEl = document.getElementById('tx-date');
      if (dateEl && !dateEl.value) dateEl.value = todayISO();

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearFormErrors();

        var formData = {
          description: (document.getElementById('tx-description') || {}).value || '',
          amount:      (document.getElementById('tx-amount') || {}).value || '',
          type:        (document.getElementById('tx-type') || {}).value || '',
          category:    (document.getElementById('tx-category') || {}).value || '',
          date:        (document.getElementById('tx-date') || {}).value || ''
        };

        var result = TransactionManager.add(formData);

        if (!result.ok) {
          if (result.errors) {
            Object.keys(result.errors).forEach(function (field) {
              showFormError(field, result.errors[field]);
            });
          } else {
            showError(result.error || 'Could not save transaction. Please try again.');
          }
          return;
        }

        clearForm();
      });
    }

    function bindDeleteEvents() {
      var list = document.getElementById('transaction-list');
      if (!list) return;

      list.addEventListener('click', function (e) {
        var btn = e.target.closest('.delete-btn[data-id]');
        if (!btn) return;
        var id = btn.dataset.id;
        if (!window.confirm('Delete this transaction?')) return;
        var result = TransactionManager.delete(id);
        if (!result.ok) {
          showError('Could not delete transaction. Please try again.');
        }
      });
    }

    return {
      renderDashboard:       renderDashboard,
      renderTransactionList: renderTransactionList,
      renderAlerts:          renderAlerts,
      showFormError:         showFormError,
      clearFormErrors:       clearFormErrors,
      clearForm:             clearForm,
      bindFormEvents:        bindFormEvents,
      bindDeleteEvents:      bindDeleteEvents,

      init: function () {
        renderDashboard(TransactionManager.getTotals());
        renderTransactionList(TransactionManager.getSortedByDateDesc());
        renderAlerts(StorageManager.getLimits(), TransactionManager.getExpensesByCategory(currentMonthKey()));
        bindFormEvents();
        bindDeleteEvents();
      }
    };
  }());

  /* =========================================================================
   * MODULE 6 — ChartRenderer
   * =========================================================================
   * Draws a doughnut pie chart on a <canvas> element. No external library.
   * ========================================================================= */
  var ChartRenderer = (function () {
    // WCAG 4.5:1 compliant palette against white
    var PALETTE = [
      '#1a73e8', '#e8710a', '#0d9e6e', '#c62828',
      '#6a1b9a', '#00838f', '#558b2f', '#ad1457'
    ];

    var canvas, ctx, emptyMsg;

    function generateColors(n) {
      return Array.from({ length: n }, function (_, i) {
        return PALETTE[i % PALETTE.length];
      });
    }

    function clear() {
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function _drawSlice(cx, cy, r, innerR, startAngle, endAngle, color) {
      ctx.beginPath();
      ctx.moveTo(
        cx + innerR * Math.cos(startAngle),
        cy + innerR * Math.sin(startAngle)
      );
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    function _drawLegend(entries, colors, exceeded) {
      var x = canvas.width * 0.62;
      var y = 20;
      ctx.font = '13px system-ui, -apple-system, sans-serif';

      entries.forEach(function (entry, i) {
        var cat = entry[0];
        var val = entry[1];
        var isOver = exceeded && exceeded.has(cat);
        var color = isOver ? '#92400e' : colors[i];

        // Color swatch
        ctx.fillStyle = color;
        ctx.fillRect(x, y, 12, 12);

        if (isOver) {
          // Alert border on swatch
          ctx.strokeStyle = '#92400e';
          ctx.lineWidth = 2;
          ctx.strokeRect(x - 1, y - 1, 14, 14);
        }

        // Label
        ctx.fillStyle = '#111827';
        ctx.fillText(
          cat + ' $' + val.toFixed(2) + (isOver ? ' ⚠' : ''),
          x + 18,
          y + 10
        );

        y += 24;
        if (y + 24 > canvas.height) {
          // Wrap to a second legend column if needed
          x += 140;
          y = 20;
        }
      });
    }

    function render(categoryTotals) {
      if (!canvas || !ctx) return;
      clear();

      var entries = Object.entries
        ? Object.entries(categoryTotals).filter(function (e) { return e[1] > 0; })
        : Object.keys(categoryTotals).map(function (k) { return [k, categoryTotals[k]]; }).filter(function (e) { return e[1] > 0; });

      if (entries.length === 0) {
        canvas.hidden = true;
        if (emptyMsg) emptyMsg.hidden = false;
        return;
      }

      canvas.hidden = false;
      if (emptyMsg) emptyMsg.hidden = true;

      var total  = entries.reduce(function (s, e) { return s + e[1]; }, 0);
      var colors = generateColors(entries.length);
      var cx     = canvas.width * 0.3;
      var cy     = canvas.height / 2;
      var r      = Math.min(cx, cy) * 0.85;
      var innerR = r * 0.5;

      var startAngle = -Math.PI / 2;

      var limits    = StorageManager.getLimits();
      var catTotals = expensesByCategory(StorageManager.getTransactions(), currentMonthKey());
      var exceeded  = evaluateAlerts(catTotals, limits);

      entries.forEach(function (entry, i) {
        var val        = entry[1];
        var sliceAngle = (val / total) * 2 * Math.PI;
        var endAngle   = startAngle + sliceAngle;
        var color      = (exceeded && exceeded.has(entry[0])) ? '#92400e' : colors[i];
        _drawSlice(cx, cy, r, innerR, startAngle, endAngle, color);
        startAngle = endAngle;
      });

      _drawLegend(entries, colors, exceeded);
    }

    return {
      init: function (canvasId) {
        canvas   = document.getElementById(canvasId);
        if (!canvas) return;
        ctx      = canvas.getContext('2d');
        emptyMsg = document.getElementById('chart-empty');
      },
      render:         render,
      clear:          clear,
      generateColors: generateColors
    };
  }());

  /* =========================================================================
   * MODULE 7 — SummaryView
   * =========================================================================
   * Monthly aggregation panel.
   * ========================================================================= */
  var SummaryView = (function () {
    var _currentMonth = currentMonthKey();

    function getAvailableMonths() {
      var txs = StorageManager.getTransactions();
      var seen = {};
      txs.forEach(function (tx) {
        if (tx.date) seen[tx.date.substring(0, 7)] = true;
      });
      var months = Object.keys(seen).sort().reverse();
      if (months.indexOf(_currentMonth) === -1) months.unshift(_currentMonth);
      return months;
    }

    function _monthLabel(monthKey) {
      try {
        return new Date(monthKey + '-01').toLocaleDateString('en-US', {
          month: 'long', year: 'numeric'
        });
      } catch (e) {
        return monthKey;
      }
    }

    function renderForMonth(monthKey) {
      _currentMonth = monthKey;
      var totals = TransactionManager.getTotals(monthKey);
      var txCount = StorageManager.getTransactions().filter(function (tx) {
        return tx.date && tx.date.startsWith(monthKey);
      }).length;

      var emptyEl = document.getElementById('summary-empty');
      var valuesEl = document.getElementById('summary-values');

      if (txCount === 0) {
        if (emptyEl)  emptyEl.hidden  = false;
        if (valuesEl) valuesEl.style.opacity = '0.4';
      } else {
        if (emptyEl)  emptyEl.hidden  = true;
        if (valuesEl) valuesEl.style.opacity = '1';
      }

      var incomeEl  = document.getElementById('summary-income');
      var expenseEl = document.getElementById('summary-expenses');
      var balanceEl = document.getElementById('summary-balance');
      if (incomeEl)  incomeEl.textContent  = totals.income.toFixed(2);
      if (expenseEl) expenseEl.textContent = totals.expense.toFixed(2);
      if (balanceEl) balanceEl.textContent = totals.balance.toFixed(2);
    }

    function bindMonthSelector() {
      var select = document.getElementById('summary-month');
      if (!select) return;

      var months = getAvailableMonths();
      select.innerHTML = '';
      months.forEach(function (mk) {
        var opt = document.createElement('option');
        opt.value = mk;
        opt.textContent = _monthLabel(mk);
        select.appendChild(opt);
      });
      select.value = _currentMonth;

      select.addEventListener('change', function () {
        renderForMonth(select.value);
      });
    }

    function refreshMonthSelector() {
      var select = document.getElementById('summary-month');
      if (!select) return;
      var prev = select.value;
      var months = getAvailableMonths();
      select.innerHTML = '';
      months.forEach(function (mk) {
        var opt = document.createElement('option');
        opt.value = mk;
        opt.textContent = _monthLabel(mk);
        select.appendChild(opt);
      });
      // Restore previous selection if still available
      select.value = months.indexOf(prev) !== -1 ? prev : _currentMonth;
    }

    return {
      getAvailableMonths: getAvailableMonths,

      renderForMonth: renderForMonth,

      refresh: function () {
        refreshMonthSelector();
        renderForMonth(_currentMonth);
      },

      getCurrentMonth: function () { return _currentMonth; },

      init: function () {
        bindMonthSelector();
        renderForMonth(_currentMonth);
      }
    };
  }());

  /* =========================================================================
   * MODULE 8 — SpendingLimitsController
   * =========================================================================
   * Per-category spending limit UI with visual alert integration.
   * ========================================================================= */
  var SpendingLimitsController = (function () {

    function renderList() {
      var container = document.getElementById('limits-list');
      if (!container) return;
      container.innerHTML = '';

      var limits = StorageManager.getLimits();
      var categories = CategoryManager.getAllCategories();

      categories.forEach(function (cat) {
        var row = document.createElement('div');
        row.className = 'limit-row';
        row.dataset.category = cat;

        var hasLimit = limits.hasOwnProperty(cat);
        var currentLimit = hasLimit ? limits[cat] : '';

        row.innerHTML =
          '<span class="limit-category-name">' + _esc(cat) + '</span>' +
          '<input type="number" class="limit-input" data-category="' + _esc(cat) + '" ' +
                 'aria-label="Spending limit for ' + _esc(cat) + '" ' +
                 'min="0.01" max="999999999" step="0.01" ' +
                 'value="' + (hasLimit ? currentLimit : '') + '" ' +
                 'placeholder="No limit">' +
          '<button class="btn-save-limit save-limit-btn" data-category="' + _esc(cat) + '">Set</button>' +
          '<button class="btn-remove-limit remove-limit-btn" data-category="' + _esc(cat) + '"' +
                  (hasLimit ? '' : ' hidden') + '>Remove</button>' +
          '<span class="limit-error" id="limit-err-' + _escId(cat) + '" role="alert" aria-live="assertive"></span>';

        container.appendChild(row);
      });
    }

    function bindEvents() {
      var container = document.getElementById('limits-list');
      if (!container) return;

      container.addEventListener('click', function (e) {
        var saveBtn = e.target.closest('.save-limit-btn');
        var removeBtn = e.target.closest('.remove-limit-btn');

        if (saveBtn) {
          var cat = saveBtn.dataset.category;
          var row = container.querySelector('.limit-row[data-category="' + cat + '"]');
          var input = row ? row.querySelector('.limit-input') : null;
          var errEl = document.getElementById('limit-err-' + _escId(cat));

          if (!input) return;
          var val = parseFloat(input.value);

          if (errEl) errEl.textContent = '';

          if (isNaN(val) || val <= 0) {
            if (errEl) errEl.textContent = 'Limit must be greater than 0.';
            return;
          }
          if (val > 999999999) {
            if (errEl) errEl.textContent = 'Limit cannot exceed 999,999,999.';
            return;
          }

          StorageManager.saveLimit(cat, round2(val));
          // Show remove button
          var removeBtn2 = row ? row.querySelector('.remove-limit-btn') : null;
          if (removeBtn2) removeBtn2.hidden = false;
        }

        if (removeBtn) {
          var cat2 = removeBtn.dataset.category;
          StorageManager.removeLimit(cat2);
          var row2 = container.querySelector('.limit-row[data-category="' + cat2 + '"]');
          if (row2) {
            var input2 = row2.querySelector('.limit-input');
            if (input2) input2.value = '';
            var rb = row2.querySelector('.remove-limit-btn');
            if (rb) rb.hidden = true;
          }
        }
      });

      EventBus.on('categories:changed', function () {
        renderList();
      });
    }

    return {
      renderList: renderList,
      bindEvents: bindEvents,
      init: function () {
        renderList();
        bindEvents();
      }
    };
  }());

  /* =========================================================================
   * UTILITY — HTML escape helpers
   * ========================================================================= */

  /** Escape a string for safe insertion into HTML. */
  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Escape a string for use as part of an element ID. */
  function _escId(str) {
    return String(str).replace(/[^a-zA-Z0-9-_]/g, '_');
  }

  /* =========================================================================
   * EVENTBUS SUBSCRIPTIONS
   * =========================================================================
   * Central wiring: data changes propagate to all UI modules.
   * ========================================================================= */

  EventBus.on('transactions:changed', function () {
    UIController.renderDashboard(TransactionManager.getTotals());
    UIController.renderTransactionList(TransactionManager.getSortedByDateDesc());
    UIController.renderAlerts(
      StorageManager.getLimits(),
      TransactionManager.getExpensesByCategory(currentMonthKey())
    );
    ChartRenderer.render(TransactionManager.getExpensesByCategory());
    SummaryView.refresh();
  });

  EventBus.on('categories:changed', function () {
    CategoryManager.buildCategorySelects();
    CategoryManager.renderList();
    SpendingLimitsController.renderList();
  });

  EventBus.on('limits:changed', function () {
    UIController.renderAlerts(
      StorageManager.getLimits(),
      TransactionManager.getExpensesByCategory(currentMonthKey())
    );
    ChartRenderer.render(TransactionManager.getExpensesByCategory());
    SpendingLimitsController.renderList();
  });

  /* =========================================================================
   * BOOTSTRAP — DOMContentLoaded
   * ========================================================================= */
  document.addEventListener('DOMContentLoaded', function () {
    // Detect localStorage availability early
    try {
      localStorage.setItem('__ebv_test__', '1');
      localStorage.removeItem('__ebv_test__');
    } catch (e) {
      showWarning('Local storage is unavailable. Your data will not be saved between sessions.');
    }

    // 1. CategoryManager first — populates #tx-category before form renders
    CategoryManager.init();

    // 2. UIController — dashboard, history, form events
    UIController.init();

    // 3. ChartRenderer
    ChartRenderer.init('spending-chart');
    ChartRenderer.render(TransactionManager.getExpensesByCategory());

    // 4. SummaryView
    SummaryView.init();

    // 5. SpendingLimitsController
    SpendingLimitsController.init();
  });

}());
