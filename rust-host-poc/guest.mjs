const output = id => document.getElementById(id);
const state = window.pocFixtureState = {
  clicks: 0, submissions: 0, trustedEnters: 0, untrustedEnters: 0,
  drops: 0, ticks: 0, lastEvent: null, lastPointer: null, permission: 'pending',
};

function render() {
  output('click-count').value = state.clicks;
  output('submission-count').value = state.submissions;
  output('trusted-count').value = state.trustedEnters;
  output('drop-count').value = state.drops;
  output('last-event').textContent = state.lastEvent ? JSON.stringify(state.lastEvent, null, 2) : '尚未收到 Enter。';
  output('viewport-size').textContent = `guest 视口 ${innerWidth} × ${innerHeight} CSS px · DPR ${devicePixelRatio}`;
  output('permission-state').textContent = `guest 宿主命令权限：${state.permission}`;
}

output('guest-click').addEventListener('click', () => { state.clicks += 1; render(); });
document.addEventListener('pointerdown', event => {
  state.lastPointer = { type: event.pointerType, trusted: event.isTrusted, x: event.clientX, y: event.clientY };
});
output('guest-editor').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  state.lastEvent = { key: event.key, code: event.code, trusted: event.isTrusted, composing: event.isComposing };
  if (event.isTrusted) { state.trustedEnters += 1; state.submissions += 1; }
  else state.untrustedEnters += 1;
  render();
});
output('drag-chip').addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', 'R1-local-drag'); });
output('drop-zone').addEventListener('dragover', event => event.preventDefault());
output('drop-zone').addEventListener('drop', event => {
  event.preventDefault();
  if (event.dataTransfer.getData('text/plain') === 'R1-local-drag') { state.drops += 1; render(); }
});
addEventListener('resize', render);
setInterval(() => { state.ticks += 1; }, 1000);

// A bundled guest shares the application origin but still has no host capability.
// This is a runtime negative test, not a substitute for the native caller guard.
const invoke = window.__TAURI__?.core?.invoke;
if (invoke) {
  invoke('poc_info').then(() => {
    state.permission = 'UNEXPECTED ALLOW — fail R1';
    render();
  }).catch(() => { state.permission = 'denied'; render(); });
} else state.permission = 'bridge unavailable';
render();
