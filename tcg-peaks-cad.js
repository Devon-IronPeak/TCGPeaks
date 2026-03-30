/* ═══════════════════════════════════════════════════════════════
   TCG PEAKS — LIVE CAD CURRENCY MODULE
   Fetches USD→CAD once per day, caches in localStorage
   Uses free open.er-api.com with frankfurter.app fallback
═══════════════════════════════════════════════════════════════ */

const CAD = (() => {
  const CACHE_KEY   = 'tcgpeaks_cad_rate';
  const CACHE_TS    = 'tcgpeaks_cad_ts';
  const ONE_DAY_MS  = 86_400_000;

  let _rate = null;
  let _mode = 'USD'; // 'USD' | 'CAD'
  let _onUpdate = [];

  /* ── Public API ── */
  const api = {
    /** Call once on page load */
    async init() {
      await _loadRate();
      _bindToggle();
      _renderRateBadge();
      _applyCurrentMode();
    },

    /** Register a callback when rate updates or mode switches */
    onUpdate(fn) { _onUpdate.push(fn); },

    /** Convert a USD number to current display currency */
    convert(usd) {
      if (_mode === 'CAD' && _rate) return usd * _rate;
      return usd;
    },

    /** Format a number with currency prefix */
    format(usd, decimals = 2) {
      const val = api.convert(usd);
      const sym = _mode === 'CAD' ? 'CA$' : '$';
      return `${sym}${val.toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
    },

    /** Current mode string */
    get mode() { return _mode; },

    /** Current rate */
    get rate() { return _rate; },

    /** Force a fresh fetch (ignores cache) */
    async refresh() {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_TS);
      await _loadRate();
      _renderRateBadge();
      _applyCurrentMode();
    }
  };

  /* ── Internal ── */
  async function _loadRate() {
    const ts   = parseInt(localStorage.getItem(CACHE_TS) || '0');
    const cached = localStorage.getItem(CACHE_KEY);
    const age  = Date.now() - ts;

    if (cached && age < ONE_DAY_MS) {
      _rate = parseFloat(cached);
      console.log(`[CAD] Using cached rate: ${_rate} (${Math.round(age/3600000)}h old)`);
      return;
    }

    console.log('[CAD] Fetching fresh rate…');
    _rate = await _fetchRate();
    if (_rate) {
      localStorage.setItem(CACHE_KEY, _rate.toString());
      localStorage.setItem(CACHE_TS, Date.now().toString());
      console.log(`[CAD] Fresh rate fetched: ${_rate}`);
    }
  }

  async function _fetchRate() {
    // Primary: open.er-api.com (free, no key)
    const sources = [
      async () => {
        const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        if (d.result === 'success') return d.rates.CAD;
        throw new Error('ER-API failed');
      },
      // Fallback: frankfurter.app
      async () => {
        const r = await fetch('https://api.frankfurter.app/latest?base=USD&symbols=CAD', { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        if (d.rates?.CAD) return d.rates.CAD;
        throw new Error('Frankfurter failed');
      },
      // Last resort: hardcoded recent rate
      async () => {
        console.warn('[CAD] All APIs failed — using static fallback rate 1.37');
        return 1.37;
      }
    ];

    for (const source of sources) {
      try {
        const rate = await source();
        if (rate && rate > 0) return rate;
      } catch (e) {
        console.warn('[CAD] Source failed:', e.message);
      }
    }
    return 1.37; // absolute fallback
  }

  function _bindToggle() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-cad-toggle]');
      if (!btn) return;
      _mode = _mode === 'USD' ? 'CAD' : 'USD';
      _applyCurrentMode();
      _renderRateBadge();
      _notifyAll();
    });
  }

  function _renderRateBadge() {
    const badge = document.getElementById('cad-rate-badge');
    if (!badge) return;
    const ageMs = Date.now() - parseInt(localStorage.getItem(CACHE_TS) || '0');
    const ageH  = Math.round(ageMs / 3600000);
    const ageLabel = ageH < 1 ? 'just now' : ageH === 1 ? '1h ago' : `${ageH}h ago`;
    badge.innerHTML = _rate
      ? `<span class="cad-dot ${_mode === 'CAD' ? 'cad-active' : ''}"></span>
         <span class="cad-label">1 USD = CA$${_rate.toFixed(4)}</span>
         <span class="cad-age">updated ${ageLabel}</span>`
      : `<span class="cad-dot"></span><span class="cad-label">CAD rate loading…</span>`;
  }

  function _applyCurrentMode() {
    // Update all toggle buttons
    document.querySelectorAll('[data-cad-toggle]').forEach(btn => {
      btn.textContent = _mode === 'CAD' ? '🍁 Show USD' : '🍁 Show CAD';
      btn.classList.toggle('cad-btn-active', _mode === 'CAD');
    });
    // Re-render all [data-usd] elements
    document.querySelectorAll('[data-usd]').forEach(el => {
      const usd = parseFloat(el.dataset.usd);
      if (!isNaN(usd)) {
        el.textContent = api.format(usd);
        el.classList.toggle('cad-converted', _mode === 'CAD');
      }
    });
  }

  function _notifyAll() {
    _onUpdate.forEach(fn => { try { fn(_rate, _mode); } catch(e){} });
  }

  return api;
})();

/* Re-export for use in main script */
window.CAD = CAD;
