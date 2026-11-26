// TWO MINDS — 実機診断表示（?debug=1 のときだけ読み込まれる。通常のプレイでは使わない）
// 画面の表示領域・安全領域・キーボード・入力状態・会話の状態を、画面の隅に表示する。
// 最初は 1 行に畳んで表示する（ゲームの操作を邪魔しない）。タップで広げる / 畳む。長押し（0.6 秒）で内容をクリップボードにコピーする。

export function startDebug({ el, engine, presence, events, measureKeyboard, keyboardAdjust }) {
  // env(safe-area-inset-*) の実際の値を読むための、見えない要素
  const probe = document.createElement('div');
  probe.className = 'debug-probe';
  document.body.appendChild(probe);

  const panel = document.createElement('div');
  panel.id = 'debugPanel';
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);
  let compact = true;
  let pressTimer = null;
  panel.addEventListener('click', () => {
    compact = !compact;
    render();
  });
  panel.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(() => navigator.clipboard?.writeText(text()).then(() => flash('copied')).catch(() => flash('copy failed')), 600);
  });
  panel.addEventListener('pointerup', () => clearTimeout(pressTimer));
  let flashMsg = '';
  const flash = (m) => {
    flashMsg = m;
    setTimeout(() => (flashMsg = ''), 1500);
  };

  const mode = () => {
    for (const m of ['fullscreen', 'standalone', 'minimal-ui']) if (matchMedia(`(display-mode: ${m})`).matches) return m;
    return 'browser';
  };
  const r = (n) => (typeof n === 'number' ? Math.round(n * 10) / 10 : String(n));
  const rect = (node) => {
    if (!node) return '-';
    const b = node.getBoundingClientRect();
    return `${r(b.top)}..${r(b.bottom)} (h${r(b.height)})`;
  };

  function rows() {
    const vv = window.visualViewport;
    const cs = getComputedStyle(probe);
    const ps = presence.s;
    return [
      ['display-mode', `${mode()}${navigator.standalone ? ' (navigator.standalone)' : ''}`],
      ['inner W×H', `${innerWidth}×${innerHeight}`],
      ['screen W×H', `${screen.width}×${screen.height}`],
      ['outerHeight', outerHeight],
      ['docEl clientH', document.documentElement.clientHeight],
      ['vv W×H', vv ? `${r(vv.width)}×${r(vv.height)}` : 'n/a'],
      ['vv offsetTop', vv ? r(vv.offsetTop) : 'n/a'],
      ['vv pageTop', vv ? r(vv.pageTop) : 'n/a'],
      ['vv scale', vv ? r(vv.scale) : 'n/a'],
      ['scrollY', r(window.scrollY)],
      ['safe top/bottom', `${cs.paddingTop} / ${cs.paddingBottom}`],
      ['safe left/right', `${cs.paddingLeft} / ${cs.paddingRight}`],
      ['keyboard', `${ps.keyboard ? 'shown' : 'hidden'} (now ${measureKeyboard() ? 'shown' : 'hidden'}, adjust ${keyboardAdjust ? 'on' : 'off'}, kbd class ${el.app.classList.contains('kbd')})`],
      ['.app', rect(el.app)],
      ['topbar', rect(document.querySelector('.topbar'))],
      ['controls', rect(document.querySelector('.controls'))],
      ['input state', `focused=${ps.focused} typing=${presence.typing} holding=${ps.holding} composing=${ps.composing} hidden=${ps.hidden} sending=${ps.sending} suppressed=${ps.suppressed}`],
      ['engine', `running=${engine.running} held=${engine.held} status=${el.status.dataset.state} current=${engine.current ? `${engine.current.idx}/${engine.current.lines.length}` : '-'} next=${engine.next ? engine.next.lines.length : '-'} inflight=${engine.inflight ? engine.inflight.rid : '-'}`],
      ['activeElement', document.activeElement?.id || document.activeElement?.tagName || '-'],
      ['orientation', `${screen.orientation?.type || (innerWidth > innerHeight ? 'landscape' : 'portrait')} dpr=${devicePixelRatio}`],
    ];
  }
  function text() {
    const now = performance.now();
    return [...rows().map(([k, v]) => `${k}: ${v}`), '--- events', ...events.map((e) => `${r((now - e.t) / 1000)}s ago  ${e.m}`), `ua: ${navigator.userAgent}`].join('\n');
  }
  function render() {
    if (compact) {
      const vv = window.visualViewport;
      panel.textContent = `${mode()} in${innerHeight} scr${screen.height} vv${vv ? Math.round(vv.height) : '-'}+${vv ? Math.round(vv.offsetTop) : '-'} sY${Math.round(scrollY)} kb${presence.s.keyboard ? 1 : 0} hold${presence.s.holding ? 1 : 0}`;
    } else {
      panel.textContent = (flashMsg ? `[${flashMsg}]\n` : '') + text();
    }
  }
  render();
  setInterval(render, 250);
  window.visualViewport?.addEventListener('resize', render);
  window.visualViewport?.addEventListener('scroll', render);
}
