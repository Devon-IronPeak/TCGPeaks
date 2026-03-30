/**
 * TCG Peaks — Currency Module
 * Fetches live USD→CAD once per day. Only exposed in Settings modal.
 */
const Currency = (() => {
  const RATE_KEY = 'tcgp_fx_rate';
  const TS_KEY   = 'tcgp_fx_ts';
  const MODE_KEY = 'tcgp_fx_mode';
  const ONE_DAY  = 86_400_000;

  let _rate = 1.36;
  let _mode = localStorage.getItem(MODE_KEY) || 'USD';
  let _listeners = [];

  const pub = {
    async init() {
      await _loadRate();
      _applyMode();
    },

    toDisplay(usd) {
      return _mode === 'CAD' ? usd * _rate : usd;
    },

    fmt(usd, decimals = 2) {
      const val = pub.toDisplay(usd);
      const sym = _mode === 'CAD' ? 'CA$' : '$';
      return sym + val.toLocaleString('en-CA', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    },

    setMode(mode) {
      _mode = (mode === 'CAD') ? 'CAD' : 'USD';
      localStorage.setItem(MODE_KEY, _mode);
      _applyMode();
      _listeners.forEach(fn => fn(_mode, _rate));
    },

    get mode()  { return _mode; },
    get rate()  { return _rate; },

    onChange(fn) { _listeners.push(fn); },

    syncUI() {
      const usdEl  = document.getElementById('cur-usd');
      const cadEl  = document.getElementById('cur-cad');
      const infoEl = document.getElementById('cur-rate-info');
      if (usdEl) usdEl.checked = (_mode === 'USD');
      if (cadEl) cadEl.checked = (_mode === 'CAD');
      if (infoEl) {
        const ts  = parseInt(localStorage.getItem(TS_KEY) || '0');
        const age = Math.round((Date.now() - ts) / 3_600_000);
        const when = age < 1 ? 'just now' : age === 1 ? '1 hour ago' : age + ' hours ago';
        infoEl.textContent = '1 USD = CA$' + _rate.toFixed(4) + ' · updated ' + when;
      }
    },
  };

  async function _loadRate() {
    const ts     = parseInt(localStorage.getItem(TS_KEY) || '0');
    const cached = parseFloat(localStorage.getItem(RATE_KEY) || '0');
    if (cached > 0 && (Date.now() - ts) < ONE_DAY) { _rate = cached; return; }
    const fresh = await _fetchRate();
    if (fresh > 0) {
      _rate = fresh;
      localStorage.setItem(RATE_KEY, String(_rate));
      localStorage.setItem(TS_KEY,   String(Date.now()));
    }
  }

  async function _fetchRate() {
    const sources = [
      () => fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) })
              .then(r => r.json()).then(d => d && d.rates && d.rates.CAD),
      () => fetch('https://api.frankfurter.app/latest?base=USD&symbols=CAD', { signal: AbortSignal.timeout(5000) })
              .then(r => r.json()).then(d => d && d.rates && d.rates.CAD),
    ];
    for (const src of sources) {
      try { const r = await src(); if (r > 0) return r; } catch (_) {}
    }
    return 0;
  }

  function _applyMode() {
    document.querySelectorAll('[data-usd]').forEach(el => {
      const usd = parseFloat(el.dataset.usd);
      if (!isNaN(usd)) el.textContent = pub.fmt(usd);
    });
    pub.syncUI();
  }

  return pub;
})();

window.Currency = Currency;
