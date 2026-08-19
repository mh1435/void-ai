// One shared object for the handful of facts every view wants to know.
export const state = {
  authenticated: false,
  username: '',
  userId: '',
  gateRequired: false,
  gateOpen: true,
  usingProxy: false,
};

export function setSession(session) {
  state.authenticated = !!session.authenticated;
  state.username = session.username || '';
  state.userId = session.user_id || '';
  state.gateRequired = !!session.gate_required;
  state.gateOpen = !!session.gate_open;
  state.usingProxy = !!session.proxy;
  document.dispatchEvent(new CustomEvent('loop:session'));
}
