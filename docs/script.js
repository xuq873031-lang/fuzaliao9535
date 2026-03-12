// ============================
// 真实后端对接版（FastAPI + WebSocket）
// ============================

const STORAGE_KEYS = {
  token: 'chatwave_token',
  theme: 'chatwave_theme',
  apiBase: 'chat_api_base',
  wsBase: 'chat_ws_base'
};
const CHAT_CONFIG = window.__CHAT_CONFIG || {};
const DEFAULT_API_BASE = String(
  CHAT_CONFIG.API_BASE || 'https://web-production-afb64.up.railway.app'
).trim().replace(/\/$/, '');
const DEFAULT_WS_BASE = String(
  CHAT_CONFIG.WS_BASE || DEFAULT_API_BASE.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://')
).trim().replace(/\/$/, '');
const API_BASE_CANDIDATES = Array.from(new Set(
  [
    DEFAULT_API_BASE,
    'https://web-production-afb64.up.railway.app',
    'https://web-production-be9f.up.railway.app',
    'https://web-production-f9619e.up.railway.app'
  ]
    .map((x) => String(x || '').trim().replace(/\/$/, ''))
    .filter((x) => /^https?:\/\//i.test(x))
));
const APP_BUILD = '20260311_ui6';
const SHOW_DEBUG_BADGE = false;
const ENABLE_IN_APP_ADMIN_VIEW = false;
const SCROLL_DEBUG = !!CHAT_CONFIG.DEBUG_SCROLL;
const MESSAGE_RENDER_INITIAL_LIMIT = 80;
const MESSAGE_RENDER_STEP = 50;
const MESSAGE_DOM_HARD_LIMIT = 220;
const WS_MESSAGE_BATCH_CHUNK = 120;

const DEFAULT_AVATAR =
  'data:image/svg+xml;base64,' +
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" fill="#229ed9"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-size="28">U</text></svg>`);

const EMOJIS = ['😀', '😁', '😂', '😊', '😍', '😎', '🤔', '😭', '👍', '🎉', '❤️', '🔥'];

let appState = {
  currentUser: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  incomingRequestHistory: [],
  outgoingRequestHistory: [],
  friendRemarks: {},
  userMap: {},
  onlineUserIds: new Set(),
  conversations: [],
  activeConversationId: null,
  currentView: 'messagesView',
  editingMessageId: null,
  editingOwnMessageId: null,
  replyingToMessage: null,
  actionTargetMessage: null,
  forwardingMessage: null,
  forwardingMessages: [],
  forwardTargetKeyword: '',
  forwardSelectedRoomIds: new Set(),
  ws: null,
  wsReconnectTimer: null,
  wsReconnectTried: false,
  pendingAvatarBase64: null,
  loadingMore: false,
  roomPollTimer: null,
  roomPollInFlight: false,
  roomPollRoomId: null,
  lastMessageIdByRoom: {},
  lastSentAtByRoom: {},
  unreadPollTimer: null,
  conversationRenderQueued: false,
  messageAppendQueued: false,
  pendingMessageAppendByRoom: {},
  pendingAutoScrollByRoom: {},
  wsMessageBatchByRoom: {},
  wsMessageBatchTimer: null,
  conversationContextRoomId: null,
  userNearBottom: true,
  lastSoundAt: 0,
  audioCtx: null,
  readAckTimer: null,
  roomMuteStateByRoom: {},
  roomMyMemberMetaByRoom: {},
  messageRenderLimitByRoom: {},
  pinnedRoomOrder: [],
  emojiPanelOpen: false,
  conversationFilter: 'all',
  conversationSearchKeyword: '',
  managingGroupId: null,
  mentionCandidates: [],
  localFriendKeyword: '',
  newFriendTab: 'incoming',
  pendingMessageSeq: 0,
  activeFriendProfileId: null,
  managingGroupMembers: [],
  groupMemberSearchKeyword: '',
  multiSelectMode: false,
  multiSelectedMessageIds: new Set(),
  localTypingTimer: null,
  localTypingActive: false,
  call: {
    status: 'idle', // idle|ringing|incoming|connecting|active|ended
    mode: null, // audio|video
    callId: null,
    roomId: null,
    peerUserId: null,
    peerName: '',
    isOutgoing: false,
    muted: false,
    cameraOff: false,
    speakerOn: false,
    speakerSupported: false,
    pendingInvite: null,
    pendingCandidates: [],
    pc: null,
    localStream: null,
    remoteStream: null
  }
};

// ============================
// 工具方法
// ============================
function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token);
}

function setToken(token) {
  localStorage.setItem(STORAGE_KEYS.token, token);
}

function clearToken() {
  localStorage.removeItem(STORAGE_KEYS.token);
}

function getApiBase() {
  const stored = String(localStorage.getItem(STORAGE_KEYS.apiBase) || '').trim().replace(/\/$/, '');
  if (!stored || !/^https?:\/\//i.test(stored)) {
    localStorage.setItem(STORAGE_KEYS.apiBase, DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
  if (!API_BASE_CANDIDATES.includes(stored)) {
    localStorage.setItem(STORAGE_KEYS.apiBase, DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
  return stored;
}

function getWsBase() {
  const stored = String(localStorage.getItem(STORAGE_KEYS.wsBase) || '').trim().replace(/\/$/, '');
  if (stored && /^wss?:\/\//i.test(stored)) return stored;
  const fromApi = getApiBase().replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
  return fromApi || DEFAULT_WS_BASE;
}

function setApiBase(base) {
  const normalized = String(base || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(normalized)) return;
  localStorage.setItem(STORAGE_KEYS.apiBase, normalized);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureReachableApiBase() {
  const tried = [];
  const candidates = [getApiBase(), ...API_BASE_CANDIDATES.filter((x) => x !== getApiBase())];
  for (const base of candidates) {
    tried.push(base);
    try {
      const res = await fetchWithTimeout(`${base}/health`, { method: 'GET', cache: 'no-store' }, 7000);
      if (res && res.ok) {
        if (base !== getApiBase()) {
          setApiBase(base);
        }
        return { ok: true, base };
      }
    } catch (_) {
      // try next candidate
    }
  }
  return { ok: false, tried };
}

function getPinnedStorageKey() {
  const uid = appState.currentUser?.id || 'guest';
  return `chat_pinned_rooms_${uid}`;
}

function loadPinnedRoomOrder() {
  try {
    const raw = localStorage.getItem(getPinnedStorageKey());
    const arr = JSON.parse(raw || '[]');
    appState.pinnedRoomOrder = Array.isArray(arr)
      ? arr.map((x) => Number(x)).filter((x) => Number.isFinite(x))
      : [];
  } catch (_) {
    appState.pinnedRoomOrder = [];
  }
}

function savePinnedRoomOrder() {
  try {
    localStorage.setItem(getPinnedStorageKey(), JSON.stringify(appState.pinnedRoomOrder));
  } catch (_) {
    // ignore storage errors
  }
}

function isConversationPinned(conv) {
  return !!conv && appState.pinnedRoomOrder.includes(Number(conv.id));
}

function getPinnedIndex(roomId) {
  return appState.pinnedRoomOrder.indexOf(Number(roomId));
}

function setMessageRenderLimit(roomId, limit) {
  if (!roomId) return;
  appState.messageRenderLimitByRoom[roomId] = Math.max(MESSAGE_RENDER_INITIAL_LIMIT, Number(limit) || MESSAGE_RENDER_INITIAL_LIMIT);
}

function getMessageRenderLimit(roomId) {
  if (!roomId) return MESSAGE_RENDER_INITIAL_LIMIT;
  const v = Number(appState.messageRenderLimitByRoom[roomId] || 0);
  if (v > 0) return v;
  appState.messageRenderLimitByRoom[roomId] = MESSAGE_RENDER_INITIAL_LIMIT;
  return MESSAGE_RENDER_INITIAL_LIMIT;
}

function getHiddenMessageCount(conv) {
  if (!conv) return 0;
  return Math.max(0, conv.messages.length - getMessageRenderLimit(conv.id));
}

function getRenderableMessages(conv) {
  if (!conv) return [];
  const limit = getMessageRenderLimit(conv.id);
  if (conv.messages.length <= limit) return conv.messages;
  return conv.messages.slice(-limit);
}

function toggleConversationPin(roomId) {
  const id = Number(roomId);
  if (!id) return;
  const idx = appState.pinnedRoomOrder.indexOf(id);
  if (idx >= 0) {
    appState.pinnedRoomOrder.splice(idx, 1);
  } else {
    appState.pinnedRoomOrder.unshift(id);
  }
  savePinnedRoomOrder();
  renderConversationList();
}

function applyConversationLocalState() {
  const currentIds = new Set(appState.conversations.map((c) => Number(c.id)));
  appState.pinnedRoomOrder = appState.pinnedRoomOrder.filter((id) => currentIds.has(Number(id)));
  appState.conversations.forEach((conv) => {
    conv.isPinned = isConversationPinned(conv);
    if (!appState.messageRenderLimitByRoom[conv.id]) {
      appState.messageRenderLimitByRoom[conv.id] = MESSAGE_RENDER_INITIAL_LIMIT;
    }
  });
}

function renderApiBaseIndicator() {
  if (!SHOW_DEBUG_BADGE) {
    const old = document.getElementById('apiBaseIndicator');
    if (old) old.remove();
    return;
  }
  const host = new URL(getApiBase()).host;
  let el = document.getElementById('apiBaseIndicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'apiBaseIndicator';
    el.style.position = 'fixed';
    el.style.right = '10px';
    el.style.bottom = '10px';
    el.style.zIndex = '2000';
    el.style.fontSize = '11px';
    el.style.padding = '4px 8px';
    el.style.borderRadius = '10px';
    el.style.background = 'rgba(0,0,0,0.55)';
    el.style.color = '#fff';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
  }
  el.textContent = `v${APP_BUILD} | API: ${host}`;
}

// PWA 注册：仅做非侵入式增强，失败不影响登录/聊天主流程
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) return;

  const basePath = location.pathname.includes('/fuzaliao9535') ? '/fuzaliao9535' : '';
  const swUrl = `${basePath}/service-worker.js?v=${APP_BUILD}`;
  try {
    await navigator.serviceWorker.register(swUrl, { scope: `${basePath}/` || '/' });
  } catch (err) {
    console.warn('[PWA] service worker register failed:', err.message);
  }
}

function showLoginBy401(reason) {
  console.warn('鉴权失败，返回登录页:', reason);
  clearToken();
  showAuth();
  switchAuthPage('login');
}

function forceLogoutByAdmin(reason) {
  const msg = reason || '账号已被管理员禁用，无法继续使用';
  console.warn('账号被强制下线:', msg);
  if (appState.ws) {
    appState.ws.onclose = null;
    try { appState.ws.close(); } catch (_) {}
    appState.ws = null;
  }
  if (appState.wsReconnectTimer) {
    clearTimeout(appState.wsReconnectTimer);
    appState.wsReconnectTimer = null;
  }
  stopRoomPolling();
  stopUnreadPolling();
  clearToken();
  showAuth();
  switchAuthPage('login');
  alert(msg);
}

function cleanupStuckUiOverlay() {
  const hasVisibleModal = !!document.querySelector('.modal.show');
  if (!hasVisibleModal) {
    document.querySelectorAll('.modal-backdrop').forEach((el) => el.remove());
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('overflow');
    document.body.style.removeProperty('padding-right');
    document.body.style.removeProperty('paddingRight');
  }

  if (appState.call?.status === 'idle') {
    const incoming = document.getElementById('incomingCallPanel');
    const active = document.getElementById('activeCallPanel');
    if (incoming) incoming.classList.add('d-none');
    if (active) active.classList.add('d-none');
  }
}

function bindGlobalOverlayGuards() {
  document.addEventListener('hidden.bs.modal', () => {
    setTimeout(cleanupStuckUiOverlay, 0);
  });
  document.addEventListener('shown.bs.modal', () => {
    setTimeout(() => {
      const backdrops = Array.from(document.querySelectorAll('.modal-backdrop'));
      if (backdrops.length > 1) {
        backdrops.slice(0, -1).forEach((el) => el.remove());
      }
    }, 0);
  });
}

function hideModalAndWait(modalId, timeout = 320) {
  const el = document.getElementById(modalId);
  if (!el) return Promise.resolve();
  const instance = bootstrap.Modal.getInstance(el);
  if (!instance) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanupStuckUiOverlay();
      resolve();
    };
    el.addEventListener('hidden.bs.modal', finish, { once: true });
    instance.hide();
    setTimeout(finish, timeout);
  });
}

function normalizePhone(input) {
  return String(input || '').trim();
}

function translateErrorDetail(detail) {
  const raw = String(detail || '').trim();
  if (!raw) return '请求失败';
  const normalized = raw.toLowerCase();
  if (normalized === 'not found') return '资源不存在';
  if (normalized.includes('invalid username or password')) return '账号或密码错误';
  if (normalized.includes('missing authorization') || normalized.includes('not authenticated')) return '登录状态已失效，请重新登录';
  if (normalized.includes('no permission') || normalized.includes('forbidden')) return '你没有权限执行该操作';
  if (normalized.includes('already friend')) return '你们已经是好友';
  if (normalized.includes('you are muted in this group')) return '你已被群主禁言';
  if (normalized.includes('发言过快')) return raw;
  if (normalized.includes('group members')) return '群成员之间不可直接互加好友';
  if (normalized.includes('room not found')) return '会话不存在';
  if (normalized.includes('user not found')) return '用户不存在';
  if (normalized.includes('too many requests')) return '请求过于频繁，请稍后重试';
  return raw;
}

function phoneToCompatEmail(phone) {
  const safe = String(phone || '').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  return `${safe}@account.local`;
}

function validateAccount(input) {
  const account = normalizePhone(input);
  if (account.length < 6) {
    throw new Error('账号长度至少 6 位');
  }
  if (/\s/.test(account)) {
    throw new Error('账号不能包含空格');
  }
  return account;
}

function formatTime(ts) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(ts));
  } catch (_) {
    return '';
  }
}

function formatConversationTime(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(ts));
  } catch (_) {
    return '';
  }
}

function updateAppViewportHeight() {
  const vh = window.visualViewport?.height || window.innerHeight || 0;
  if (!vh) return;
  document.documentElement.style.setProperty('--app-dvh', `${vh}px`);
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve(ev.target?.result || '');
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMessageContent(text) {
  const raw = String(text || '');
  const match = raw.match(/^!\[img\]\(([^)]+)\)$/);
  if (match) {
    const url = match[1].trim();
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img src="${safeUrl}" class="msg-image" alt="image" loading="lazy" decoding="async" /></a>`;
  }
  return applyAtMentionHighlight(raw).replaceAll('\n', '<br>');
}

function isImageMessageText(text) {
  return /^!\[img\]\(([^)]+)\)$/.test(String(text || ''));
}

function summarizeMessageText(text) {
  const raw = String(text || '');
  if (isImageMessageText(raw)) return '[图片]';
  return raw.replace(/\s+/g, ' ').slice(0, 36);
}

function canEditOwnMessage(msg) {
  if (!msg) return false;
  if (!appState.currentUser?.canUseEditFeature) return false;
  if (msg.senderId !== appState.currentUser?.id) return false;
  if (isImageMessageText(msg.text)) return false;
  return true;
}

function canRecallMessage(msg) {
  if (!msg || !appState.currentUser) return false;
  if (isImageMessageText(msg.text)) return false;
  if (String(msg.text || '').startsWith('[已撤回]')) return false;
  return Number(msg.senderId) === Number(appState.currentUser.id);
}

function canUseSuperDelete() {
  const me = appState.currentUser;
  if (!me) return false;
  return me.role === 'admin' || !!me.canKickMembers;
}

function toggleEmojiPanel(open) {
  const emojiBar = document.getElementById('emojiBar');
  const emojiToggleBtn = document.getElementById('emojiToggleBtn');
  if (!emojiBar) return;
  const shouldOpen = typeof open === 'boolean' ? open : emojiBar.classList.contains('d-none');
  emojiBar.classList.toggle('d-none', !shouldOpen);
  appState.emojiPanelOpen = shouldOpen;
  if (emojiToggleBtn) emojiToggleBtn.classList.toggle('active', shouldOpen);
}

function getRtcConfiguration() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    if (Array.isArray(window.CHAT_ICE_SERVERS) && window.CHAT_ICE_SERVERS.length) {
      return { iceServers: window.CHAT_ICE_SERVERS };
    }
    const raw = localStorage.getItem('chat_ice_servers');
    if (!raw) return { iceServers: fallback };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return { iceServers: fallback };
    return { iceServers: parsed };
  } catch (_) {
    return { iceServers: fallback };
  }
}

function getCallPeerUserId(conv) {
  if (!conv || !isDmConversation(conv)) return null;
  const me = appState.currentUser?.id;
  return conv.members.find((id) => id !== me) || null;
}

function getCallPeerName(peerUserId) {
  if (!peerUserId) return '对方';
  return getDisplayNameByUserId(peerUserId);
}

function getUnreadTotal() {
  return appState.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}

function getUserAvatarById(userId) {
  const user = appState.userMap[userId] || appState.friends.find((f) => f.id === userId);
  return user?.avatar || user?.avatar_base64 || DEFAULT_AVATAR;
}

function getConversationAvatar(conv) {
  if (conv.type === 'group') return conv.avatar || DEFAULT_AVATAR;
  const other = getOtherUserInPrivateConversation(conv);
  if (!other) return DEFAULT_AVATAR;
  return other.avatar || other.avatar_base64 || DEFAULT_AVATAR;
}

function updateFriendRequestBadges() {
  const count = (appState.incomingRequests || []).length;
  ['friendReqBadgeDesktop', 'friendReqBadgeDrawer', 'friendReqBadgeMobileTab'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(count);
    el.classList.toggle('d-none', count <= 0);
  });
}

function normalizeMessage(raw) {
  return {
    id: raw.id,
    senderId: raw.sender_id,
    replyToMessageId: raw.reply_to_message_id || null,
    replyToSenderId: raw.reply_to_sender_id || null,
    replyToContent: raw.reply_to_content || null,
    text: raw.content,
    createdAt: new Date(raw.created_at).getTime(),
    updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : null,
    editedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : null,
    editedByAdmin: !!raw.edited_by_admin,
    localPending: false,
    localFailed: false,
    localTempId: null
  };
}

function makeLocalPendingMessage(roomId, content, senderId, replyToMessage) {
  appState.pendingMessageSeq += 1;
  const now = Date.now();
  return {
    id: -(now + appState.pendingMessageSeq),
    roomId,
    senderId,
    replyToMessageId: replyToMessage?.id || null,
    replyToSenderId: replyToMessage?.senderId || null,
    replyToContent: replyToMessage?.text || null,
    text: content,
    createdAt: now,
    updatedAt: null,
    editedAt: null,
    editedByAdmin: false,
    localPending: true,
    localFailed: false,
    localTempId: `tmp-${roomId}-${now}-${appState.pendingMessageSeq}`
  };
}

function reconcilePendingMessage(conv, serverMsg) {
  if (!conv || !serverMsg) return false;
  const idx = conv.messages.findIndex((m) => m.localPending && !m.localFailed && m.senderId === serverMsg.senderId && m.text === serverMsg.text);
  if (idx >= 0) {
    const oldId = conv.messages[idx].id;
    conv.messages[idx] = { ...serverMsg, localPending: false, localFailed: false, localTempId: null };
    return oldId;
  }
  return false;
}

function markLatestPendingAsFailed(roomId) {
  const conv = findConversationById(Number(roomId));
  if (!conv) return;
  const pending = [...conv.messages]
    .reverse()
    .find((m) => m.localPending && !m.localFailed && Number(m.senderId) === Number(appState.currentUser?.id));
  if (!pending) return;
  pending.localPending = false;
  pending.localFailed = true;
  if (appState.activeConversationId === conv.id) {
    renderMessages({ autoScroll: false });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

function showAuth() {
  document.body.classList.remove('main-open');
  document.getElementById('authContainer').classList.remove('d-none');
  document.getElementById('mainContainer').classList.add('d-none');
}

function showMain() {
  document.body.classList.add('main-open');
  document.getElementById('authContainer').classList.add('d-none');
  document.getElementById('mainContainer').classList.remove('d-none');
}

function switchAuthPage(page) {
  document.getElementById('loginPage').classList.toggle('d-none', page !== 'login');
  document.getElementById('registerPage').classList.toggle('d-none', page !== 'register');
}

function setAuthLoading(loading, text = '正在恢复登录...') {
  const hint = document.getElementById('authLoadingHint');
  if (hint) {
    hint.textContent = text;
    hint.classList.toggle('d-none', !loading);
  }
}

function setButtonLoading(btn, loading, loadingText, normalText) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.textContent = loading ? loadingText : normalText;
}

function setConversationFilter(filter) {
  const allowed = ['all', 'unread', 'mention'];
  appState.conversationFilter = allowed.includes(filter) ? filter : 'all';
  const map = {
    all: 'conversationTabAll',
    unread: 'conversationTabUnread',
    mention: 'conversationTabMention'
  };
  Object.entries(map).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', key === appState.conversationFilter);
  });
  renderConversationList();
}

function setFriendsSubView(mode = 'main') {
  const friendsView = document.getElementById('friendsView');
  if (!friendsView) return;
  const topbar = friendsView.querySelector('.contacts-topbar');
  const localSearchWrap = document.getElementById('contactsLocalSearchWrap');
  const layout = friendsView.querySelector('.contacts-layout');
  const toolsPanel = document.getElementById('friendToolsPanel');
  const addPanel = document.getElementById('addFriendPanel');

  const isMain = mode === 'main';
  const isNewFriend = mode === 'new-friend';
  const isAddFriend = mode === 'add-friend';

  if (topbar) topbar.classList.toggle('d-none', !isMain);
  if (localSearchWrap) localSearchWrap.classList.toggle('d-none', !isMain || localSearchWrap.classList.contains('d-none'));
  if (layout) layout.classList.toggle('d-none', !isMain);
  if (toolsPanel) toolsPanel.classList.toggle('d-none', !isNewFriend);
  if (addPanel) addPanel.classList.toggle('d-none', !isAddFriend);
}

function resetFriendsMainView() {
  setFriendsSubView('main');
}

function switchView(viewId, options = {}) {
  if (viewId === 'adminView' && !ENABLE_IN_APP_ADMIN_VIEW) {
    viewId = 'messagesView';
  }
  const keepRoom = !!options.keepRoom;
  const silentRefresh = !!options.silentRefresh;
  if (viewId === 'messagesView' && !keepRoom) {
    appState.activeConversationId = null;
  }

  appState.currentView = viewId;
  document.querySelectorAll('.view-section').forEach((el) => el.classList.add('d-none'));
  document.getElementById(viewId).classList.remove('d-none');

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  document.querySelectorAll('.mobile-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  if (viewId === 'messagesView') {
    renderConversationList();
    renderMessages();
    if (appState.activeConversationId) startRoomPolling(appState.activeConversationId);
    else stopRoomPolling();
    if (silentRefresh) return;
    refreshRoomsAndMessages()
      .then(() => {
        renderConversationList();
        renderMessages();
      })
      .catch((err) => console.warn('刷新会话失败', err.message));
  } else if (viewId === 'friendsView') {
    stopRoomPolling();
    resetFriendsMainView();
    renderFriendsLoadingState();
    Promise.all([refreshFriends(), refreshFriendRequests(), refreshFriendRemarks()])
      .then(() => {
        renderFriendList();
        renderFriendRequestLists();
      })
      .catch((err) => {
        console.warn('刷新好友数据失败', err.message);
        renderFriendsErrorState(err.message);
      });
  } else if (viewId === 'adminView') {
    stopRoomPolling();
    loadAdminUsers().catch((err) => console.warn('加载后台用户失败', err.message));
  } else {
    stopRoomPolling();
  }
}

// ============================
// API 请求层
// ============================
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  const hasJsonBody = !!options.body && typeof options.body === 'string';
  if (hasJsonBody && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  if (token) headers.Authorization = `Bearer ${token}`;
  const request = {
    ...options,
    headers
  };
  const bases = [getApiBase(), ...API_BASE_CANDIDATES.filter((x) => x !== getApiBase())];
  let res = null;
  let base = getApiBase();
  let lastNetworkErr = null;
  for (let i = 0; i < bases.length; i += 1) {
    base = bases[i];
    try {
      res = await fetchWithTimeout(`${base}${path}`, request, 15000);
      if (base !== getApiBase()) setApiBase(base);
      break;
    } catch (err) {
      lastNetworkErr = err;
    }
  }

  if (!res) {
    const err = new Error(`网络连接失败：无法连接后端 (${getApiBase()})`);
    err.status = 0;
    err.detail = lastNetworkErr?.message || 'NetworkError';
    throw err;
  }

  if (!res.ok) {
    let detail = `请求失败(${res.status})`;
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const err = await res.json();
        detail = err.detail || detail;
      } else {
        const txt = await res.text();
        detail = txt || detail;
      }
    } catch (_) {
      // ignore parse failure
    }

    detail = translateErrorDetail(detail);
    if (res.status === 401) {
      showLoginBy401(detail);
    } else if (res.status === 403 && /(账号已注销|账号已封禁|账号已被管理员禁用)/.test(String(detail))) {
      forceLogoutByAdmin(detail);
    }
    const err = new Error(detail);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

async function apiLogin(phone, password) {
  const normalizedPhone = validateAccount(phone);
  // 兼容当前后端：account -> username
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: normalizedPhone, password })
  });
}

async function apiRegister(phone, password) {
  const normalizedPhone = validateAccount(phone);
  // 兼容当前后端：需 username+email+password
  return apiFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: normalizedPhone,
      email: phoneToCompatEmail(normalizedPhone),
      password
    })
  });
}

async function apiGetMe() {
  return apiFetch('/api/users/me');
}

async function apiUpdateMe(payload) {
  return apiFetch('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

async function apiSearchUsers(keyword) {
  const q = String(keyword || '').trim();
  const base = getApiBase();
  try {
    const parseRows = (data) => {
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.items)) return data.items;
      if (data && Array.isArray(data.results)) return data.results;
      if (data && Array.isArray(data.data)) return data.data;
      return [];
    };
    // 兼容不同后端实现：优先 q，其次 keyword/account
    const candidates = [
      `/api/users/search?q=${encodeURIComponent(q)}`,
      `/api/users/search?keyword=${encodeURIComponent(q)}`,
      `/api/users/search?account=${encodeURIComponent(q)}`
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const data = await apiFetch(candidates[i]);
        const rows = parseRows(data);
        console.log(`[search] base=${base} q=${q} status=200`);
        if (rows.length || i === candidates.length - 1) return rows;
      } catch (innerErr) {
        if (i === candidates.length - 1) throw innerErr;
      }
    }
    return [];
  } catch (err) {
    console.warn(`[search] base=${base} q=${q} status=${err.status || 'ERR'}`);
    throw err;
  }
}

async function apiGetFriends() {
  return apiFetch('/api/friends');
}

async function apiAddFriend(friendId) {
  return apiFetch(`/api/friends/${friendId}`, { method: 'POST' });
}

async function apiRemoveFriend(friendId, options = {}) {
  const deletePeerMessages = !!options.deletePeerMessages;
  const query = deletePeerMessages ? '?delete_peer_messages=true' : '';
  return apiFetch(`/api/friends/${friendId}${query}`, { method: 'DELETE' });
}

async function apiSendFriendRequest(toUserId, message = '') {
  return apiFetch('/api/friend-requests', {
    method: 'POST',
    body: JSON.stringify({ to_user_id: toUserId, message })
  });
}

async function apiGetIncomingFriendRequests(status = 'pending') {
  return apiFetch(`/api/friend-requests/incoming?status=${encodeURIComponent(status)}`);
}

async function apiGetOutgoingFriendRequests(status = 'pending') {
  return apiFetch(`/api/friend-requests/outgoing?status=${encodeURIComponent(status)}`);
}

async function apiAcceptFriendRequest(requestId) {
  return apiFetch(`/api/friend-requests/${requestId}/accept`, { method: 'POST' });
}

async function apiRejectFriendRequest(requestId) {
  return apiFetch(`/api/friend-requests/${requestId}/reject`, { method: 'POST' });
}

async function apiGetFriendRemarks() {
  return apiFetch('/api/friends/remarks');
}

async function apiSetFriendRemark(friendId, remark) {
  return apiFetch(`/api/friends/${friendId}/remark`, {
    method: 'PUT',
    body: JSON.stringify({ remark })
  });
}

async function apiGetOnlinePresence() {
  return apiFetch('/api/presence/online');
}

async function apiGetUserPresence(userId) {
  return apiFetch(`/api/presence/${userId}`);
}

async function apiGetRooms() {
  return apiFetch('/api/rooms');
}

async function apiCreateRoom(name, memberIds) {
  return apiFetch('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, member_ids: memberIds })
  });
}

async function apiGetRoomMembers(roomId) {
  return apiFetch(`/api/rooms/${roomId}/members`);
}

async function apiAddRoomMember(roomId, userId) {
  return apiFetch(`/api/rooms/${roomId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId })
  });
}

async function apiRemoveRoomMember(roomId, userId) {
  return apiFetch(`/api/rooms/${roomId}/members/${userId}`, { method: 'DELETE' });
}

async function apiMuteRoomMember(roomId, userId) {
  return apiFetch(`/api/rooms/${roomId}/members/${userId}/mute`, { method: 'POST' });
}

async function apiUnmuteRoomMember(roomId, userId) {
  return apiFetch(`/api/rooms/${roomId}/members/${userId}/mute`, { method: 'DELETE' });
}

async function apiSetRoomMemberPermissions(roomId, userId, canKick, canMute) {
  return apiFetch(`/api/rooms/${roomId}/members/${userId}/permissions`, {
    method: 'PUT',
    body: JSON.stringify({
      can_kick: !!canKick,
      can_mute: !!canMute
    })
  });
}

async function apiSetRoomRateLimit(roomId, seconds) {
  return apiFetch(`/api/rooms/${roomId}/rate-limit`, {
    method: 'PUT',
    body: JSON.stringify({ seconds: Number(seconds || 0) })
  });
}

async function apiDeleteRoomMemberMessages(roomId, userId) {
  return apiFetch(`/api/rooms/${roomId}/members/${userId}/messages`, { method: 'DELETE' });
}

async function apiGetRoomMuteList(roomId) {
  return apiFetch(`/api/rooms/${roomId}/mute-list`);
}

async function apiUpdateRoom(roomId, payload) {
  return apiFetch(`/api/rooms/${roomId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload || {})
  });
}

async function apiAdminListUsers() {
  return apiFetch('/api/admin/users');
}

async function apiAdminResetPassword(userId, newPassword, confirmPassword) {
  return apiFetch(`/api/admin/users/${userId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({
      new_password: newPassword,
      confirm_password: confirmPassword
    })
  });
}

async function apiGetRoomMessages(roomId, limit = 50) {
  return apiFetch(`/api/rooms/${roomId}/messages?limit=${limit}`);
}

async function apiGetRoomMessagesBefore(roomId, beforeId, limit = 50) {
  return apiFetch(`/api/rooms/${roomId}/messages?before_id=${beforeId}&limit=${limit}`);
}

async function apiGetUnreadCounts() {
  return apiFetch('/api/rooms/unread');
}

async function apiMarkRoomRead(roomId, lastReadMessageId) {
  return apiFetch(`/api/rooms/${roomId}/read`, {
    method: 'POST',
    body: JSON.stringify({ last_read_message_id: lastReadMessageId || null })
  });
}

async function apiEditMessage(messageId, content) {
  return apiFetch(`/api/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content })
  });
}

async function apiRecallMessage(messageId) {
  return apiFetch(`/api/messages/${messageId}/recall`, { method: 'POST' });
}

async function apiSuperDeleteMessage(messageId) {
  return apiFetch(`/api/messages/${messageId}/super-delete`, { method: 'DELETE' });
}

async function apiUploadImage(file) {
  const form = new FormData();
  form.append('file', file);
  return apiFetch('/api/uploads/images', {
    method: 'POST',
    body: form
  });
}

async function apiSendMessage(roomId, content, extra = {}) {
  const replyToMessageId = extra.replyToMessageId || null;
  const wsSent = sendWsMessage({
    action: 'send_message',
    room_id: roomId,
    content,
    reply_to_message_id: replyToMessageId
  });
  if (wsSent) return { ok: true, via: 'ws' };
  const message = await apiFetch(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, reply_to_message_id: replyToMessageId })
  });
  return { ok: true, via: 'http', message };
}

async function apiSendMessageDirect(roomId, content) {
  return apiFetch(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content })
  });
}

// ============================
// 数据同步与转换
// ============================
function mergeUserToMap(user) {
  if (!user) return;
  appState.userMap[user.id] = {
    id: user.id,
    username: user.username,
    nickname: user.nickname || user.username,
    email: user.email || '',
    avatar: user.avatar_base64 || DEFAULT_AVATAR,
    online: !!user.is_online,
    role: user.role || 'member'
  };
}

function roomToConversation(room) {
  return {
    id: room.id,
    type: room.type || room.room_type || 'group',
    name: room.name,
    title: room.title || room.name,
    avatar: room.avatar || null,
    members: room.member_ids || [],
    unreadCount: 0,
    messages: [],
    createdBy: room.created_by,
    memberCount: room.member_count || (room.member_ids || []).length,
    rateLimitSeconds: Number(room.rate_limit_seconds || 0),
    description: room.description || '',
    notice: room.notice || '',
    allowMemberFriendAdd: !!room.allow_member_friend_add,
    allowMemberInvite: !!room.allow_member_invite,
    inviteNeedApproval: room.invite_need_approval !== false,
    globalMute: !!room.global_mute,
    hasMore: true
  };
}

async function refreshFriends() {
  const friends = await apiGetFriends();
  appState.friends = friends.map((f) => ({
    id: f.id,
    username: f.username,
    nickname: f.nickname || f.username,
    online: !!f.is_online,
    avatar: f.avatar_base64 || appState.userMap[f.id]?.avatar || DEFAULT_AVATAR
  }));

  appState.friends.forEach((f) => {
    mergeUserToMap({
      id: f.id,
      username: f.username,
      nickname: f.nickname,
      email: '',
      avatar_base64: f.avatar,
      is_online: f.online,
      role: 'member'
    });
  });
}

async function refreshFriendRequests() {
  const [incomingPending, outgoingPending, incomingAccepted, incomingRejected, outgoingAccepted, outgoingRejected] = await Promise.all([
    apiGetIncomingFriendRequests('pending'),
    apiGetOutgoingFriendRequests('pending'),
    apiGetIncomingFriendRequests('accepted'),
    apiGetIncomingFriendRequests('rejected'),
    apiGetOutgoingFriendRequests('accepted'),
    apiGetOutgoingFriendRequests('rejected')
  ]);
  const mergedIncoming = [...(incomingPending || []), ...(incomingAccepted || []), ...(incomingRejected || [])];
  const mergedOutgoing = [...(outgoingPending || []), ...(outgoingAccepted || []), ...(outgoingRejected || [])];
  const uniqByIdDesc = (rows) => {
    const map = new Map();
    rows.forEach((r) => {
      if (!r || !r.id) return;
      if (!map.has(r.id)) map.set(r.id, r);
    });
    return [...map.values()].sort((a, b) => Number(new Date(b.created_at || 0)) - Number(new Date(a.created_at || 0)));
  };
  appState.incomingRequests = incomingPending || [];
  appState.outgoingRequests = outgoingPending || [];
  appState.incomingRequestHistory = uniqByIdDesc(mergedIncoming);
  appState.outgoingRequestHistory = uniqByIdDesc(mergedOutgoing);
  updateFriendRequestBadges();
}

async function refreshFriendRemarks() {
  const rows = await apiGetFriendRemarks();
  appState.friendRemarks = {};
  (rows || []).forEach((r) => {
    appState.friendRemarks[r.friend_id] = r.remark || '';
  });
}

async function refreshPresenceOnlineList() {
  const onlineList = await apiGetOnlinePresence();
  const onlineSet = new Set(onlineList.map((x) => x.id));
  appState.onlineUserIds = onlineSet;

  appState.friends = appState.friends.map((f) => ({ ...f, online: onlineSet.has(f.id) }));
  Object.keys(appState.userMap).forEach((idStr) => {
    const uid = Number(idStr);
    appState.userMap[uid].online = onlineSet.has(uid);
  });
}

async function refreshRoomsAndMessages() {
  const rooms = await apiGetRooms();
  appState.conversations = rooms.map(roomToConversation);

  await Promise.all(
    appState.conversations.map(async (conv) => {
      const msgs = await apiGetRoomMessages(conv.id, 50);
      // 后端默认倒序（新->旧），前端显示转换为正序（旧->新）
      conv.messages = msgs.map(normalizeMessage).reverse();
      conv.hasMore = msgs.length === 50;
    })
  );
  applyConversationLocalState();

  // 交互要求：不自动选中会话，必须用户主动点好友/会话进入聊天
  if (appState.activeConversationId && !findConversationById(appState.activeConversationId)) {
    appState.activeConversationId = null;
    stopRoomPolling();
    if (appState.currentView === 'messagesView') {
      switchView('friendsView');
    }
  }
}

async function refreshUnreadCounts() {
  const items = await apiGetUnreadCounts();
  const map = new Map(items.map((x) => [x.room_id, x.unread_count]));
  appState.conversations.forEach((conv) => {
    conv.unreadCount = map.get(conv.id) || 0;
  });
}

function getVisibleConversations() {
  const keyword = String(appState.conversationSearchKeyword || '').trim().toLowerCase();
  const mentionNick = String(appState.currentUser?.nickname || '').trim();
  const mentionUser = String(appState.currentUser?.username || '').trim();
  const mentionTokens = [mentionNick, mentionUser]
    .filter(Boolean)
    .map((x) => `@${x}`);
  return appState.conversations.filter((conv) => {
    if (appState.conversationFilter === 'unread' && !(conv.unreadCount > 0)) return false;
    if (appState.conversationFilter === 'mention') {
      if (!mentionTokens.length) return false;
      const hasMention = (conv.messages || []).some((m) => {
        const text = String(m.text || '');
        return mentionTokens.some((token) => text.includes(token));
      });
      if (!hasMention) return false;
    }
    if (!keyword) return true;
    const title = getConversationTitle(conv).toLowerCase();
    const lastMsg = conv.messages[conv.messages.length - 1];
    const preview = String(lastMsg?.text || '').toLowerCase();
    return title.includes(keyword) || preview.includes(keyword);
  });
}

function findConversationById(roomId) {
  return appState.conversations.find((c) => c.id === roomId);
}

function getOtherUserInPrivateConversation(conv) {
  const uid = appState.currentUser.id;
  const otherId = conv.members.find((id) => id !== uid);
  if (!otherId) return null;
  return appState.userMap[otherId] || appState.friends.find((f) => f.id === otherId) || null;
}

function getDisplayNameByUserId(userId) {
  const remark = appState.friendRemarks[userId];
  if (remark) return remark;
  const user = appState.userMap[userId] || appState.friends.find((f) => f.id === userId);
  if (!user) return `用户${userId}`;
  return user.nickname || user.username || `用户${userId}`;
}

// 群场景展示名：不暴露真实注册账号（username/ID）
function getGroupPublicDisplayNameByUserId(userId) {
  const remark = appState.friendRemarks[userId];
  if (remark) return remark;
  const user = appState.userMap[userId] || appState.friends.find((f) => f.id === userId);
  const nickname = (user?.nickname || '').trim();
  if (nickname) return nickname;
  return '群成员';
}

function getConversationTitle(conv) {
  if (conv.type === 'group') return conv.title || conv.name;
  const other = getOtherUserInPrivateConversation(conv);
  return other ? getDisplayNameByUserId(other.id) : conv.title || conv.name || '私聊';
}

function isDmConversation(conv) {
  return ['dm', 'direct', 'private'].includes(conv.type || conv.room_type);
}

function getFriendSortName(friend) {
  const name = (appState.friendRemarks[friend.id] || friend.nickname || friend.username || '').trim();
  return name || `用户${friend.id}`;
}

function sortFriendsAtoZ(friends) {
  return [...friends].sort((a, b) => {
    const an = getFriendSortName(a);
    const bn = getFriendSortName(b);
    return an.localeCompare(bn, ['zh-Hans-CN', 'en'], { sensitivity: 'base', numeric: true });
  });
}

function getFriendGroupKey(friend) {
  const raw = getFriendSortName(friend).trim();
  const first = raw.charAt(0).toUpperCase();
  if (first >= 'A' && first <= 'Z') return first;
  return '#';
}

function buildFriendGroups(friends) {
  const grouped = {};
  sortFriendsAtoZ(friends).forEach((friend) => {
    const key = getFriendGroupKey(friend);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(friend);
  });
  const keys = Object.keys(grouped).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });
  return { grouped, keys };
}

function applyMuteComposerState(conv) {
  const isGroup = !!(conv && conv.type === 'group');
  const roleMeta = isGroup ? appState.roomMyMemberMetaByRoom[conv.id] : null;
  const bypassGlobalMute = !!(roleMeta && (roleMeta.role === 'owner' || roleMeta.canKick || roleMeta.canMute));
  const globalMuted = !!(isGroup && conv.globalMute && !bypassGlobalMute);
  const muted = !!(isGroup && (appState.roomMuteStateByRoom[conv.id] === true || globalMuted));
  const hintBar = document.getElementById('muteHintBar');
  const input = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendMessageBtn');
  const uploadBtn = document.getElementById('uploadImageBtn');
  const emojiBar = document.getElementById('emojiBar');
  if (hintBar) hintBar.classList.toggle('d-none', !muted);
  if (input) {
    input.disabled = muted;
    input.placeholder = muted ? (globalMuted ? '该群已开启全员禁言' : '你已被群主禁言') : '输入消息...';
  }
  if (sendBtn) sendBtn.disabled = muted;
  if (uploadBtn) uploadBtn.disabled = muted;
  if (emojiBar) {
    emojiBar.querySelectorAll('button').forEach((btn) => {
      btn.disabled = muted;
    });
  }
  if (muted) hideMentionSuggestions();
}

async function refreshCurrentUserMuteState(roomId) {
  const conv = findConversationById(roomId);
  if (!conv || conv.type !== 'group') {
    if (roomId) appState.roomMuteStateByRoom[roomId] = false;
    if (roomId) delete appState.roomMyMemberMetaByRoom[roomId];
    return false;
  }
  try {
    const members = await apiGetRoomMembers(roomId);
    const me = (members || []).find((m) => Number(m.user_id) === Number(appState.currentUser?.id));
    const muted = !!me?.muted;
    appState.roomMuteStateByRoom[roomId] = muted;
    appState.roomMyMemberMetaByRoom[roomId] = {
      role: me?.role || 'member',
      canKick: !!me?.can_kick,
      canMute: !!me?.can_mute,
      muted
    };
    return muted;
  } catch (err) {
    console.warn('刷新禁言状态失败:', err.message);
    return !!appState.roomMuteStateByRoom[roomId];
  }
}

function canBypassGroupRateLimit(roomId) {
  const meta = appState.roomMyMemberMetaByRoom[roomId];
  if (!meta) return false;
  return meta.role === 'owner' || !!meta.canKick || !!meta.canMute;
}

function checkLocalGroupRateLimit(conv) {
  if (!conv || conv.type !== 'group') return { blocked: false };
  const seconds = Number(conv.rateLimitSeconds || 0);
  if (!seconds || seconds <= 0) return { blocked: false };
  if (canBypassGroupRateLimit(conv.id)) return { blocked: false };
  const last = Number(appState.lastSentAtByRoom[conv.id] || 0);
  const now = Date.now();
  const diff = now - last;
  if (diff >= seconds * 1000) return { blocked: false };
  const remain = Math.ceil((seconds * 1000 - diff) / 1000);
  return { blocked: true, message: `发言过快，请 ${remain} 秒后再试` };
}

function getDmConversationWithFriend(friendId) {
  return appState.conversations.find(
    (c) => isDmConversation(c) && c.members.includes(friendId) && c.members.includes(appState.currentUser.id)
  );
}

function getCurrentGroupMembersForMention(conv) {
  if (!conv || conv.type !== 'group') return [];
  const ids = conv.members || [];
  return ids
    .filter((id) => Number(id) !== Number(appState.currentUser?.id))
    .map((id) => ({
      id,
      name: getGroupPublicDisplayNameByUserId(id)
    }));
}

function extractMentionKeyword(text, caretPos) {
  const left = String(text || '').slice(0, caretPos);
  const at = left.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(left[at - 1])) return null;
  const keyword = left.slice(at + 1);
  if (/\s/.test(keyword)) return null;
  return { atIndex: at, keyword };
}

function hideMentionSuggestions() {
  const box = document.getElementById('mentionSuggestBox');
  if (!box) return;
  box.classList.add('d-none');
  box.innerHTML = '';
  appState.mentionCandidates = [];
}

function insertMentionToInput(user) {
  const input = document.getElementById('messageInput');
  if (!input || !user) return;
  const caretPos = input.selectionStart ?? input.value.length;
  const found = extractMentionKeyword(input.value, caretPos);
  if (!found) return;
  const before = input.value.slice(0, found.atIndex);
  const after = input.value.slice(caretPos);
  input.value = `${before}@${user.name} ${after}`;
  const newPos = `${before}@${user.name} `.length;
  input.setSelectionRange(newPos, newPos);
  input.focus();
  hideMentionSuggestions();
}

function renderMentionSuggestions(conv, keyword) {
  const box = document.getElementById('mentionSuggestBox');
  if (!box) return;
  const all = getCurrentGroupMembersForMention(conv);
  const kw = String(keyword || '').toLowerCase();
  const list = all.filter((m) => !kw || m.name.toLowerCase().includes(kw)).slice(0, 8);
  appState.mentionCandidates = list;
  if (!list.length) {
    hideMentionSuggestions();
    return;
  }
  box.innerHTML = '';
  list.forEach((m) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'list-group-item list-group-item-action';
    row.textContent = `@${m.name}`;
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', () => insertMentionToInput(m));
    box.appendChild(row);
  });
  box.classList.remove('d-none');
}

function applyAtMentionHighlight(text) {
  const escaped = escapeHtml(String(text || ''));
  return escaped.replace(/(^|\s)(@[^\s@]+)/g, '$1<span class="text-primary fw-semibold">$2</span>');
}

function getMessageScrollContainer() {
  const list = document.getElementById('messageList');
  if (!list) return null;
  const chatPane = list.closest('.chat-pane');
  if (!chatPane) return list;
  const hiddenByClass = chatPane.classList.contains('d-none');
  const hiddenByStyle = chatPane.style.display === 'none';
  if (hiddenByClass || hiddenByStyle) return null;
  return list;
}

function getScrollMetrics(el) {
  if (!el) return null;
  return {
    selector: el.id ? `#${el.id}` : (el.className ? `.${String(el.className).split(/\s+/).filter(Boolean).join('.')}` : el.tagName),
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: Math.round(el.scrollHeight),
    clientHeight: Math.round(el.clientHeight),
    roomId: appState.activeConversationId
  };
}

function isNearBottom(el, threshold = 220) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function debugScroll(event, extra = {}) {
  const listEl = getMessageScrollContainer();
  const metrics = getScrollMetrics(listEl) || {};
  const payload = {
    ts: Date.now(),
    event,
    roomId: appState.activeConversationId,
    nearBottom: isNearBottom(listEl, 220),
    ...metrics,
    ...extra
  };
  if (!appState.scrollTrace) appState.scrollTrace = [];
  appState.scrollTrace.push(payload);
  if (appState.scrollTrace.length > 120) appState.scrollTrace.shift();
  if (SCROLL_DEBUG) console.debug('[scroll]', payload);
}

window.__chatScrollProbe = function __chatScrollProbe() {
  const el = getMessageScrollContainer();
  const metrics = getScrollMetrics(el);
  return {
    found: !!el,
    nearBottom: isNearBottom(el, 220),
    metrics
  };
};

window.__chatScrollTrace = function __chatScrollTrace() {
  return (appState.scrollTrace || []).slice(-40);
};

function scrollMessagesToBottom(options = {}) {
  const { force = false, stickToBottom = false, reason = '' } = options;
  const listEl = getMessageScrollContainer();
  if (!listEl) return;
  const shouldStickBottom = force || stickToBottom || isNearBottom(listEl, 220);
  if (!shouldStickBottom) {
    debugScroll('skip', { reason, force, stickToBottom });
    return;
  }
  appState.userNearBottom = true;

  const applyBottom = (stage = 'apply') => {
    listEl.scrollTop = listEl.scrollHeight;
    debugScroll(stage, { reason, force, stickToBottom, after: getScrollMetrics(listEl) });
  };

  // 双帧 + 兜底定时，降低移动端高频追加时“滚动没落到底”的概率
  requestAnimationFrame(() => {
    applyBottom('raf1');
    requestAnimationFrame(() => applyBottom('raf2'));
  });
  setTimeout(() => applyBottom('t+36'), 36);

  // 运行时后效兜底：如果滚完又被后续布局/重渲染顶回去，再补一轮
  [50, 100, 200].forEach((ms) => {
    setTimeout(() => {
      const near = isNearBottom(listEl, 120);
      debugScroll('post-check', { reason, ms, near, current: getScrollMetrics(listEl) });
      if (!near && (force || appState.userNearBottom)) {
        applyBottom(`post-fix-${ms}`);
      }
    }, ms);
  });

  const pendingImages = Array.from(listEl.querySelectorAll('img')).filter((img) => !img.complete);
  pendingImages.forEach((img) => {
    img.addEventListener('load', () => {
      if (force || appState.userNearBottom || isNearBottom(listEl, 260)) {
        listEl.scrollTop = listEl.scrollHeight;
      }
    }, { once: true });
  });
}

function replaceMessageRowInView(conv, oldMessageId, newMessage) {
  const listEl = getMessageScrollContainer();
  if (!listEl || !conv || !newMessage) return;
  const oldRow = listEl.querySelector(`.msg-row[data-message-id="${oldMessageId}"]`);
  if (!oldRow) return;
  oldRow.replaceWith(safeBuildMessageRow(newMessage, conv));
}

function updateMessageRowInView(conv, message) {
  const listEl = getMessageScrollContainer();
  if (!listEl || !conv || !message) return;
  const row = listEl.querySelector(`.msg-row[data-message-id="${message.id}"]`);
  if (!row) return;
  row.replaceWith(safeBuildMessageRow(message, conv));
}

function removeMessageRowInView(messageId) {
  const listEl = getMessageScrollContainer();
  if (!listEl) return;
  const row = listEl.querySelector(`.msg-row[data-message-id="${messageId}"]`);
  if (row) row.remove();
}

function flushPendingMessageAppends() {
  appState.messageAppendQueued = false;
  const roomIds = Object.keys(appState.pendingMessageAppendByRoom);
  if (!roomIds.length) return;
  roomIds.forEach((roomIdStr) => {
    const roomId = Number(roomIdStr);
    const queue = appState.pendingMessageAppendByRoom[roomId];
    const shouldAutoScroll = !!appState.pendingAutoScrollByRoom[roomId];
    if (!Array.isArray(queue) || !queue.length) return;
    delete appState.pendingMessageAppendByRoom[roomId];
    delete appState.pendingAutoScrollByRoom[roomId];
    if (appState.currentView !== 'messagesView' || appState.activeConversationId !== roomId) return;
    const conv = findConversationById(roomId);
    if (!conv) return;
    appendMessagesToView(conv, queue, {
      autoScroll: shouldAutoScroll || appState.userNearBottom,
      stickToBottom: shouldAutoScroll
    });
  });
}

function queueMessageAppend(roomId, message, options = {}) {
  if (!roomId || !message) return;
  if (options.autoScroll) {
    appState.pendingAutoScrollByRoom[roomId] = true;
  }
  if (!appState.pendingMessageAppendByRoom[roomId]) appState.pendingMessageAppendByRoom[roomId] = [];
  appState.pendingMessageAppendByRoom[roomId].push(message);
  if (appState.messageAppendQueued) return;
  appState.messageAppendQueued = true;
  requestAnimationFrame(flushPendingMessageAppends);
}

function clearRoomRuntimeBuffers(roomId) {
  if (!roomId) return;
  delete appState.pendingMessageAppendByRoom[roomId];
  delete appState.pendingAutoScrollByRoom[roomId];
  delete appState.wsMessageBatchByRoom[roomId];
}

function handleConversationContextSwitch() {
  const currentRoomId = Number(appState.activeConversationId || 0) || null;
  if (appState.conversationContextRoomId === currentRoomId) return;

  const prevRoomId = appState.conversationContextRoomId;
  appState.conversationContextRoomId = currentRoomId;
  if (prevRoomId) clearRoomRuntimeBuffers(prevRoomId);

  if (appState.readAckTimer) {
    clearTimeout(appState.readAckTimer);
    appState.readAckTimer = null;
  }
  if (appState.localTypingTimer) {
    clearTimeout(appState.localTypingTimer);
    appState.localTypingTimer = null;
  }
  setLocalTypingHint(false);
  hideMentionSuggestions();
  toggleEmojiPanel(false);
  cleanupStuckUiOverlay();
}

function enqueueWsNewMessage(payload) {
  const normalized = normalizeMessage(payload || {});
  if (!normalized?.room_id) return;

  const roomId = Number(normalized.room_id);
  if (!appState.wsMessageBatchByRoom[roomId]) appState.wsMessageBatchByRoom[roomId] = [];
  appState.wsMessageBatchByRoom[roomId].push(normalized);

  if (appState.wsMessageBatchTimer) return;
  appState.wsMessageBatchTimer = setTimeout(flushWsNewMessageBatch, 80);
}

function flushWsNewMessageBatch() {
  if (appState.wsMessageBatchTimer) {
    clearTimeout(appState.wsMessageBatchTimer);
    appState.wsMessageBatchTimer = null;
  }

  const roomIds = Object.keys(appState.wsMessageBatchByRoom);
  if (!roomIds.length) return;

  roomIds.forEach((roomIdStr) => {
    const roomId = Number(roomIdStr);
    const queue = appState.wsMessageBatchByRoom[roomId];
    delete appState.wsMessageBatchByRoom[roomId];
    if (!Array.isArray(queue) || !queue.length) return;
    const processing = queue.slice(0, WS_MESSAGE_BATCH_CHUNK);
    const remaining = queue.slice(WS_MESSAGE_BATCH_CHUNK);
    if (remaining.length) appState.wsMessageBatchByRoom[roomId] = remaining;

    const conv = findConversationById(roomId);
    if (!conv) return;

    const existing = new Set(conv.messages.map((m) => Number(m.id)));
    const listEl = getMessageScrollContainer();
    const nearBottom = isNearBottom(listEl);
    const isCurrent = appState.activeConversationId === conv.id && appState.currentView === 'messagesView';

    const newlyAdded = [];
    const replacedRows = [];
    let otherMsgCount = 0;
    let latestOtherMsg = null;

    processing.forEach((raw) => {
      const msg = normalizeMessage(raw);
      if (!msg?.id) return;

      const replacedPending = reconcilePendingMessage(conv, msg);
      const exists = existing.has(Number(msg.id));
      if (!exists && !replacedPending) {
        conv.messages.push(msg);
        existing.add(Number(msg.id));
        newlyAdded.push(msg);
      }

      const isFromOther = msg.senderId !== appState.currentUser.id;
      if (isFromOther) {
        otherMsgCount += 1;
        latestOtherMsg = msg;
        if (!isCurrent) conv.unreadCount = (conv.unreadCount || 0) + 1;
      }
      if (replacedPending) replacedRows.push({ oldId: replacedPending, message: msg });
    });

    if (!newlyAdded.length && !replacedRows.length) return;

    updateLastMessageId(roomId, conv.messages);
    scheduleConversationListRender();
    if (isCurrent) {
      replacedRows.forEach(({ oldId, message }) => replaceMessageRowInView(conv, oldId, message));
      newlyAdded.forEach((m) => queueMessageAppend(conv.id, m, { autoScroll: nearBottom }));
      if (nearBottom && !appState.messageAppendQueued) scrollMessagesToBottom({ force: false });
      if (otherMsgCount > 0) scheduleMarkCurrentRoomRead();
    } else if (otherMsgCount > 0 && latestOtherMsg) {
      const sender = appState.userMap[latestOtherMsg.senderId];
      notifyMessage(sender?.nickname || sender?.username || '新消息', latestOtherMsg.text);
      playIncomingSound();
    }
    updateUnreadBadges();
  });

  if (Object.keys(appState.wsMessageBatchByRoom).length) {
    appState.wsMessageBatchTimer = setTimeout(flushWsNewMessageBatch, 60);
  }
}

function updateLastMessageId(roomId, messages) {
  if (!roomId || !Array.isArray(messages) || !messages.length) return;
  const maxId = messages.reduce((max, m) => (m.id > max ? m.id : max), 0);
  if (maxId > 0) appState.lastMessageIdByRoom[roomId] = maxId;
}

function stopRoomPolling() {
  if (appState.roomPollTimer) {
    clearInterval(appState.roomPollTimer);
    appState.roomPollTimer = null;
  }
  appState.roomPollRoomId = null;
  appState.roomPollInFlight = false;
}

async function pollActiveRoomMessages() {
  if (appState.roomPollInFlight) return;
  const roomId = appState.roomPollRoomId || appState.activeConversationId;
  if (!roomId) return;
  const conv = findConversationById(roomId);
  if (!conv) return;

  appState.roomPollInFlight = true;
  try {
    const batch = await apiGetRoomMessages(roomId, 20);
    // 避免请求返回时用户已切房，造成串房间追加
    if (roomId !== appState.activeConversationId) return;

    const normalized = batch.map(normalizeMessage).reverse();
    const existing = new Set(conv.messages.map((m) => m.id));
    const listEl = getMessageScrollContainer();
    const nearBottom = isNearBottom(listEl);
    const newlyAdded = [];
    const replacedRows = [];

    normalized.forEach((msg) => {
      if (existing.has(msg.id)) return;
      const replaced = reconcilePendingMessage(conv, msg);
      if (replaced) {
        replacedRows.push({ oldId: replaced, message: msg });
      }
      if (!replaced) {
        conv.messages.push(msg);
        newlyAdded.push(msg);
      }
    });

    if (newlyAdded.length || replacedRows.length) {
      updateLastMessageId(roomId, conv.messages);
      scheduleConversationListRender();
      if (appState.currentView === 'messagesView' && appState.activeConversationId === roomId) {
        replacedRows.forEach(({ oldId, message }) => replaceMessageRowInView(conv, oldId, message));
        if (newlyAdded.length) {
          newlyAdded.forEach((m) => queueMessageAppend(conv.id, m, { autoScroll: nearBottom }));
        }
        if (nearBottom && !appState.messageAppendQueued) scrollMessagesToBottom({ force: false });
      }
      updateUnreadBadges();
      if (newlyAdded.length) await markCurrentRoomRead();
    }
  } catch (err) {
    console.warn('轮询消息失败:', err.message);
  } finally {
    appState.roomPollInFlight = false;
  }
}

function startRoomPolling(roomId) {
  stopRoomPolling();
  if (!roomId) return;
  appState.roomPollRoomId = roomId;
  const conv = findConversationById(roomId);
  if (conv) updateLastMessageId(roomId, conv.messages);
  pollActiveRoomMessages().catch((err) => console.warn('首次轮询失败', err.message));
  appState.roomPollTimer = setInterval(() => {
    pollActiveRoomMessages();
  }, 2000);
}

function startUnreadPolling() {
  if (appState.unreadPollTimer) clearInterval(appState.unreadPollTimer);
  appState.unreadPollTimer = setInterval(async () => {
    try {
      await Promise.all([refreshUnreadCounts(), refreshFriendRequests()]);
      renderConversationList();
      updateUnreadBadges();
      if (appState.currentView === 'friendsView') renderFriendRequestLists();
    } catch (err) {
      console.warn('未读轮询失败:', err.message);
    }
  }, 10000);
}

function stopUnreadPolling() {
  if (appState.unreadPollTimer) {
    clearInterval(appState.unreadPollTimer);
    appState.unreadPollTimer = null;
  }
}

// ============================
// WebSocket 实时连接
// ============================
function connectWebSocket() {
  const token = getToken();
  if (!token) return;

  if (appState.ws) {
    // 主动重连时避免触发旧连接 onclose 的自动重连逻辑
    appState.ws.onclose = null;
    appState.ws.close();
    appState.ws = null;
  }

  const wsBase = getWsBase();
  const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  appState.ws = ws;

  ws.onopen = () => {
    console.log('[WS] connected');
    appState.wsReconnectTried = false;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (err) {
      console.error('[WS] parse error', err);
    }
  };

  ws.onclose = () => {
    console.warn('[WS] closed');
    appState.ws = null;
    // 仅自动重连一次
    if (!appState.wsReconnectTried && appState.currentUser && getToken()) {
      appState.wsReconnectTried = true;
      if (appState.wsReconnectTimer) clearTimeout(appState.wsReconnectTimer);
      appState.wsReconnectTimer = setTimeout(() => {
        console.warn('[WS] reconnect once');
        connectWebSocket();
      }, 2000);
    }
  };

  ws.onerror = (err) => {
    console.error('[WS] error', err);
  };
}

function handleWsEvent(evt) {
  if (evt.type === 'connected') return;

  if (evt.type === 'force_logout' || evt.type === 'account_disabled') {
    forceLogoutByAdmin(evt.reason || evt.payload?.reason || '账号已被管理员禁用，无法继续使用');
    return;
  }

  if (evt.type === 'presence') {
    const uid = Number(evt.user_id);
    if (!Number.isNaN(uid)) {
      if (evt.online) appState.onlineUserIds.add(uid);
      else appState.onlineUserIds.delete(uid);
      if (appState.userMap[uid]) appState.userMap[uid].online = !!evt.online;
      appState.friends = appState.friends.map((f) => (f.id === uid ? { ...f, online: !!evt.online } : f));
      renderFriendList();
      const conv = findConversationById(appState.activeConversationId);
      if (conv) {
        const subEl = document.getElementById('chatSubTitle');
        if (subEl) {
          if (conv.type === 'group') {
            const onlineCount = (conv.members || []).filter((id) => appState.onlineUserIds.has(Number(id))).length;
            subEl.textContent = `${conv.members.length} 人 · 在线 ${onlineCount}`;
          } else {
            const other = getOtherUserInPrivateConversation(conv);
            if (other?.id === uid) subEl.textContent = evt.online ? '在线' : '离线';
          }
        }
      }
    }
    return;
  }

  if (evt.type === 'unread_update') {
    const roomId = Number(evt.room_id);
    const conv = findConversationById(roomId);
    if (conv) {
      conv.unreadCount = Number(evt.unread_count || 0);
      renderConversationList();
      updateUnreadBadges();
    }
    return;
  }

  if (evt.type === 'room_removed' || evt.type === 'room_dissolved') {
    const roomId = Number(evt.room_id || evt.payload?.room_id);
    appState.conversations = appState.conversations.filter((c) => c.id !== roomId);
    clearRoomRuntimeBuffers(roomId);
    if (appState.activeConversationId === roomId) {
      appState.activeConversationId = null;
      stopRoomPolling();
      renderMessages({ autoScroll: false });
      alert(evt.type === 'room_dissolved' ? '该群已解散' : '你已被移出该群');
    }
    renderGroupList();
    renderConversationList();
    updateUnreadBadges();
    return;
  }

  if (evt.type === 'read_receipt') {
    // 可选事件：当前版本不展示“谁已读到哪里”，保留入口以便后续扩展
    return;
  }

  if (evt.type === 'new_message') {
    enqueueWsNewMessage(evt.payload);
    return;
  }

  if (evt.type === 'message_edited') {
    const msg = normalizeMessage(evt.payload);
    const conv = findConversationById(msg.room_id);
    if (!conv) return;

    const target = conv.messages.find((m) => m.id === msg.id);
    if (target) {
      target.text = msg.text;
      target.updatedAt = msg.updatedAt;
      target.editedAt = msg.editedAt;
      target.editedByAdmin = msg.editedByAdmin;
    }

    scheduleConversationListRender();
    if (appState.activeConversationId === conv.id && target) updateMessageRowInView(conv, target);
    return;
  }

  if (evt.type === 'message_deleted') {
    const payload = evt.payload || {};
    const roomId = Number(payload.room_id);
    const messageId = Number(payload.id);
    const conv = findConversationById(roomId);
    if (!conv || !messageId) return;
    conv.messages = conv.messages.filter((m) => Number(m.id) !== messageId);
    scheduleConversationListRender();
    if (appState.activeConversationId === conv.id) removeMessageRowInView(messageId);
    return;
  }

  if (evt.type === 'member_messages_deleted') {
    const roomId = Number(evt.room_id);
    const targetUserId = Number(evt.user_id);
    const conv = findConversationById(roomId);
    if (!conv || !targetUserId) return;

    conv.messages = conv.messages.filter((m) => Number(m.senderId) !== targetUserId);
    scheduleConversationListRender();
    if (appState.activeConversationId === conv.id) renderMessages({ autoScroll: false });
    return;
  }

  if (evt.type === 'call_invite') {
    const payload = evt.payload || {};
    // 已在通话中：显示忙线提示并拒绝
    if (appState.call.status !== 'idle' || appState.call.pendingInvite) {
      sendWsMessage({
        action: 'call_reject',
        call_id: payload.call_id,
        room_id: payload.room_id
      });
      return;
    }
    appState.call.pendingInvite = payload;
    showIncomingCallPanel(payload);
    playIncomingSound();
    return;
  }

  if (evt.type === 'call_ringing') {
    const payload = evt.payload || {};
    appState.call.callId = payload.call_id || appState.call.callId;
    appState.call.status = 'ringing';
    updateActiveCallPanel();
    return;
  }

  if (evt.type === 'call_accept') {
    onCallAccepted(evt.payload).catch((err) => {
      console.warn('处理接听失败:', err.message);
      endActiveCall({ localOnly: true, reason: 'accept_failed' });
    });
    return;
  }

  if (evt.type === 'call_reject') {
    hideIncomingCallPanel();
    appState.call.pendingInvite = null;
    endActiveCall({ localOnly: true, reason: evt.payload?.reason || 'rejected' });
    return;
  }

  if (evt.type === 'call_busy') {
    endActiveCall({ localOnly: true, reason: evt.payload?.reason || 'busy' });
    alert('对方忙线中，请稍后再试');
    return;
  }

  if (evt.type === 'call_hangup') {
    hideIncomingCallPanel();
    appState.call.pendingInvite = null;
    endActiveCall({ localOnly: true, reason: evt.payload?.reason || 'hangup' });
    return;
  }

  if (evt.type === 'call_offer') {
    onCallOffer(evt.payload).catch((err) => {
      console.warn('处理 offer 失败:', err.message);
      endActiveCall({ localOnly: false, reason: 'offer_failed' });
    });
    return;
  }

  if (evt.type === 'call_answer') {
    onCallAnswer(evt.payload).catch((err) => {
      console.warn('处理 answer 失败:', err.message);
      endActiveCall({ localOnly: false, reason: 'answer_failed' });
    });
    return;
  }

  if (evt.type === 'call_ice_candidate') {
    onCallIceCandidate(evt.payload);
    return;
  }

  if (evt.type === 'error') {
    console.warn('[WS] server error:', evt.payload?.message);
    const msg = String(evt.payload?.message || '');
    if (msg.toLowerCase().includes('muted')) {
      const rid = Number(evt.payload?.room_id || appState.activeConversationId || 0);
      if (rid) appState.roomMuteStateByRoom[rid] = true;
      if (rid) markLatestPendingAsFailed(rid);
      const conv = findConversationById(appState.activeConversationId);
      applyMuteComposerState(conv);
      alert('你已被群主禁言，暂时不能发送消息');
      return;
    }
    if (msg.includes('发言过快')) {
      const rid = Number(evt.payload?.room_id || appState.activeConversationId || 0);
      if (rid) markLatestPendingAsFailed(rid);
      alert(msg);
    }
  }
}

function sendWsMessage(payload) {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  appState.ws.send(JSON.stringify(payload));
  return true;
}

function resetCallMedia() {
  if (appState.call.pc) {
    try {
      appState.call.pc.ontrack = null;
      appState.call.pc.onicecandidate = null;
      appState.call.pc.onconnectionstatechange = null;
      appState.call.pc.close();
    } catch (_) {
      // ignore
    }
    appState.call.pc = null;
  }
  if (appState.call.localStream) {
    appState.call.localStream.getTracks().forEach((t) => t.stop());
    appState.call.localStream = null;
  }
  appState.call.remoteStream = null;

  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  if (localVideo) localVideo.srcObject = null;
  if (remoteVideo) remoteVideo.srcObject = null;
}

function hideIncomingCallPanel() {
  const panel = document.getElementById('incomingCallPanel');
  if (panel) panel.classList.add('d-none');
}

function showIncomingCallPanel(payload) {
  const panel = document.getElementById('incomingCallPanel');
  const nameEl = document.getElementById('incomingCallName');
  const typeEl = document.getElementById('incomingCallTypeText');
  const avatarEl = document.getElementById('incomingCallAvatar');
  if (!panel || !nameEl || !typeEl || !avatarEl) return;

  const peerId = Number(payload.from_user_id);
  nameEl.textContent = getCallPeerName(peerId);
  typeEl.textContent = payload.call_type === 'video' ? '视频来电' : '语音来电';
  avatarEl.src = getUserAvatarById(peerId);
  panel.classList.remove('d-none');
}

function updateActiveCallPanel() {
  const panel = document.getElementById('activeCallPanel');
  const nameEl = document.getElementById('activeCallName');
  const statusEl = document.getElementById('activeCallStatus');
  const badgeEl = document.getElementById('activeCallTypeBadge');
  const avatarEl = document.getElementById('activeCallAvatar');
  const videoWrap = document.getElementById('activeCallVideoWrap');
  const localVideo = document.getElementById('localVideo');
  const remoteVideo = document.getElementById('remoteVideo');
  const muteBtn = document.getElementById('callMuteBtn');
  const speakerBtn = document.getElementById('callSpeakerBtn');
  const camBtn = document.getElementById('callToggleCameraBtn');
  if (!panel || !nameEl || !statusEl || !badgeEl || !avatarEl || !videoWrap || !muteBtn || !speakerBtn || !camBtn) return;

  if (appState.call.status === 'idle') {
    panel.classList.add('d-none');
    return;
  }
  panel.classList.remove('d-none');

  nameEl.textContent = appState.call.peerName || '对方';
  avatarEl.src = getUserAvatarById(appState.call.peerUserId) || DEFAULT_AVATAR;
  badgeEl.textContent = appState.call.mode === 'video' ? '视频' : '语音';

  const statusMap = {
    ringing: appState.call.isOutgoing ? '呼叫中...' : '来电中...',
    incoming: '来电中...',
    connecting: '连接中...',
    active: '已接通',
    ended: '已结束'
  };
  statusEl.textContent = statusMap[appState.call.status] || appState.call.status;

  const isVideo = appState.call.mode === 'video';
  videoWrap.classList.toggle('d-none', !isVideo);
  camBtn.classList.toggle('d-none', !isVideo);
  camBtn.textContent = appState.call.cameraOff ? '开启摄像头' : '关闭摄像头';
  muteBtn.textContent = appState.call.muted ? '取消静音' : '静音';
  speakerBtn.textContent = appState.call.speakerOn ? '扩音开' : '扩音关';
  speakerBtn.disabled = !appState.call.speakerSupported;

  if (isVideo) {
    if (localVideo) localVideo.srcObject = appState.call.localStream || null;
    if (remoteVideo) remoteVideo.srcObject = appState.call.remoteStream || null;
  }
}

function resetCallState() {
  resetCallMedia();
  appState.call = {
    status: 'idle',
    mode: null,
    callId: null,
    roomId: null,
    peerUserId: null,
    peerName: '',
    isOutgoing: false,
    muted: false,
    cameraOff: false,
    speakerOn: false,
    speakerSupported: false,
    pendingInvite: null,
    pendingCandidates: [],
    pc: null,
    localStream: null,
    remoteStream: null
  };
  hideIncomingCallPanel();
  updateActiveCallPanel();
}

async function ensureLocalMedia(mode) {
  if (appState.call.localStream) return appState.call.localStream;
  const constraints = mode === 'video'
    ? { audio: true, video: { width: 640, height: 360 } }
    : { audio: true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  appState.call.localStream = stream;
  return stream;
}

function attachRemoteMediaStream(stream) {
  const remoteVideo = document.getElementById('remoteVideo');
  if (!remoteVideo) return;
  remoteVideo.srcObject = stream || null;
  const playPromise = remoteVideo.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch(() => null);
  }
  remoteVideo.onloadedmetadata = () => {
    remoteVideo.play().catch(() => null);
  };
  appState.call.speakerSupported = typeof remoteVideo.setSinkId === 'function';
}

async function applySpeakerOutput(enabled) {
  const remoteVideo = document.getElementById('remoteVideo');
  if (!remoteVideo || typeof remoteVideo.setSinkId !== 'function') {
    appState.call.speakerSupported = false;
    updateActiveCallPanel();
    return false;
  }
  appState.call.speakerSupported = true;
  try {
    if (!enabled) {
      await remoteVideo.setSinkId('default');
      return true;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    const preferred = outputs.find((d) => d.deviceId && d.deviceId !== 'default');
    await remoteVideo.setSinkId(preferred?.deviceId || 'default');
    return true;
  } catch (err) {
    console.warn('切换扩音失败:', err.message);
    return false;
  } finally {
    updateActiveCallPanel();
  }
}

function buildPeerConnection() {
  if (appState.call.pc) return appState.call.pc;
  const pc = new RTCPeerConnection(getRtcConfiguration());
  appState.call.pc = pc;
  appState.call.remoteStream = new MediaStream();

  attachRemoteMediaStream(appState.call.remoteStream);
  const localVideo = document.getElementById('localVideo');
  if (localVideo) {
    localVideo.srcObject = appState.call.localStream || null;
    localVideo.play().catch(() => null);
  }

  pc.ontrack = (evt) => {
    if (evt.streams && evt.streams[0]) {
      appState.call.remoteStream = evt.streams[0];
      attachRemoteMediaStream(appState.call.remoteStream);
    } else if (evt.track) {
      appState.call.remoteStream.addTrack(evt.track);
      attachRemoteMediaStream(appState.call.remoteStream);
    }
    updateActiveCallPanel();
  };

  pc.onicecandidate = (evt) => {
    if (!evt.candidate || !appState.call.callId) return;
    const candidatePayload = typeof evt.candidate.toJSON === 'function'
      ? evt.candidate.toJSON()
      : {
          candidate: evt.candidate.candidate,
          sdpMid: evt.candidate.sdpMid,
          sdpMLineIndex: evt.candidate.sdpMLineIndex
        };
    sendWsMessage({
      action: 'call_ice_candidate',
      call_id: appState.call.callId,
      room_id: appState.call.roomId,
      candidate: candidatePayload
    });
  };

  pc.onconnectionstatechange = () => {
    if (['connected'].includes(pc.connectionState)) {
      appState.call.status = 'active';
      updateActiveCallPanel();
      return;
    }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      endActiveCall({ localOnly: true, finalStatus: 'ended' });
    }
  };

  const stream = appState.call.localStream;
  if (stream) {
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
  }
  return pc;
}

async function startCall(mode) {
  const conv = findConversationById(appState.activeConversationId);
  if (!conv || !isDmConversation(conv)) {
    alert('仅支持在单聊中发起通话');
    return;
  }
  if (appState.call.status !== 'idle') {
    alert('当前已有进行中的通话');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('当前设备不支持音视频通话');
    return;
  }
  if (!sendWsMessage({ action: 'ping', room_id: conv.id })) {
    alert('实时连接未建立，请稍后重试');
    return;
  }

  const peerUserId = getCallPeerUserId(conv);
  if (!peerUserId) {
    alert('无法识别通话对象');
    return;
  }
  appState.call.mode = mode;
  appState.call.roomId = conv.id;
  appState.call.peerUserId = peerUserId;
  appState.call.peerName = getCallPeerName(peerUserId);
  appState.call.status = 'ringing';
  appState.call.isOutgoing = true;
  appState.call.muted = false;
  appState.call.cameraOff = false;
  appState.call.speakerOn = false;
  appState.call.pendingCandidates = [];

  try {
    await ensureLocalMedia(mode);
  } catch (err) {
    resetCallState();
    alert(`无法获取麦克风/摄像头权限：${err.message}`);
    return;
  }

  updateActiveCallPanel();
  const ok = sendWsMessage({
    action: 'call_invite',
    room_id: conv.id,
    call_type: mode
  });
  if (!ok) {
    resetCallState();
    alert('实时连接未建立，请稍后重试');
  }
}

async function acceptIncomingCall() {
  const invite = appState.call.pendingInvite;
  if (!invite) return;
  appState.call.callId = invite.call_id;
  appState.call.mode = invite.call_type;
  appState.call.roomId = Number(invite.room_id);
  appState.call.peerUserId = Number(invite.from_user_id);
  appState.call.peerName = getCallPeerName(appState.call.peerUserId);
  appState.call.isOutgoing = false;
  appState.call.status = 'connecting';
  appState.call.muted = false;
  appState.call.cameraOff = false;
  appState.call.speakerOn = false;
  appState.call.pendingCandidates = [];
  hideIncomingCallPanel();

  try {
    await ensureLocalMedia(appState.call.mode);
  } catch (err) {
    sendWsMessage({ action: 'call_reject', call_id: invite.call_id, room_id: invite.room_id });
    resetCallState();
    alert(`无法接听，设备权限被拒绝：${err.message}`);
    return;
  }

  const conv = findConversationById(appState.call.roomId);
  if (conv) {
    appState.activeConversationId = conv.id;
    switchView('messagesView', { keepRoom: true });
    renderConversationList();
    renderMessages({ autoScroll: true, forceBottom: true });
    startRoomPolling(conv.id);
  }

  updateActiveCallPanel();
  sendWsMessage({
    action: 'call_accept',
    call_id: invite.call_id,
    room_id: invite.room_id
  });
  appState.call.pendingInvite = null;
}

function rejectIncomingCall() {
  const invite = appState.call.pendingInvite;
  if (!invite) return;
  sendWsMessage({
    action: 'call_reject',
    call_id: invite.call_id,
    room_id: invite.room_id
  });
  appState.call.pendingInvite = null;
  hideIncomingCallPanel();
}

async function onCallAccepted(payload) {
  if (!payload?.call_id) return;
  if (appState.call.callId && appState.call.callId !== payload.call_id) return;
  appState.call.callId = payload.call_id;
  appState.call.status = 'connecting';
  updateActiveCallPanel();

  const pc = buildPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendWsMessage({
    action: 'call_offer',
    call_id: payload.call_id,
    room_id: appState.call.roomId,
    sdp: offer.sdp
  });
}

async function onCallOffer(payload) {
  if (!payload?.call_id || !payload?.sdp) return;
  if (appState.call.callId !== payload.call_id) return;
  const pc = buildPeerConnection();
  await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
  while (appState.call.pendingCandidates.length) {
    const c = appState.call.pendingCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (_) {
      // ignore candidate race
    }
  }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendWsMessage({
    action: 'call_answer',
    call_id: payload.call_id,
    room_id: appState.call.roomId,
    sdp: answer.sdp
  });
}

async function onCallAnswer(payload) {
  if (!payload?.call_id || !payload?.sdp) return;
  if (appState.call.callId !== payload.call_id || !appState.call.pc) return;
  await appState.call.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
  while (appState.call.pendingCandidates.length) {
    const c = appState.call.pendingCandidates.shift();
    try {
      await appState.call.pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (_) {
      // ignore candidate race
    }
  }
  appState.call.status = 'active';
  updateActiveCallPanel();
}

async function onCallIceCandidate(payload) {
  if (!payload?.call_id || !payload?.candidate) return;
  if (appState.call.callId !== payload.call_id) return;
  if (!appState.call.pc) {
    appState.call.pendingCandidates.push(payload.candidate);
    return;
  }
  if (!appState.call.pc.remoteDescription) {
    appState.call.pendingCandidates.push(payload.candidate);
    return;
  }
  try {
    await appState.call.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch (err) {
    console.warn('ICE candidate add failed:', err.message);
  }
}

function endActiveCall(options = {}) {
  const { localOnly = false, finalStatus = 'ended', reason = '' } = options;
  const callId = appState.call.callId;
  const roomId = appState.call.roomId;
  const hadActive = !!callId || appState.call.status !== 'idle';
  if (!hadActive) {
    resetCallState();
    return;
  }
  if (!localOnly && callId) {
    sendWsMessage({
      action: 'call_hangup',
      call_id: callId,
      room_id: roomId
    });
  }
  appState.call.status = finalStatus;
  updateActiveCallPanel();
  setTimeout(() => {
    resetCallState();
    if (reason) console.info(`[call] ${reason}`);
  }, 200);
}

function toggleCallMute() {
  const stream = appState.call.localStream;
  if (!stream) return;
  appState.call.muted = !appState.call.muted;
  stream.getAudioTracks().forEach((t) => {
    t.enabled = !appState.call.muted;
  });
  updateActiveCallPanel();
}

function toggleCallCamera() {
  if (appState.call.mode !== 'video') return;
  const stream = appState.call.localStream;
  if (!stream) return;
  appState.call.cameraOff = !appState.call.cameraOff;
  stream.getVideoTracks().forEach((t) => {
    t.enabled = !appState.call.cameraOff;
  });
  updateActiveCallPanel();
}

async function toggleSpeakerMode() {
  const next = !appState.call.speakerOn;
  const ok = await applySpeakerOutput(next);
  if (!ok) {
    alert('当前环境不支持切换扩音输出（部分 iOS/PWA/WebView 限制）');
    return;
  }
  appState.call.speakerOn = next;
  updateActiveCallPanel();
}

function updateCallButtonsState() {
  const voiceBtn = document.getElementById('voiceCallBtn');
  const videoBtn = document.getElementById('videoCallBtn');
  if (!voiceBtn || !videoBtn) return;
  const conv = findConversationById(appState.activeConversationId);
  const canCall = !!conv && isDmConversation(conv);
  voiceBtn.disabled = !canCall || appState.call.status !== 'idle';
  videoBtn.disabled = !canCall || appState.call.status !== 'idle';
}

// ============================
// 登录/注册
// ============================
function bindAuthEvents() {
  document.getElementById('toRegisterBtn').addEventListener('click', () => switchAuthPage('register'));
  document.getElementById('toLoginBtn').addEventListener('click', () => switchAuthPage('login'));

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    const phone = document.getElementById('loginPhone').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    const agreed = document.getElementById('loginAgree').checked;
    if (!agreed) {
      alert('请先勾选“我已阅读并同意相关协议”');
      return;
    }

    try {
      setButtonLoading(submitBtn, true, '登录中...', '登录');
      const data = await apiLogin(phone, password);
      setToken(data.token);
      await bootstrapAfterLogin(data.user);
    } catch (err) {
      alert(`登录失败(${err.status || 'ERR'}): ${err.message}`);
    } finally {
      setButtonLoading(submitBtn, false, '登录中...', '登录');
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]');
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const confirmPassword = document.getElementById('regPasswordConfirm').value.trim();
    const agreed = document.getElementById('registerAgree').checked;
    if (!agreed) {
      alert('请先勾选“我已阅读并同意相关协议”');
      return;
    }
    if (password !== confirmPassword) {
      alert('两次输入的密码不一致');
      return;
    }

    try {
      setButtonLoading(submitBtn, true, '注册中...', '注册并登录');
      const data = await apiRegister(phone, password);
      setToken(data.token);
      await bootstrapAfterLogin(data.user);
    } catch (err) {
      alert(`注册失败(${err.status || 'ERR'}): ${err.message}`);
    } finally {
      setButtonLoading(submitBtn, false, '注册中...', '注册并登录');
    }
  });
}

function logout() {
  endActiveCall({ localOnly: true, reason: 'logout' });
  clearToken();
  appState.currentUser = null;
  appState.friends = [];
  appState.userMap = {};
  appState.conversations = [];
  appState.activeConversationId = null;
  appState.messageRenderLimitByRoom = {};
  appState.pinnedRoomOrder = [];

  if (appState.ws) {
    appState.ws.onclose = null;
    appState.ws.close();
    appState.ws = null;
  }
  if (appState.wsReconnectTimer) {
    clearTimeout(appState.wsReconnectTimer);
    appState.wsReconnectTimer = null;
  }
  stopRoomPolling();
  stopUnreadPolling();
  updateAdminNavVisibility();

  showAuth();
  switchAuthPage('login');
}

async function removeFriend(friendId, options = {}) {
  try {
    const current = findConversationById(appState.activeConversationId);
    const shouldResetCurrent = !!(current && isDmConversation(current) && current.members.includes(friendId));

    await apiRemoveFriend(friendId, options);
    await refreshFriends();
    await refreshFriendRemarks();
    await refreshFriendRequests();
    await refreshRoomsAndMessages();
    await refreshUnreadCounts();
    if (shouldResetCurrent) {
      appState.activeConversationId = null;
      switchView('friendsView');
    }
    renderFriendList();
    renderFriendRequestLists();
    renderConversationList();
    renderMessages();
    updateUnreadBadges();
  } catch (err) {
    alert(`删除好友失败：${err.message}`);
  }
}

function openDeleteFriendConfirmModal(friendId) {
  const fid = Number(friendId || 0);
  if (!fid) return;
  const modalEl = document.getElementById('deleteFriendModal');
  if (!modalEl) return;
  const idInput = document.getElementById('deleteFriendId');
  const wrap = document.getElementById('deleteFriendPeerOptionWrap');
  const peerCheckbox = document.getElementById('deleteFriendPeerMessages');
  if (idInput) idInput.value = String(fid);
  const canAdvanced = !!appState.currentUser?.canUseEditFeature;
  if (wrap) wrap.classList.toggle('d-none', !canAdvanced);
  if (peerCheckbox) peerCheckbox.checked = false;
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

// ============================
// 导航/主题/资料
// ============================
function bindNavigationEvents() {
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      const drawer = bootstrap.Offcanvas.getInstance(document.getElementById('mobileDrawer'));
      if (drawer && btn.dataset.mobileNav === '1') drawer.hide();
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('mobileLogoutBtn').addEventListener('click', logout);

  const conversationSearchInput = document.getElementById('conversationSearchInput');
  if (conversationSearchInput) {
    conversationSearchInput.addEventListener('input', (e) => {
      appState.conversationSearchKeyword = String(e.target.value || '');
      renderConversationList();
    });
  }

  const tabAll = document.getElementById('conversationTabAll');
  const tabUnread = document.getElementById('conversationTabUnread');
  const tabMention = document.getElementById('conversationTabMention');
  if (tabAll) tabAll.addEventListener('click', () => setConversationFilter('all'));
  if (tabUnread) tabUnread.addEventListener('click', () => setConversationFilter('unread'));
  if (tabMention) tabMention.addEventListener('click', () => setConversationFilter('mention'));

  const adminRefreshBtn = document.getElementById('adminRefreshBtn');
  if (adminRefreshBtn) {
    adminRefreshBtn.addEventListener('click', () => {
      loadAdminUsers().catch((err) => console.warn('刷新后台用户失败', err.message));
    });
  }
  const adminResetSubmitBtn = document.getElementById('adminResetPasswordSubmitBtn');
  if (adminResetSubmitBtn) {
    adminResetSubmitBtn.addEventListener('click', async () => {
      const userId = Number(document.getElementById('adminResetUserId')?.value || 0);
      const p1 = document.getElementById('adminResetPassword')?.value.trim() || '';
      const p2 = document.getElementById('adminResetPasswordConfirm')?.value.trim() || '';
      if (!userId) return;
      if (!p1 || p1.length < 6) {
        alert('新密码长度至少 6 位');
        return;
      }
      if (p1 !== p2) {
        alert('两次密码不一致');
        return;
      }
      if (!confirm('确认重置该用户密码？')) return;
      try {
        setButtonLoading(adminResetSubmitBtn, true, '重置中...', '确认重置');
        await apiAdminResetPassword(userId, p1, p2);
        const modal = bootstrap.Modal.getInstance(document.getElementById('adminResetPasswordModal'));
        if (modal) modal.hide();
        alert('密码重置成功');
      } catch (err) {
        alert(`重置失败：${err.message}`);
      } finally {
        setButtonLoading(adminResetSubmitBtn, false, '重置中...', '确认重置');
      }
    });
  }
}

function bindProfileEvents() {
  const avatarInput = document.getElementById('avatarInput');
  const profileAvatar = document.getElementById('profileAvatar');
  const avatarPickerBtn = document.getElementById('avatarPickerBtn');

  const triggerAvatarPicker = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (avatarInput) avatarInput.click();
  };

  if (avatarPickerBtn && avatarInput) {
    avatarPickerBtn.addEventListener('click', triggerAvatarPicker);
    avatarPickerBtn.addEventListener('touchend', triggerAvatarPicker, { passive: false });
  }
  if (profileAvatar && avatarInput) {
    profileAvatar.style.cursor = 'pointer';
    profileAvatar.addEventListener('click', triggerAvatarPicker);
  }

  if (!avatarInput || !profileAvatar) {
    console.warn('头像上传控件未找到，已跳过头像事件绑定');
    return;
  }

  avatarInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const base64 = ev.target.result;
      appState.pendingAvatarBase64 = base64;
      profileAvatar.src = base64;
    };
    reader.readAsDataURL(file);
  });

  const saveBtn = document.getElementById('saveProfileBtn');
  if (!saveBtn) return;

  saveBtn.addEventListener('click', async () => {
    const nickname = document.getElementById('nicknameInput').value.trim();
    const signature = document.getElementById('signatureInput').value.trim();

    try {
      const updated = await apiUpdateMe({
        nickname,
        signature,
        avatar_base64: appState.pendingAvatarBase64 || undefined
      });

      mergeUserToMap(updated);
      appState.currentUser = {
        id: updated.id,
        username: updated.username,
        email: updated.email,
        nickname: updated.nickname,
        signature: updated.signature,
        avatar: updated.avatar_base64 || DEFAULT_AVATAR,
        role: updated.role,
        online: updated.is_online
      };

      appState.pendingAvatarBase64 = null;
      updateUserHeader();
      renderProfile();
      renderFriendList();
      renderConversationList();
      renderMessages();
      alert('资料已保存');
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });

  const toggleThemeBtn = document.getElementById('toggleThemeBtn');
  if (toggleThemeBtn) toggleThemeBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-bs-theme') || 'light';
    setTheme(current === 'light' ? 'dark' : 'light');
  });
}

function renderProfile() {
  const avatar = appState.currentUser.avatar || DEFAULT_AVATAR;
  const profileAvatar = document.getElementById('profileAvatar');
  const desktopRailAvatar = document.getElementById('desktopRailAvatar');
  if (profileAvatar) profileAvatar.src = avatar;
  if (desktopRailAvatar) desktopRailAvatar.src = avatar;
  document.getElementById('nicknameInput').value = appState.currentUser.nickname || '';
  document.getElementById('signatureInput').value = appState.currentUser.signature || '';
}

function updateUserHeader() {
  document.getElementById('sidebarUsername').textContent = appState.currentUser.nickname || appState.currentUser.username;
  const desktopRailAvatar = document.getElementById('desktopRailAvatar');
  if (desktopRailAvatar) desktopRailAvatar.src = appState.currentUser.avatar || DEFAULT_AVATAR;
}

function isAdminUser() {
  return (appState.currentUser?.role || '').toLowerCase() === 'admin';
}

function updateAdminNavVisibility() {
  const visible = ENABLE_IN_APP_ADMIN_VIEW && isAdminUser();
  const desktopBtn = document.getElementById('adminNavDesktop');
  const drawerBtn = document.getElementById('adminNavDrawer');
  if (desktopBtn) desktopBtn.classList.toggle('d-none', !visible);
  if (drawerBtn) drawerBtn.classList.toggle('d-none', !visible);
}

async function loadAdminUsers() {
  const box = document.getElementById('adminUserTableBody');
  if (!box) return;
  if (!isAdminUser()) {
    box.innerHTML = '<tr><td colspan="6" class="text-secondary">仅管理员可访问</td></tr>';
    return;
  }
  box.innerHTML = '<tr><td colspan="6" class="text-secondary">加载中...</td></tr>';
  try {
    const rows = await apiAdminListUsers();
    if (!rows?.length) {
      box.innerHTML = '<tr><td colspan="6" class="text-secondary">暂无用户</td></tr>';
      return;
    }
    box.innerHTML = '';
    rows.forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username || '')}</td>
        <td>${escapeHtml(u.nickname || '')}</td>
        <td>${escapeHtml(u.role || '')}</td>
        <td>${formatTime(u.created_at)}</td>
        <td>${u.last_seen_at ? formatTime(u.last_seen_at) : '暂无'}</td>
        <td><button class="btn btn-sm btn-outline-danger admin-reset-btn" data-user-id="${u.id}">重置密码</button></td>
      `;
      const resetBtn = tr.querySelector('.admin-reset-btn');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          const userIdEl = document.getElementById('adminResetUserId');
          const pwdEl = document.getElementById('adminResetPassword');
          const pwd2El = document.getElementById('adminResetPasswordConfirm');
          if (userIdEl) userIdEl.value = String(u.id);
          if (pwdEl) pwdEl.value = '';
          if (pwd2El) pwd2El.value = '';
          const modal = new bootstrap.Modal(document.getElementById('adminResetPasswordModal'));
          modal.show();
        });
      }
      box.appendChild(tr);
    });
  } catch (err) {
    box.innerHTML = `<tr><td colspan="6" class="text-danger">加载失败：${escapeHtml(err.message)}</td></tr>`;
  }
}

// ============================
// 好友系统
// ============================
function bindFriendEvents() {
  const searchBtn = document.getElementById('friendSearchBtn');
  const searchInput = document.getElementById('friendSearchInput');
  const localSearchToggleBtn = document.getElementById('contactsLocalSearchToggle');
  const localSearchWrap = document.getElementById('contactsLocalSearchWrap');
  const localSearchInput = document.getElementById('contactsLocalSearchInput');
  const toolsPanel = document.getElementById('friendToolsPanel');
  const addPanel = document.getElementById('addFriendPanel');
  const hideToolsBtn = document.getElementById('hideFriendToolsBtn');
  const incomingTabBtn = document.getElementById('incomingTabBtn');
  const outgoingTabBtn = document.getElementById('outgoingTabBtn');
  const hideAddFriendBtn = document.getElementById('hideAddFriendBtn');
  const entryNewFriend = document.getElementById('contactsEntryNewFriend');
  const entryGroups = document.getElementById('contactsEntryGroups');
  const menuAddFriend = document.getElementById('menuAddFriend');
  const menuCreateGroup = document.getElementById('menuCreateGroup');
  const plusBtn = document.getElementById('contactsPlusBtn');
  const plusMenu = plusBtn ? bootstrap.Dropdown.getOrCreateInstance(plusBtn) : null;

  const clearLocalFriendSearch = () => {
    appState.localFriendKeyword = '';
    if (localSearchInput) localSearchInput.value = '';
    if (localSearchWrap) localSearchWrap.classList.add('d-none');
  };

  const clearAddFriendSearch = () => {
    if (searchInput) searchInput.value = '';
    const resultBox = document.getElementById('friendSearchResults');
    if (resultBox) resultBox.innerHTML = '';
  };

  const openTools = () => {
    if (!toolsPanel) return;
    clearLocalFriendSearch();
    switchNewFriendTab(appState.newFriendTab || 'incoming');
    setFriendsSubView('new-friend');
    setTimeout(() => {
      toolsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  };

  const closeTools = () => {
    if (!toolsPanel) return;
    setFriendsSubView('main');
  };

  const openAddPanel = () => {
    if (!addPanel) return;
    clearLocalFriendSearch();
    setFriendsSubView('add-friend');
    setTimeout(() => {
      addPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  };

  const closeAddPanel = () => {
    if (!addPanel) return;
    clearAddFriendSearch();
    setFriendsSubView('main');
  };

  if (searchBtn) searchBtn.addEventListener('click', handleFriendSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleFriendSearch();
    });
  }
  if (localSearchToggleBtn && localSearchWrap) {
    localSearchToggleBtn.addEventListener('click', () => {
      if (addPanel && !addPanel.classList.contains('d-none')) return;
      if (toolsPanel && !toolsPanel.classList.contains('d-none')) return;
      localSearchWrap.classList.toggle('d-none');
      if (!localSearchWrap.classList.contains('d-none') && localSearchInput) {
        localSearchInput.focus();
      }
      if (localSearchWrap.classList.contains('d-none')) {
        appState.localFriendKeyword = '';
        if (localSearchInput) localSearchInput.value = '';
        renderFriendList();
      }
    });
  }
  if (localSearchInput) {
    localSearchInput.addEventListener('input', () => {
      appState.localFriendKeyword = localSearchInput.value.trim();
      renderFriendList();
    });
  }
  if (hideToolsBtn) hideToolsBtn.addEventListener('click', closeTools);
  if (incomingTabBtn) incomingTabBtn.addEventListener('click', () => switchNewFriendTab('incoming'));
  if (outgoingTabBtn) outgoingTabBtn.addEventListener('click', () => switchNewFriendTab('outgoing'));
  if (hideAddFriendBtn) hideAddFriendBtn.addEventListener('click', closeAddPanel);
  if (entryNewFriend) entryNewFriend.addEventListener('click', openTools);
  if (entryGroups) entryGroups.addEventListener('click', () => switchView('groupsView'));

  if (menuAddFriend) {
    menuAddFriend.addEventListener('click', () => {
      plusMenu?.hide();
      openAddPanel();
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    });
  }
  if (menuCreateGroup) {
    menuCreateGroup.addEventListener('click', () => {
      plusMenu?.hide();
      const modalEl = document.getElementById('createGroupModal');
      if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
  }
  setFriendsSubView('main');

  const profileChatBtn = document.getElementById('friendProfileChatBtn');
  if (profileChatBtn) {
    profileChatBtn.addEventListener('click', async () => {
      const fid = Number(appState.activeFriendProfileId || 0);
      if (!fid) return;
      const modal = bootstrap.Modal.getInstance(document.getElementById('friendProfileModal'));
      if (modal) modal.hide();
      await openPrivateChatWith(fid);
    });
  }
  const profileRemarkBtn = document.getElementById('friendProfileRemarkAction');
  if (profileRemarkBtn) {
    profileRemarkBtn.addEventListener('click', async () => {
      const fid = Number(appState.activeFriendProfileId || 0);
      if (!fid) return;
      await hideModalAndWait('friendProfileModal');
      await editFriendRemark(fid);
      cleanupStuckUiOverlay();
      openFriendProfileModal(fid);
    });
  }
  const profileDeleteBtn = document.getElementById('friendProfileDeleteAction');
  if (profileDeleteBtn) {
    profileDeleteBtn.addEventListener('click', () => {
      const fid = Number(appState.activeFriendProfileId || 0);
      if (!fid) return;
      openDeleteFriendConfirmModal(fid);
    });
  }
  const confirmDeleteFriendBtn = document.getElementById('confirmDeleteFriendBtn');
  if (confirmDeleteFriendBtn) {
    confirmDeleteFriendBtn.addEventListener('click', async () => {
      const fid = Number(document.getElementById('deleteFriendId')?.value || 0);
      if (!fid) return;
      const deletePeerMessages = !!document.getElementById('deleteFriendPeerMessages')?.checked;
      await removeFriend(fid, { deletePeerMessages });
      const deleteModal = bootstrap.Modal.getInstance(document.getElementById('deleteFriendModal'));
      if (deleteModal) deleteModal.hide();
      const profileModal = bootstrap.Modal.getInstance(document.getElementById('friendProfileModal'));
      if (profileModal) profileModal.hide();
      appState.activeFriendProfileId = null;
    });
  }
}

async function handleFriendSearch() {
  const inputEl = document.getElementById('friendSearchInput');
  const box = document.getElementById('friendSearchResults');
  if (!inputEl || !box) return;
  const keyword = inputEl.value.trim();
  box.innerHTML = '';

  if (!keyword) {
    box.innerHTML = '<div class="text-secondary small">请输入关键词</div>';
    return;
  }

  const isSelfByUsername = String(appState.currentUser?.username || '').toLowerCase() === keyword.toLowerCase();
  const isSelfById = String(appState.currentUser?.id || '') === keyword;
  if (isSelfByUsername || isSelfById) {
    box.innerHTML = '<div class="text-secondary small">不能添加自己，请输入对方账号</div>';
    return;
  }

  try {
    box.innerHTML = '<div class="text-secondary small">搜索中...</div>';
    const rawResults = await apiSearchUsers(keyword);
    const results = rawResults
      .map((item) => ({
        id: Number(item.id ?? item.user_id ?? item.uid ?? item.user?.id ?? 0),
        username: String(
          item.username ??
          item.account ??
          item.phone ??
          item.user_name ??
          item.user?.username ??
          item.user?.account ??
          item.user?.phone ??
          ''
        ),
        nickname: String(item.nickname ?? item.display_name ?? item.user?.nickname ?? ''),
        is_online: !!(item.is_online ?? item.online),
        avatar_base64: item.avatar_base64 || item.avatar || item.user?.avatar_base64 || item.user?.avatar || ''
      }))
      .filter((item) => item.id > 0 && Number(item.id) !== Number(appState.currentUser?.id || 0));

    if (!results.length) {
      box.innerHTML = '<div class="text-secondary small">无匹配结果（请确认前后端连接的是同一环境数据）</div>';
      return;
    }

    results.forEach((item) => {
      const isAdded = appState.friends.some((f) => f.id === item.id);
      const isPending = appState.outgoingRequests.some((r) => Number(r.to_user_id) === Number(item.id) && r.status === 'pending');
      const displayName = appState.friendRemarks[item.id] || item.nickname || item.username;
      mergeUserToMap({
        id: item.id,
        username: item.username,
        nickname: item.nickname,
        email: '',
        avatar_base64: item.avatar_base64 || appState.userMap[item.id]?.avatar || DEFAULT_AVATAR,
        is_online: item.is_online,
        role: 'member'
      });

      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center';
      const idText = item.username || String(item.id);
      row.innerHTML = `
        <div class="d-flex align-items-center gap-2">
          <img src="${item.avatar_base64 || DEFAULT_AVATAR}" width="32" height="32" class="rounded-circle" alt="avatar" />
          <div>
            <div class="fw-semibold">${displayName}</div>
            <small class="text-secondary">ID: ${escapeHtml(idText)}</small>
          </div>
        </div>
        <button class="btn btn-sm btn-outline-primary" ${(isAdded || isPending) ? 'disabled' : ''}>${isAdded ? '已添加' : (isPending ? '已申请' : '添加好友')}</button>
      `;
      if (!isAdded && !isPending) {
        row.querySelector('button').addEventListener('click', () => addFriendById(item.id, displayName));
      }
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<div class="text-danger small">搜索失败: ${err.status || 'ERR'} ${err.message}</div>`;
  }
}

async function addFriendById(friendId, displayName = '') {
  try {
    const message = prompt(`给 ${displayName || '对方'} 留言（可选）`, '你好，想加你为好友') ?? '';
    await apiSendFriendRequest(friendId, String(message).trim());
    await refreshFriendRequests();
    await refreshFriends();
    renderFriendRequestLists();
    await handleFriendSearch();
    alert('已发送好友申请，等待对方通过');
  } catch (err) {
    alert(`添加失败：${err.message}`);
  }
}

function openFriendProfileModal(friendId) {
  const f = appState.friends.find((x) => Number(x.id) === Number(friendId));
  if (!f) return;
  appState.activeFriendProfileId = f.id;
  const avatarEl = document.getElementById('friendProfileAvatar');
  const nameEl = document.getElementById('friendProfileName');
  const accountEl = document.getElementById('friendProfileAccount');
  const remarkEl = document.getElementById('friendProfileRemark');
  if (avatarEl) avatarEl.src = appState.userMap[f.id]?.avatar || DEFAULT_AVATAR;
  if (nameEl) nameEl.textContent = getDisplayNameByUserId(f.id);
  if (accountEl) accountEl.textContent = `@${f.username || ''}`;
  if (remarkEl) {
    const remark = appState.friendRemarks[f.id] || '';
    remarkEl.textContent = remark || '未设置';
  }
  const modal = new bootstrap.Modal(document.getElementById('friendProfileModal'));
  modal.show();
}

function renderFriendList() {
  const box = document.getElementById('friendList');
  const azBox = document.getElementById('friendAzIndex');
  if (!box) return;
  box.innerHTML = '';
  if (azBox) azBox.innerHTML = '';

  if (!appState.friends.length) {
    box.innerHTML = '<div class="p-3 text-secondary">还没有好友，点击右上角“+”选择“添加朋友”开始添加。</div>';
    return;
  }

  let sourceFriends = appState.friends;
  const keyword = String(appState.localFriendKeyword || '').trim().toLowerCase();
  if (keyword) {
    sourceFriends = appState.friends.filter((f) => {
      const display = String(getDisplayNameByUserId(f.id) || '').toLowerCase();
      return display.includes(keyword);
    });
  }
  if (!sourceFriends.length) {
    box.innerHTML = '<div class="p-3 text-secondary">未找到匹配好友</div>';
    return;
  }

  const { grouped, keys } = buildFriendGroups(sourceFriends);
  keys.forEach((key) => {
    const anchorKey = key === '#' ? 'HASH' : key;
    const title = document.createElement('div');
    title.className = 'contacts-group-title';
    title.id = `friendGroup-${anchorKey}`;
    title.textContent = key;
    box.appendChild(title);

    grouped[key].forEach((f) => {
      const avatar = appState.userMap[f.id]?.avatar || DEFAULT_AVATAR;
      const displayName = getDisplayNameByUserId(f.id);
      const item = document.createElement('button');
      item.className = 'contacts-friend-item';
      item.innerHTML = `
        <span class="contacts-friend-left">
          <img src="${avatar}" class="contacts-friend-avatar" alt="avatar" />
          <span>
            <span class="contacts-friend-name d-block">${displayName}</span>
            <span class="contacts-friend-sub">ID: ${f.username}</span>
          </span>
        </span>
        <span class="contacts-friend-actions">
          <span class="badge ${f.online ? 'text-bg-success' : 'text-bg-secondary'}">${f.online ? '在线' : '离线'}</span>
          <button class="btn btn-sm btn-outline-primary friend-chat-btn" type="button">聊天</button>
        </span>
      `;

      item.addEventListener('click', (e) => {
        e.preventDefault();
        openFriendProfileModal(f.id);
      });
      const chatBtn = item.querySelector('.friend-chat-btn');
      if (chatBtn) {
        chatBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await openPrivateChatWith(f.id);
        });
      }
      box.appendChild(item);
    });
  });

  if (azBox) {
    keys.forEach((key) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'contacts-az-index-btn';
      btn.textContent = key;
      btn.addEventListener('click', () => {
        const anchor = key === '#' ? 'HASH' : key;
        const target = document.getElementById(`friendGroup-${anchor}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      azBox.appendChild(btn);
    });
  }
}

async function editFriendRemark(friendId) {
  const current = appState.friendRemarks[friendId] || '';
  const remark = prompt('设置好友备注（留空为清除）', current);
  if (remark === null) return;
  try {
    await apiSetFriendRemark(friendId, remark.trim());
    await refreshFriendRemarks();
    renderFriendList();
    renderConversationList();
    renderMessages();
  } catch (err) {
    alert(`保存备注失败：${err.message}`);
  } finally {
    cleanupStuckUiOverlay();
  }
}

async function handleAcceptRequest(requestId) {
  try {
    await apiAcceptFriendRequest(requestId);
    await Promise.all([refreshFriends(), refreshFriendRequests(), refreshFriendRemarks(), refreshRoomsAndMessages(), refreshUnreadCounts()]);
    renderFriendList();
    renderFriendRequestLists();
    renderConversationList();
    renderMessages();
    renderGroupMemberOptions();
  } catch (err) {
    alert(`通过失败：${err.message}`);
  }
}

async function handleRejectRequest(requestId) {
  try {
    await apiRejectFriendRequest(requestId);
    await refreshFriendRequests();
    renderFriendRequestLists();
  } catch (err) {
    alert(`拒绝失败：${err.message}`);
  }
}

function switchNewFriendTab(tab) {
  appState.newFriendTab = tab === 'outgoing' ? 'outgoing' : 'incoming';
  const incomingBtn = document.getElementById('incomingTabBtn');
  const outgoingBtn = document.getElementById('outgoingTabBtn');
  const incomingWrap = document.getElementById('incomingRequestWrap');
  const outgoingWrap = document.getElementById('outgoingRequestWrap');
  if (incomingBtn) incomingBtn.classList.toggle('active', appState.newFriendTab === 'incoming');
  if (outgoingBtn) outgoingBtn.classList.toggle('active', appState.newFriendTab === 'outgoing');
  if (incomingWrap) incomingWrap.classList.toggle('d-none', appState.newFriendTab !== 'incoming');
  if (outgoingWrap) outgoingWrap.classList.toggle('d-none', appState.newFriendTab !== 'outgoing');
}

function renderFriendRequestLists() {
  const incomingBox = document.getElementById('incomingRequestList');
  const outgoingBox = document.getElementById('outgoingRequestList');
  const pendingBadge = document.getElementById('newFriendPendingCount');
  const incomingTabCount = document.getElementById('incomingTabCount');
  const outgoingTabCount = document.getElementById('outgoingTabCount');
  if (!incomingBox || !outgoingBox) return;

  incomingBox.innerHTML = '';
  outgoingBox.innerHTML = '';

  const incomingRows = appState.incomingRequestHistory || [];
  const outgoingRows = appState.outgoingRequestHistory || [];
  if (incomingTabCount) incomingTabCount.textContent = String(incomingRows.length);
  if (outgoingTabCount) outgoingTabCount.textContent = String(outgoingRows.length);
  const pendingCount = incomingRows.filter((r) => r.status === 'pending').length;
  if (pendingBadge) {
    pendingBadge.textContent = String(pendingCount);
    pendingBadge.classList.toggle('d-none', pendingCount <= 0);
  }
  const statusText = (status) => {
    if (status === 'accepted') return '已同意';
    if (status === 'rejected') return '已拒绝';
    return '待处理';
  };
  const statusBadgeClass = (status) => {
    if (status === 'accepted') return 'text-bg-success';
    if (status === 'rejected') return 'text-bg-secondary';
    return 'text-bg-warning';
  };

  if (!incomingRows.length) {
    incomingBox.innerHTML = '<div class="text-secondary small">暂无待处理申请</div>';
  } else {
    incomingRows.forEach((req) => {
      const fromName = req.from_nickname || req.from_username || getDisplayNameByUserId(req.from_user_id);
      const avatar = req.from_avatar_base64 || appState.userMap[req.from_user_id]?.avatar || DEFAULT_AVATAR;
      const note = (req.message || '').trim();
      const canHandle = req.status === 'pending';
      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center friend-request-item';
      row.innerHTML = `
        <div class="friend-request-main">
          <img src="${avatar}" class="friend-request-avatar" alt="avatar" />
          <div class="friend-request-body">
            <div class="friend-request-name">${fromName}</div>
            <small class="friend-request-meta d-block">ID：${escapeHtml(req.from_username || String(req.from_user_id || '未知'))}</small>
            <small class="friend-request-meta d-block">${note ? `附言：${note}` : '附言：无'}</small>
            <small class="friend-request-meta">申请时间：${formatTime(req.created_at)}</small>
          </div>
        </div>
        <div class="friend-request-side">
          <span class="badge ${statusBadgeClass(req.status)}">${statusText(req.status)}</span>
          ${canHandle ? '<div class="friend-request-actions"><button class="btn btn-sm btn-success req-accept-btn">通过</button><button class="btn btn-sm btn-outline-secondary req-reject-btn">拒绝</button></div>' : ''}
        </div>
      `;
      const acceptBtn = row.querySelector('.req-accept-btn');
      const rejectBtn = row.querySelector('.req-reject-btn');
      if (acceptBtn) acceptBtn.addEventListener('click', () => handleAcceptRequest(req.id));
      if (rejectBtn) rejectBtn.addEventListener('click', () => handleRejectRequest(req.id));
      incomingBox.appendChild(row);
    });
  }

  if (!outgoingRows.length) {
    outgoingBox.innerHTML = '<div class="text-secondary small">暂无发出的申请</div>';
  } else {
    outgoingRows.forEach((req) => {
      const toName = req.to_nickname || req.to_username || getDisplayNameByUserId(req.to_user_id);
      const avatar = req.to_avatar_base64 || appState.userMap[req.to_user_id]?.avatar || DEFAULT_AVATAR;
      const note = (req.message || '').trim();
      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center friend-request-item';
      row.innerHTML = `
        <div class="friend-request-main">
          <img src="${avatar}" class="friend-request-avatar" alt="avatar" />
          <div class="friend-request-body">
            <div class="friend-request-name">${toName}</div>
            <small class="friend-request-meta d-block">ID：${escapeHtml(req.to_username || String(req.to_user_id || '未知'))}</small>
            <small class="friend-request-meta d-block">${note ? `附言：${note}` : '附言：无'}</small>
            <small class="friend-request-meta">申请时间：${formatTime(req.created_at)}</small>
          </div>
        </div>
        <div class="friend-request-side">
          <span class="badge ${statusBadgeClass(req.status)}">${statusText(req.status)}</span>
        </div>
      `;
      outgoingBox.appendChild(row);
    });
  }
  switchNewFriendTab(appState.newFriendTab || 'incoming');
}

function renderFriendsLoadingState() {
  const friendBox = document.getElementById('friendList');
  const searchBox = document.getElementById('friendSearchResults');
  const inBox = document.getElementById('incomingRequestList');
  const outBox = document.getElementById('outgoingRequestList');
  if (friendBox) friendBox.innerHTML = '<div class="p-3 text-secondary">正在加载好友列表...</div>';
  if (searchBox) searchBox.innerHTML = '';
  if (inBox) inBox.innerHTML = '<div class="text-secondary small">正在加载申请...</div>';
  if (outBox) outBox.innerHTML = '<div class="text-secondary small">正在加载申请...</div>';
}

function renderFriendsErrorState(message) {
  const friendBox = document.getElementById('friendList');
  const inBox = document.getElementById('incomingRequestList');
  const outBox = document.getElementById('outgoingRequestList');
  const err = escapeHtml(message || '加载失败');
  if (friendBox) friendBox.innerHTML = `<div class="p-3 text-danger">好友列表加载失败：${err}</div>`;
  if (inBox) inBox.innerHTML = `<div class="text-danger small">申请加载失败：${err}</div>`;
  if (outBox) outBox.innerHTML = `<div class="text-danger small">申请加载失败：${err}</div>`;
}

async function ensureDirectRoomWithFriend(friendId) {
  let conv = getDmConversationWithFriend(friendId);
  if (conv) return conv;

  const friend = appState.friends.find((f) => f.id === friendId) || appState.userMap[friendId];
  const roomName = `${friend?.nickname || friend?.username || '好友'}-私聊`;
  try {
    await apiCreateRoom(roomName, [friendId]);
  } catch (_) {
    await apiFetch('/api/rooms/group', {
      method: 'POST',
      body: JSON.stringify({ title: roomName, member_ids: [friendId] })
    });
  }

  await refreshRoomsAndMessages();
  await refreshUnreadCounts();
  conv = getDmConversationWithFriend(friendId);
  if (!conv) throw new Error('创建/获取单聊房间失败');
  return conv;
}

async function openPrivateChatWith(friendId) {
  let conv;
  try {
    conv = await ensureDirectRoomWithFriend(friendId);
  } catch (err) {
    alert(`进入聊天失败：${err.message}`);
    return;
  }

  appState.activeConversationId = conv.id;
  appState.multiSelectMode = false;
  appState.multiSelectedMessageIds = new Set();
  conv.unreadCount = 0;
  clearReplyAndEditState();
  switchView('messagesView', { keepRoom: true });
  await refreshCurrentUserMuteState(conv.id);
  renderConversationList();
  renderMessages({ autoScroll: true, forceBottom: true });
  startRoomPolling(conv.id);
  updateUnreadBadges();
  markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
}

// ============================
// 群组系统
// ============================
function bindGroupEvents() {
  document.getElementById('createGroupBtn').addEventListener('click', async () => {
    const name = document.getElementById('groupNameInput').value.trim();
    if (!name) {
      alert('请输入群名称');
      return;
    }

    const checkedIds = [...document.querySelectorAll('.group-member-check:checked')].map((i) => Number(i.value));

    try {
      await apiCreateRoom(name, checkedIds);
      await refreshRoomsAndMessages();
      await refreshUnreadCounts();
      renderGroupList();
      renderConversationList();
      renderMessages();
      connectWebSocket();

      document.getElementById('groupNameInput').value = '';
      document.querySelectorAll('.group-member-check').forEach((i) => (i.checked = false));

      const modal = bootstrap.Modal.getInstance(document.getElementById('createGroupModal'));
      if (modal) modal.hide();
    } catch (err) {
      alert(`创建群聊失败：${err.message}`);
    }
  });

  document.getElementById('createGroupModal').addEventListener('show.bs.modal', renderGroupMemberOptions);
  const groupManageHistorySearchBtn = document.getElementById('groupManageHistorySearchBtn');
  if (groupManageHistorySearchBtn) {
    groupManageHistorySearchBtn.addEventListener('click', () => {
      const modal = bootstrap.Modal.getInstance(document.getElementById('groupManageModal'));
      if (modal) modal.hide();
      openHistorySearchModal();
    });
  }
  const groupManageHistoryPhotosBtn = document.getElementById('groupManageHistoryPhotosBtn');
  if (groupManageHistoryPhotosBtn) {
    groupManageHistoryPhotosBtn.addEventListener('click', () => {
      const modal = bootstrap.Modal.getInstance(document.getElementById('groupManageModal'));
      if (modal) modal.hide();
      openHistoryPhotosModal();
    });
  }
  const memberSearchInput = document.getElementById('groupMemberSearchInput');
  if (memberSearchInput) {
    memberSearchInput.addEventListener('input', () => {
      appState.groupMemberSearchKeyword = memberSearchInput.value || '';
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const me = appState.roomMyMemberMetaByRoom[groupId];
      const actor = {
        isOwner: me?.role === 'owner',
        canKick: !!appState.currentUser?.canKickMembers && !!(me?.role === 'owner' || me?.canKick),
        canMute: !!appState.currentUser?.canMuteMembers && !!(me?.role === 'owner' || me?.canMute)
      };
      renderGroupManageMembers(appState.managingGroupMembers || [], actor);
    });
  }
  const addBtn = document.getElementById('groupAddMemberBtn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const select = document.getElementById('groupAddMemberSelect');
      const userId = Number(select?.value || 0);
      if (!userId) return;
      const previousDisabled = addBtn.disabled;
      addBtn.disabled = true;
      try {
        await apiAddRoomMember(groupId, userId);
        // 关键写操作：以后端真实结果二次确认为准，避免前端“假成功”
        const verifiedMembers = await apiGetRoomMembers(groupId);
        const confirmed = (verifiedMembers || []).some((m) => Number(m.user_id) === Number(userId));
        if (!confirmed) {
          throw new Error('后端未确认拉群成功，请稍后重试');
        }
        await refreshRoomsAndMessages();
        await refreshGroupManageModal(groupId);
        renderGroupList();
        renderConversationList();
      } catch (err) {
        // 失败时强制回滚刷新，避免页面状态和后端状态不一致
        try {
          await refreshGroupManageModal(groupId);
          renderGroupList();
          renderConversationList();
        } catch (_) {
          // ignore rollback refresh errors
        }
        alert(`拉人失败：${err.message}`);
      } finally {
        addBtn.disabled = previousDisabled;
      }
    });
  }
  const rateLimitSaveBtn = document.getElementById('groupRateLimitSaveBtn');
  if (rateLimitSaveBtn) {
    rateLimitSaveBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const conv = findConversationById(groupId);
      if (!conv || conv.type !== 'group') return;

      const me = appState.roomMyMemberMetaByRoom[groupId];
      if (!me || me.role !== 'owner') {
        alert('仅群主可设置发言频率限制');
        return;
      }
      const select = document.getElementById('groupRateLimitSelect');
      const seconds = Number(select?.value || 0);
      try {
        const res = await apiSetRoomRateLimit(groupId, seconds);
        conv.rateLimitSeconds = Number(res?.rate_limit_seconds || seconds || 0);
        alert('群发言频率设置已保存');
        await refreshGroupManageModal(groupId);
      } catch (err) {
        alert(`保存失败：${err.message}`);
      }
    });
  }
  const settingsSaveBtn = document.getElementById('groupSettingsSaveBtn');
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const me = appState.roomMyMemberMetaByRoom[groupId];
      if (!me || me.role !== 'owner') {
        alert('仅群主可修改群管理设置');
        return;
      }
      const allowFriendAdd = !!document.getElementById('groupAllowFriendAddSwitch')?.checked;
      const allowInvite = !!document.getElementById('groupAllowInviteSwitch')?.checked;
      const inviteNeedApproval = !!document.getElementById('groupInviteApproveSwitch')?.checked;
      const globalMute = !!document.getElementById('groupGlobalMuteSwitch')?.checked;
      try {
        const updated = await apiUpdateRoom(groupId, {
          allow_member_friend_add: allowFriendAdd,
          allow_member_invite: allowInvite,
          invite_need_approval: inviteNeedApproval,
          global_mute: globalMute
        });
        const conv = findConversationById(groupId);
        if (conv) {
          conv.allowMemberFriendAdd = !!updated?.allow_member_friend_add;
          conv.allowMemberInvite = !!updated?.allow_member_invite;
          conv.inviteNeedApproval = updated?.invite_need_approval !== false;
          conv.globalMute = !!updated?.global_mute;
          renderMessages({ autoScroll: false });
          renderConversationList();
        }
        alert('群管理设置已保存');
      } catch (err) {
        alert(`保存失败：${err.message}`);
      }
    });
  }
  const muteListBtn = document.getElementById('groupMuteListBtn');
  if (muteListBtn) {
    muteListBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const me = appState.roomMyMemberMetaByRoom[groupId];
      if (!me || !appState.currentUser?.canMuteMembers || (me.role !== 'owner' && !me.canMute)) {
        alert('无权限查看禁言名单');
        return;
      }
      try {
        const rows = await apiGetRoomMuteList(groupId);
        renderGroupMuteList(rows || []);
        const modal = new bootstrap.Modal(document.getElementById('groupMuteListModal'));
        modal.show();
      } catch (err) {
        alert(`加载禁言名单失败：${err.message}`);
      }
    });
  }
  const exitGroupBtn = document.getElementById('groupExitBtn');
  if (exitGroupBtn) {
    exitGroupBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      if (!confirm('确定退出该群？')) return;
      try {
        await apiRemoveRoomMember(groupId, appState.currentUser.id);
        const manageModal = bootstrap.Modal.getInstance(document.getElementById('groupManageModal'));
        if (manageModal) manageModal.hide();
        if (appState.activeConversationId === groupId) {
          appState.activeConversationId = null;
          stopRoomPolling();
          renderMessages({ autoScroll: false });
        }
        await refreshRoomsAndMessages();
        renderGroupList();
        renderConversationList();
      } catch (err) {
        alert(`退出群失败：${err.message}`);
      }
    });
  }
  const groupAvatarEditBtn = document.getElementById('groupAvatarEditBtn');
  const groupAvatarInput = document.getElementById('groupAvatarInput');
  if (groupAvatarEditBtn && groupAvatarInput) {
    groupAvatarEditBtn.addEventListener('click', () => groupAvatarInput.click());
    groupAvatarInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const conv = findConversationById(groupId);
      const me = appState.roomMyMemberMetaByRoom[groupId];
      if (!conv || conv.type !== 'group' || !me || me.role !== 'owner') {
        alert('仅群主可修改群头像');
        return;
      }
      try {
        const base64 = await readFileAsDataURL(file);
        const updated = await apiUpdateRoom(groupId, { avatar: base64 });
        conv.avatar = updated?.avatar || base64;
        await refreshRoomsAndMessages();
        renderGroupList();
        renderConversationList();
        renderMessages();
        const latest = findConversationById(groupId);
        const avatarEl = document.getElementById('groupManageAvatar');
        if (avatarEl && latest) avatarEl.src = getConversationAvatar(latest);
        await refreshGroupManageModal(groupId);
        alert('群头像已更新');
      } catch (err) {
        alert(`更新群头像失败：${err.message}`);
      }
    });
  }
  const manageModalEl = document.getElementById('groupManageModal');
  if (manageModalEl) {
    manageModalEl.addEventListener('hidden.bs.modal', () => {
      appState.managingGroupId = null;
      appState.managingGroupMembers = [];
      appState.groupMemberSearchKeyword = '';
      const search = document.getElementById('groupMemberSearchInput');
      if (search) search.value = '';
    });
  }
  const forwardModalEl = document.getElementById('forwardMessageModal');
  if (forwardModalEl) {
    forwardModalEl.addEventListener('hidden.bs.modal', () => {
      appState.forwardingMessage = null;
      appState.forwardingMessages = [];
      appState.forwardTargetKeyword = '';
      appState.forwardSelectedRoomIds = new Set();
      const searchInput = document.getElementById('forwardTargetSearchInput');
      if (searchInput) searchInput.value = '';
      const checks = document.querySelectorAll('.forward-target-check');
      checks.forEach((c) => {
        c.checked = false;
      });
      const btn = document.getElementById('confirmForwardBtn');
      setButtonLoading(btn, false, '转发中...', '一键转发');
    });
  }
}

function renderGroupMemberOptions() {
  const box = document.getElementById('groupMemberOptions');
  box.innerHTML = '';

  if (!appState.friends.length) {
    box.innerHTML = '<div class="text-secondary small">暂无好友可选</div>';
    return;
  }

  appState.friends.forEach((f) => {
    const avatar = appState.userMap[f.id]?.avatar || DEFAULT_AVATAR;
    const wrap = document.createElement('label');
    wrap.className = 'd-flex align-items-center gap-2 mb-2';
    wrap.innerHTML = `
      <input class="form-check-input group-member-check" type="checkbox" value="${f.id}" />
      <img src="${avatar}" width="28" height="28" class="rounded-circle" alt="avatar" />
      <span>${getDisplayNameByUserId(f.id)}</span>
    `;
    box.appendChild(wrap);
  });
}

function renderGroupList() {
  const box = document.getElementById('groupList');
  box.innerHTML = '';

  const groups = appState.conversations.filter((c) => c.type === 'group');
  if (!groups.length) {
    box.innerHTML = '<div class="text-secondary">还没有群组，先创建一个吧。</div>';
    return;
  }

  groups.forEach((g) => {
    const names = g.members
      .map((id) => getGroupPublicDisplayNameByUserId(id))
      .join('、');

    const item = document.createElement('button');
    item.className = 'list-group-item list-group-item-action';
    const isOwner = Number(g.createdBy) === Number(appState.currentUser?.id);
    item.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <div class="fw-semibold">${g.name}</div>
          <small class="text-secondary">成员：${names}</small>
        </div>
        <div class="d-flex align-items-center gap-2">
          <span class="badge text-bg-info">${g.members.length}人</span>
          ${isOwner ? '<button class="btn btn-sm btn-outline-primary group-manage-btn" type="button">管理</button>' : ''}
        </div>
      </div>
    `;

    item.addEventListener('click', () => {
      appState.activeConversationId = g.id;
      g.unreadCount = 0;
      clearReplyAndEditState();
      switchView('messagesView', { keepRoom: true });
      refreshCurrentUserMuteState(g.id)
        .then(() => {
          renderConversationList();
          renderMessages({ autoScroll: true, forceBottom: true });
          startRoomPolling(g.id);
          updateUnreadBadges();
          markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
        })
        .catch((err) => {
          console.warn('刷新禁言状态失败', err.message);
          renderConversationList();
          renderMessages({ autoScroll: true, forceBottom: true });
          startRoomPolling(g.id);
        });
    });

    const manageBtn = item.querySelector('.group-manage-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openGroupManageModal(g.id).catch((err) => alert(`打开群管理失败：${err.message}`));
      });
    }

    box.appendChild(item);
  });
}

async function openGroupManageModal(groupId) {
  const conv = findConversationById(groupId);
  if (!conv || conv.type !== 'group') return;
  appState.managingGroupId = groupId;
  appState.groupMemberSearchKeyword = '';
  const titleEl = document.getElementById('groupManageTitle');
  if (titleEl) titleEl.textContent = `群资料 · ${conv.title || conv.name}`;
  const avatarEl = document.getElementById('groupManageAvatar');
  if (avatarEl) avatarEl.src = getConversationAvatar(conv);
  const nameEl = document.getElementById('groupManageName');
  if (nameEl) nameEl.textContent = conv.title || conv.name || '群聊';
  const countEl = document.getElementById('groupManageMemberCount');
  if (countEl) countEl.textContent = `${conv.memberCount || (conv.members || []).length} 人`;
  const descEl = document.getElementById('groupManageDescription');
  if (descEl) descEl.textContent = conv.description || '暂无简介';
  const noticeEl = document.getElementById('groupManageNotice');
  if (noticeEl) noticeEl.textContent = conv.notice || '暂无公告';
  await refreshGroupManageModal(groupId);
  const modal = new bootstrap.Modal(document.getElementById('groupManageModal'));
  modal.show();
}

async function refreshGroupManageModal(groupId) {
  const [members, _friends] = await Promise.all([apiGetRoomMembers(groupId), refreshFriends()]);
  appState.managingGroupMembers = members || [];
  const countEl = document.getElementById('groupManageMemberCount');
  if (countEl) countEl.textContent = `${(members || []).length} 人`;
  (members || []).forEach((m) => {
    mergeUserToMap({
      id: Number(m.user_id),
      username: m.username || '',
      nickname: m.nickname || '',
      email: '',
      avatar_base64: appState.userMap[m.user_id]?.avatar || DEFAULT_AVATAR,
      is_online: appState.onlineUserIds.has(Number(m.user_id)),
      role: m.role || 'member'
    });
  });
  const me = (members || []).find((m) => Number(m.user_id) === Number(appState.currentUser?.id));
  const actor = {
    isOwner: me?.role === 'owner',
    canKick: !!appState.currentUser?.canKickMembers && !!(me?.role === 'owner' || me?.can_kick),
    canMute: !!appState.currentUser?.canMuteMembers && !!(me?.role === 'owner' || me?.can_mute)
  };
  appState.roomMyMemberMetaByRoom[groupId] = {
    role: me?.role || 'member',
    canKick: !!me?.can_kick,
    canMute: !!me?.can_mute,
    muted: !!me?.muted
  };
  const owner = (members || []).find((m) => m.role === 'owner');
  const ownerEl = document.getElementById('groupOwnerName');
  if (ownerEl) ownerEl.textContent = owner ? getGroupPublicDisplayNameByUserId(owner.user_id) : '未知';
  const myNickEl = document.getElementById('groupMyNickname');
  if (myNickEl) myNickEl.textContent = appState.currentUser?.nickname || '未设置';

  const conv = findConversationById(groupId);
  const allowFriendAddEl = document.getElementById('groupAllowFriendAddSwitch');
  const allowInviteEl = document.getElementById('groupAllowInviteSwitch');
  const inviteApproveEl = document.getElementById('groupInviteApproveSwitch');
  const globalMuteEl = document.getElementById('groupGlobalMuteSwitch');
  const settingsControls = [allowFriendAddEl, allowInviteEl, inviteApproveEl, globalMuteEl];
  settingsControls.forEach((el) => {
    if (el) el.disabled = !actor.isOwner;
  });
  if (allowFriendAddEl) allowFriendAddEl.checked = !!conv?.allowMemberFriendAdd;
  if (allowInviteEl) allowInviteEl.checked = !!conv?.allowMemberInvite;
  if (inviteApproveEl) inviteApproveEl.checked = !!conv?.inviteNeedApproval;
  if (globalMuteEl) globalMuteEl.checked = !!conv?.globalMute;

  renderGroupManageMembers(members || [], actor);
  renderGroupAddMemberOptions(groupId, members || [], actor.isOwner);
  const select = document.getElementById('groupRateLimitSelect');
  const saveBtn = document.getElementById('groupRateLimitSaveBtn');
  const avatarEditBtn = document.getElementById('groupAvatarEditBtn');
  if (select) {
    const current = Number(conv?.rateLimitSeconds || 0);
    select.value = String([0, 3, 5, 10].includes(current) ? current : 0);
    select.disabled = !actor.isOwner;
  }
  if (saveBtn) saveBtn.disabled = !actor.isOwner;
  if (avatarEditBtn) avatarEditBtn.disabled = !actor.isOwner;
}

function renderGroupAddMemberOptions(groupId, members, isOwner) {
  const select = document.getElementById('groupAddMemberSelect');
  const addBtn = document.getElementById('groupAddMemberBtn');
  if (!select) return;
  if (addBtn) addBtn.disabled = !isOwner;
  select.disabled = !isOwner;
  if (!isOwner) {
    select.innerHTML = '<option value="">仅群主可添加成员</option>';
    return;
  }
  const memberIds = new Set((members || []).map((m) => Number(m.user_id)));
  const candidates = appState.friends.filter((f) => !memberIds.has(Number(f.id)));
  if (!candidates.length) {
    select.innerHTML = '<option value="">暂无可添加好友</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = candidates
    .map((u) => `<option value="${u.id}">${escapeHtml(getDisplayNameByUserId(u.id))}</option>`)
    .join('');
}

function renderGroupManageMembers(members, actor) {
  const box = document.getElementById('groupMemberManageList');
  if (!box) return;
  box.innerHTML = '';
  if (!members.length) {
    box.innerHTML = '<div class="text-secondary small">暂无成员</div>';
    return;
  }
  const keyword = (appState.groupMemberSearchKeyword || '').trim().toLowerCase();
  const filtered = keyword
    ? members.filter((m) => getGroupPublicDisplayNameByUserId(m.user_id).toLowerCase().includes(keyword))
    : members;
  if (!filtered.length) {
    box.innerHTML = '<div class="text-secondary small">未找到匹配成员</div>';
    return;
  }
  filtered.forEach((m) => {
    const isSelf = Number(m.user_id) === Number(appState.currentUser?.id);
    const targetDelegated = !!(m.can_kick || m.can_mute);
    const roleBadge = m.role === 'owner' ? '<span class="badge text-bg-warning ms-1">群主</span>' : '';
    const roleText = m.role === 'owner'
      ? '群主'
      : (m.can_kick && m.can_mute ? '管理员' : (m.can_kick ? '可踢人' : (m.can_mute ? '可禁言' : '成员')));
    const delegatedBadge = m.role !== 'owner' && (m.can_kick || m.can_mute)
      ? `<span class="badge text-bg-info ms-1">${roleText}</span>`
      : '';
    const isOnline = appState.onlineUserIds.has(Number(m.user_id)) || !!appState.userMap[m.user_id]?.online;
    const dotClass = isOnline ? 'on' : 'off';
    const onlineText = isOnline ? '在线' : '离线';
    const canOperateTarget = actor.isOwner || !targetDelegated;
    const canDeleteHistory = actor.canKick && canOperateTarget && !isSelf && m.role !== 'owner';
    const muteBtn = actor.canMute && canOperateTarget && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-secondary member-mute-btn">${m.muted ? '取消禁言' : '禁言'}</button>`
      : '';
    const removeBtn = actor.canKick && canOperateTarget && !isSelf && m.role !== 'owner'
      ? '<button class="btn btn-sm btn-outline-danger member-remove-btn">踢出</button>'
      : '';
    const grantKickBtn = actor.isOwner && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-primary member-grant-kick-btn">${m.can_kick ? '取消踢人权' : '赋予踢人权'}</button>`
      : '';
    const grantMuteBtn = actor.isOwner && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-primary member-grant-mute-btn">${m.can_mute ? '取消禁言权' : '赋予禁言权'}</button>`
      : '';
    const deleteMessagesBtn = canDeleteHistory
      ? '<button class="btn btn-sm btn-outline-warning member-delete-messages-btn">删发言</button>'
      : '';

    const row = document.createElement('div');
    row.className = 'list-group-item d-flex justify-content-between align-items-center';
    row.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <button class="btn btn-link p-0 member-avatar-action" type="button" title="成员操作">
          <img src="${getUserAvatarById(m.user_id)}" class="conversation-avatar" style="width:34px;height:34px;" alt="avatar" />
        </button>
        <div class="fw-semibold"><span class="online-dot ${dotClass}"></span>${escapeHtml(getGroupPublicDisplayNameByUserId(m.user_id))} ${roleBadge} ${delegatedBadge}</div>
        <small class="text-secondary">${onlineText} · ${roleText} ${m.muted ? '· 已禁言' : ''}</small>
      </div>
      <div class="d-flex gap-2">
        ${grantKickBtn}
        ${grantMuteBtn}
        ${deleteMessagesBtn}
        ${muteBtn}
        ${removeBtn}
      </div>
    `;
    const deleteMessagesAction = async () => {
      if (!canDeleteHistory) return;
      if (!confirm('确定删除该成员在本群的全部历史发言？')) return;
      if (!confirm('此操作不可恢复，确认继续？')) return;
      try {
        const res = await apiDeleteRoomMemberMessages(appState.managingGroupId, m.user_id);
        const conv = findConversationById(appState.managingGroupId);
        if (conv) {
          conv.messages = conv.messages.filter((x) => Number(x.senderId) !== Number(m.user_id));
          renderMessages({ autoScroll: false });
        }
        alert(`已删除 ${res?.deleted_count || 0} 条发言`);
      } catch (err) {
        alert(`删除成员发言失败：${err.message}`);
      }
    };
    const avatarAction = row.querySelector('.member-avatar-action');
    if (avatarAction) {
      avatarAction.addEventListener('click', () => {
        if (!canDeleteHistory) return;
        deleteMessagesAction().catch((err) => console.warn('删除成员发言失败', err.message));
      });
    }
    const muteEl = row.querySelector('.member-mute-btn');
    if (muteEl) {
      muteEl.addEventListener('click', async () => {
        try {
          if (m.muted) await apiUnmuteRoomMember(appState.managingGroupId, m.user_id);
          else await apiMuteRoomMember(appState.managingGroupId, m.user_id);
          await refreshRoomsAndMessages();
          await refreshGroupManageModal(appState.managingGroupId);
          renderGroupList();
        } catch (err) {
          alert(`操作失败：${err.message}`);
        }
      });
    }
    const removeEl = row.querySelector('.member-remove-btn');
    if (removeEl) {
      removeEl.addEventListener('click', async () => {
        if (!confirm('确定踢出该成员？')) return;
        try {
          await apiRemoveRoomMember(appState.managingGroupId, m.user_id);
          await refreshRoomsAndMessages();
          await refreshGroupManageModal(appState.managingGroupId);
          renderGroupList();
          if (appState.activeConversationId === appState.managingGroupId) {
            renderMessages({ autoScroll: false });
          }
        } catch (err) {
          alert(`踢人失败：${err.message}`);
        }
      });
    }
    const grantKickEl = row.querySelector('.member-grant-kick-btn');
    if (grantKickEl) {
      grantKickEl.addEventListener('click', async () => {
        try {
          await apiSetRoomMemberPermissions(appState.managingGroupId, m.user_id, !m.can_kick, !!m.can_mute);
          await refreshGroupManageModal(appState.managingGroupId);
        } catch (err) {
          alert(`设置权限失败：${err.message}`);
        }
      });
    }
    const grantMuteEl = row.querySelector('.member-grant-mute-btn');
    if (grantMuteEl) {
      grantMuteEl.addEventListener('click', async () => {
        try {
          await apiSetRoomMemberPermissions(appState.managingGroupId, m.user_id, !!m.can_kick, !m.can_mute);
          await refreshGroupManageModal(appState.managingGroupId);
        } catch (err) {
          alert(`设置权限失败：${err.message}`);
        }
      });
    }
    const deleteMessagesEl = row.querySelector('.member-delete-messages-btn');
    if (deleteMessagesEl) {
      deleteMessagesEl.addEventListener('click', () => {
        deleteMessagesAction().catch((err) => console.warn('删除成员发言失败', err.message));
      });
    }
    box.appendChild(row);
  });
}

function renderGroupMuteList(rows) {
  const box = document.getElementById('groupMuteListBox');
  if (!box) return;
  box.innerHTML = '';
  if (!rows || !rows.length) {
    box.innerHTML = '<div class="text-secondary small">当前没有被禁言成员</div>';
    return;
  }
  rows.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'list-group-item d-flex align-items-center justify-content-between';
    row.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <img src="${m.avatar_base64 || DEFAULT_AVATAR}" class="conversation-avatar" style="width:32px;height:32px;" alt="avatar" />
        <div>
          <div class="fw-semibold">${escapeHtml(getGroupPublicDisplayNameByUserId(m.user_id) || m.nickname || '群成员')}</div>
          <small class="text-secondary">已禁言</small>
        </div>
      </div>
      <button class="btn btn-sm btn-outline-secondary">解除</button>
    `;
    const btn = row.querySelector('button');
    if (btn) {
      btn.addEventListener('click', async () => {
        const groupId = appState.managingGroupId;
        if (!groupId) return;
        try {
          await apiUnmuteRoomMember(groupId, m.user_id);
          const list = await apiGetRoomMuteList(groupId);
          renderGroupMuteList(list || []);
          await refreshGroupManageModal(groupId);
          await refreshRoomsAndMessages();
        } catch (err) {
          alert(`解除禁言失败：${err.message}`);
        }
      });
    }
    box.appendChild(row);
  });
}

// ============================
// 聊天渲染 + 发送 + 编辑
// ============================
function renderComposerState() {
  const bar = document.getElementById('replyPreviewBar');
  const title = document.getElementById('replyPreviewTitle');
  const text = document.getElementById('replyPreviewText');
  const sendBtn = document.getElementById('sendMessageBtn');
  if (!bar || !title || !text || !sendBtn) return;

  if (appState.editingOwnMessageId) {
    const conv = findConversationById(appState.activeConversationId);
    const msg = conv?.messages.find((m) => m.id === appState.editingOwnMessageId);
    bar.classList.remove('d-none');
    title.textContent = '编辑消息';
    text.textContent = summarizeMessageText(msg?.text || '');
    sendBtn.textContent = '保存';
    return;
  }

  if (appState.replyingToMessage) {
    const m = appState.replyingToMessage;
    bar.classList.remove('d-none');
    title.textContent = `回复 ${getDisplayNameByUserId(m.senderId)}`;
    text.textContent = summarizeMessageText(m.text);
    sendBtn.textContent = '发送';
    return;
  }

  bar.classList.add('d-none');
  sendBtn.textContent = '发送';
}

function clearReplyAndEditState(options = {}) {
  const { resetInput = false } = options;
  const wasEditing = !!appState.editingOwnMessageId;
  appState.replyingToMessage = null;
  appState.editingOwnMessageId = null;
  if (resetInput && wasEditing) {
    const input = document.getElementById('messageInput');
    if (input) input.value = '';
  }
  renderComposerState();
}

function openHistorySearchModal() {
  const box = document.getElementById('historySearchResultList');
  const input = document.getElementById('historySearchInput');
  if (box) box.innerHTML = '<div class="text-secondary small">输入关键词后点击搜索</div>';
  if (input) input.value = '';
  const modal = new bootstrap.Modal(document.getElementById('historySearchModal'));
  modal.show();
}

function openHistoryPhotosModal() {
  openHistoryPhotos().catch((err) => console.warn('历史图片加载失败', err.message));
  const modal = new bootstrap.Modal(document.getElementById('historyPhotosModal'));
  modal.show();
}

function startReplyMessage(msg) {
  appState.editingOwnMessageId = null;
  appState.replyingToMessage = {
    id: msg.id,
    senderId: msg.senderId,
    text: msg.text
  };
  renderComposerState();
  const input = document.getElementById('messageInput');
  if (input) input.focus();
}

function startEditOwnMessage(msg) {
  if (!canEditOwnMessage(msg)) {
    alert('该消息不可编辑（仅自己发送的文本消息）');
    return;
  }
  appState.replyingToMessage = null;
  appState.editingOwnMessageId = msg.id;
  const input = document.getElementById('messageInput');
  if (input) {
    input.value = msg.text;
    input.focus();
  }
  renderComposerState();
}

function openMessageActionMenu(msg) {
  appState.actionTargetMessage = msg;
  const editBtn = document.getElementById('msgActionEditBtn');
  const recallBtn = document.getElementById('msgActionRecallBtn');
  const deleteBtn = document.getElementById('msgActionDeleteBtn');
  if (editBtn) editBtn.classList.toggle('d-none', !canEditOwnMessage(msg));
  if (recallBtn) recallBtn.classList.toggle('d-none', !canRecallMessage(msg));
  if (deleteBtn) deleteBtn.textContent = canUseSuperDelete() ? '删除/超级删除' : '删除';
  const modal = new bootstrap.Modal(document.getElementById('messageActionModal'));
  modal.show();
}

function enterMultiSelectMode(initialMessageId = null) {
  appState.multiSelectMode = true;
  appState.multiSelectedMessageIds = new Set();
  if (initialMessageId) appState.multiSelectedMessageIds.add(Number(initialMessageId));
  updateMultiSelectBar();
  renderMessages({ autoScroll: false });
}

function exitMultiSelectMode() {
  appState.multiSelectMode = false;
  appState.multiSelectedMessageIds = new Set();
  updateMultiSelectBar();
  renderMessages({ autoScroll: false });
}

function toggleMultiSelectMessage(messageId) {
  const id = Number(messageId);
  if (appState.multiSelectedMessageIds.has(id)) appState.multiSelectedMessageIds.delete(id);
  else appState.multiSelectedMessageIds.add(id);
  updateMultiSelectBar();
  const row = document.querySelector(`.msg-row[data-message-id="${id}"]`);
  if (row) row.classList.toggle('selected', appState.multiSelectedMessageIds.has(id));
  const checkbox = row?.querySelector('.msg-select-check');
  if (checkbox) checkbox.checked = appState.multiSelectedMessageIds.has(id);
}

function updateMultiSelectBar() {
  const bar = document.getElementById('multiSelectBar');
  const countEl = document.getElementById('multiSelectCount');
  const toggleBtn = document.getElementById('multiSelectToggleBtn');
  const clearBtn = document.getElementById('multiSelectClearBtn');
  const forwardBtn = document.getElementById('multiForwardBtn');
  if (bar) bar.classList.toggle('d-none', !appState.multiSelectMode);
  const selectedCount = appState.multiSelectedMessageIds.size;
  if (countEl) countEl.textContent = String(selectedCount);
  if (toggleBtn) {
    toggleBtn.classList.toggle('d-none', !appState.activeConversationId);
    toggleBtn.textContent = appState.multiSelectMode ? '退出多选' : '多选';
  }
  if (clearBtn) clearBtn.disabled = selectedCount === 0;
  if (forwardBtn) forwardBtn.disabled = selectedCount === 0;
}

function openForwardModal(msg) {
  const list = Array.isArray(msg) ? msg : [msg];
  appState.forwardingMessages = list.filter(Boolean);
  appState.forwardingMessage = appState.forwardingMessages[0] || null;
  appState.forwardTargetKeyword = '';
  appState.forwardSelectedRoomIds = new Set();
  const preview = document.getElementById('forwardPreviewText');
  if (preview) {
    if (appState.forwardingMessages.length > 1) {
      preview.textContent = `将批量转发 ${appState.forwardingMessages.length} 条消息`;
    } else {
      const only = appState.forwardingMessage;
      preview.textContent = isImageMessageText(only?.text)
        ? '将转发一条图片消息'
        : `将转发：${summarizeMessageText(only?.text || '')}`;
    }
  }
  const searchInput = document.getElementById('forwardTargetSearchInput');
  if (searchInput) searchInput.value = '';
  renderForwardTargetList();
  const modal = new bootstrap.Modal(document.getElementById('forwardMessageModal'));
  modal.show();
  if (searchInput) setTimeout(() => searchInput.focus(), 120);
}

function renderForwardTargetList() {
  const box = document.getElementById('forwardTargetList');
  if (!box) return;
  box.innerHTML = '';
  const selected = new Set(appState.forwardSelectedRoomIds || []);
  const keyword = String(appState.forwardTargetKeyword || '').trim().toLowerCase();
  const list = (appState.conversations || []).slice().sort((a, b) => {
    const ta = a.messages.length ? a.messages[a.messages.length - 1].createdAt : 0;
    const tb = b.messages.length ? b.messages[b.messages.length - 1].createdAt : 0;
    return tb - ta;
  }).filter((conv) => {
    if (!keyword) return true;
    return getConversationTitle(conv).toLowerCase().includes(keyword);
  });
  if (!list.length) {
    box.innerHTML = '<div class="text-secondary small">没有匹配的目标会话</div>';
    return;
  }
  list.forEach((conv) => {
    const isGroup = conv.type === 'group';
    const row = document.createElement('label');
    row.className = 'list-group-item d-flex align-items-center gap-2';
    row.innerHTML = `
      <input class="form-check-input forward-target-check" type="checkbox" value="${conv.id}" />
      <img src="${getConversationAvatar(conv)}" class="conversation-avatar" style="width:28px;height:28px;" alt="avatar" />
      <div class="flex-grow-1">
        <div class="fw-semibold">${escapeHtml(getConversationTitle(conv))}</div>
        <small class="text-secondary">${isGroup ? '群聊' : '单聊'}</small>
      </div>
    `;
    const check = row.querySelector('.forward-target-check');
    if (check) {
      check.checked = selected.has(Number(conv.id));
      check.addEventListener('change', () => {
        if (check.checked) selected.add(Number(conv.id));
        else selected.delete(Number(conv.id));
        appState.forwardSelectedRoomIds = selected;
      });
    }
    box.appendChild(row);
  });
  appState.forwardSelectedRoomIds = selected;
}

function getImageUrlFromMessageText(text) {
  const raw = String(text || '');
  const match = raw.match(/^!\[img\]\(([^)]+)\)$/);
  return match ? match[1].trim() : '';
}

async function ensureConversationHistoryLoaded(conv, options = {}) {
  const maxPages = Number(options.maxPages || 4);
  let page = 0;
  while (conv.hasMore !== false && page < maxPages && conv.messages.length > 0) {
    const oldest = conv.messages[0];
    if (!oldest) break;
    const batch = await apiGetRoomMessagesBefore(conv.id, oldest.id, 50);
    if (!batch.length) {
      conv.hasMore = false;
      break;
    }
    const normalized = batch.map(normalizeMessage).reverse();
    const exists = new Set(conv.messages.map((m) => m.id));
    const toPrepend = normalized.filter((m) => !exists.has(m.id));
    if (!toPrepend.length) {
      conv.hasMore = false;
      break;
    }
    conv.messages = [...toPrepend, ...conv.messages];
    conv.hasMore = batch.length === 50;
    page += 1;
  }
}

function renderHistorySearchResults(conv, results) {
  const box = document.getElementById('historySearchResultList');
  if (!box) return;
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = '<div class="text-secondary small">未找到匹配消息</div>';
    return;
  }
  results.forEach((msg) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'list-group-item list-group-item-action';
    const sender = getDisplayNameByUserId(msg.senderId);
    row.innerHTML = `
      <div class="d-flex justify-content-between gap-2">
        <div class="fw-semibold">${escapeHtml(sender)}</div>
        <small class="text-secondary">${formatTime(msg.createdAt)}</small>
      </div>
      <div class="text-secondary small mt-1">${escapeHtml(summarizeMessageText(msg.text))}</div>
    `;
    row.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
      clearReplyAndEditState();
      switchView('messagesView', { keepRoom: true });
      renderConversationList();
      renderMessages({ autoScroll: false });
      startRoomPolling(conv.id);
      jumpToMessageById(msg.id);
      const modal = bootstrap.Modal.getInstance(document.getElementById('historySearchModal'));
      if (modal) modal.hide();
    });
    box.appendChild(row);
  });
}

function jumpToMessageById(messageId) {
  setTimeout(() => {
    const target = document.querySelector(`.msg-row[data-message-id="${messageId}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('history-hit');
      setTimeout(() => target.classList.remove('history-hit'), 1300);
    }
  }, 80);
}

async function revealAndJumpToMessage(messageId) {
  const conv = findConversationById(appState.activeConversationId);
  if (!conv || !messageId) return;
  const targetId = Number(messageId);
  let found = conv.messages.some((m) => Number(m.id) === targetId);
  let page = 0;
  while (!found && conv.hasMore !== false && page < 8) {
    const oldest = conv.messages[0];
    if (!oldest) break;
    const batch = await apiGetRoomMessagesBefore(conv.id, oldest.id, 50);
    if (!batch.length) {
      conv.hasMore = false;
      break;
    }
    const normalized = batch.map(normalizeMessage).reverse();
    const exists = new Set(conv.messages.map((m) => Number(m.id)));
    const toPrepend = normalized.filter((m) => !exists.has(Number(m.id)));
    if (!toPrepend.length) {
      conv.hasMore = false;
      break;
    }
    conv.messages = [...toPrepend, ...conv.messages];
    conv.hasMore = batch.length === 50;
    page += 1;
    found = conv.messages.some((m) => Number(m.id) === targetId);
  }
  if (!found) {
    alert('未找到被引用的原消息');
    return;
  }
  setMessageRenderLimit(conv.id, Math.max(getMessageRenderLimit(conv.id), conv.messages.length));
  renderMessages({ autoScroll: false });
  jumpToMessageById(targetId);
}

async function doHistorySearch() {
  const conv = findConversationById(appState.activeConversationId);
  const input = document.getElementById('historySearchInput');
  const box = document.getElementById('historySearchResultList');
  if (!input || !box) return;
  if (!conv) {
    box.innerHTML = '<div class="text-secondary small">请先选择一个会话</div>';
    return;
  }
  const keyword = input.value.trim();
  if (!keyword) {
    box.innerHTML = '<div class="text-secondary small">请输入搜索关键词</div>';
    return;
  }
  box.innerHTML = '<div class="text-secondary small">搜索中...</div>';
  try {
    await ensureConversationHistoryLoaded(conv, { maxPages: 6 });
    const lower = keyword.toLowerCase();
    const results = conv.messages
      .filter((m) => !isImageMessageText(m.text) && String(m.text || '').toLowerCase().includes(lower))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 80);
    renderHistorySearchResults(conv, results);
  } catch (err) {
    box.innerHTML = `<div class="text-danger small">搜索失败：${escapeHtml(err.message || '未知错误')}</div>`;
  }
}

function renderHistoryPhotoGrid(conv) {
  const grid = document.getElementById('historyPhotoGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const photos = conv.messages
    .filter((m) => isImageMessageText(m.text))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!photos.length) {
    grid.innerHTML = '<div class="text-secondary small">当前会话暂无历史图片</div>';
    return;
  }
  photos.forEach((msg) => {
    const url = getImageUrlFromMessageText(msg.text);
    if (!url) return;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'history-photo-item';
    card.innerHTML = `
      <img src="${escapeHtml(url)}" alt="历史图片" />
      <div class="history-photo-meta">${escapeHtml(getDisplayNameByUserId(msg.senderId))} · ${formatConversationTime(msg.createdAt)}</div>
      <div class="history-photo-locate">定位消息</div>
    `;
    card.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
      switchView('messagesView', { keepRoom: true });
      renderConversationList();
      renderMessages({ autoScroll: false });
      startRoomPolling(conv.id);
      jumpToMessageById(msg.id);
      const photosModal = bootstrap.Modal.getInstance(document.getElementById('historyPhotosModal'));
      if (photosModal) photosModal.hide();
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const previewImg = document.getElementById('photoPreviewImg');
      const previewMeta = document.getElementById('photoPreviewMeta');
      if (previewImg) previewImg.src = url;
      if (previewMeta) previewMeta.textContent = `${getDisplayNameByUserId(msg.senderId)} · ${formatTime(msg.createdAt)}`;
      const previewModal = new bootstrap.Modal(document.getElementById('photoPreviewModal'));
      previewModal.show();
    });
    grid.appendChild(card);
  });
}

async function openHistoryPhotos() {
  const conv = findConversationById(appState.activeConversationId);
  const grid = document.getElementById('historyPhotoGrid');
  if (!grid) return;
  if (!conv) {
    grid.innerHTML = '<div class="text-secondary small">请先选择一个会话</div>';
    return;
  }
  grid.innerHTML = '<div class="text-secondary small">加载中...</div>';
  try {
    await ensureConversationHistoryLoaded(conv, { maxPages: 5 });
    renderHistoryPhotoGrid(conv);
  } catch (err) {
    grid.innerHTML = `<div class="text-danger small">加载失败：${escapeHtml(err.message || '未知错误')}</div>`;
  }
}

async function forwardMessageToSelectedTargets() {
  const messages = (appState.forwardingMessages && appState.forwardingMessages.length)
    ? appState.forwardingMessages
    : (appState.forwardingMessage ? [appState.forwardingMessage] : []);
  if (!messages.length) return;
  const targets = [...(appState.forwardSelectedRoomIds || [])].map((id) => Number(id)).filter(Boolean);
  if (!targets.length) {
    alert('请至少选择一个目标会话');
    return;
  }

  const btn = document.getElementById('confirmForwardBtn');
  setButtonLoading(btn, true, '转发中...', '一键转发');

  const success = [];
  const failed = [];

  for (const roomId of targets) {
    const conv = findConversationById(roomId);
    try {
      for (const msg of messages) {
        const sent = await apiSendMessageDirect(roomId, msg.text);
        const normalized = normalizeMessage(sent);
        if (conv) {
          const exists = conv.messages.some((m) => m.id === normalized.id);
          if (!exists) conv.messages.push(normalized);
        }
        if (appState.activeConversationId === roomId && conv) {
          appendMessagesToView(conv, [normalized], { autoScroll: true });
          await markCurrentRoomRead();
        }
      }
      success.push(conv?.title || conv?.name || `会话${roomId}`);
    } catch (err) {
      failed.push(`${conv?.title || conv?.name || roomId}: ${err.message}`);
    }
  }

  setButtonLoading(btn, false, '转发中...', '一键转发');
  const modal = bootstrap.Modal.getInstance(document.getElementById('forwardMessageModal'));
  if (modal) modal.hide();
  appState.forwardingMessage = null;
  appState.forwardingMessages = [];
  if (appState.multiSelectMode) exitMultiSelectMode();
  renderConversationList();
  updateUnreadBadges();

  if (!failed.length) {
    alert(`转发成功：${success.length} 个会话`);
    return;
  }
  alert(`转发完成：成功 ${success.length}，失败 ${failed.length}\n${failed.slice(0, 3).join('\n')}`);
}

function bindChatEvents() {
  const sendBtn = document.getElementById('sendMessageBtn');
  const msgInput = document.getElementById('messageInput');
  const saveEditBtn = document.getElementById('saveEditMessageBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const msgList = getMessageScrollContainer();
  const uploadImageBtn = document.getElementById('uploadImageBtn');
  const imageInput = document.getElementById('imageInput');
  const clearReplyBtn = document.getElementById('clearReplyBtn');
  const actionReplyBtn = document.getElementById('msgActionReplyBtn');
  const actionEditBtn = document.getElementById('msgActionEditBtn');
  const actionRecallBtn = document.getElementById('msgActionRecallBtn');
  const actionMultiBtn = document.getElementById('msgActionMultiBtn');
  const actionForwardBtn = document.getElementById('msgActionForwardBtn');
  const actionDeleteBtn = document.getElementById('msgActionDeleteBtn');
  const deleteForPeerCheck = document.getElementById('deleteForPeerCheck');
  const confirmDeleteMessageBtn = document.getElementById('confirmDeleteMessageBtn');
  const mobileBackBtn = document.getElementById('mobileBackToListBtn');
  const voiceCallBtn = document.getElementById('voiceCallBtn');
  const videoCallBtn = document.getElementById('videoCallBtn');
  const incomingAcceptBtn = document.getElementById('incomingAcceptBtn');
  const incomingRejectBtn = document.getElementById('incomingRejectBtn');
  const callHangupBtn = document.getElementById('callHangupBtn');
  const callMuteBtn = document.getElementById('callMuteBtn');
  const callSpeakerBtn = document.getElementById('callSpeakerBtn');
  const callToggleCameraBtn = document.getElementById('callToggleCameraBtn');
  const confirmForwardBtn = document.getElementById('confirmForwardBtn');
  const historySearchBtn = document.getElementById('historySearchBtn');
  const historyPhotosBtn = document.getElementById('historyPhotosBtn');
  const historySearchDoBtn = document.getElementById('historySearchDoBtn');
  const historySearchInput = document.getElementById('historySearchInput');
  const chatDetailsBtn = document.getElementById('chatDetailsBtn');
  const multiSelectToggleBtn = document.getElementById('multiSelectToggleBtn');
  const multiSelectCancelBtn = document.getElementById('multiSelectCancelBtn');
  const multiForwardBtn = document.getElementById('multiForwardBtn');
  const multiSelectSelectAllBtn = document.getElementById('multiSelectSelectAllBtn');
  const multiSelectClearBtn = document.getElementById('multiSelectClearBtn');
  const forwardTargetSearchInput = document.getElementById('forwardTargetSearchInput');
  const chatHeaderMain = document.getElementById('chatHeaderMain');
  const emojiToggleBtn = document.getElementById('emojiToggleBtn');
  const directDetailsHistorySearchBtn = document.getElementById('directDetailsHistorySearchBtn');
  const directDetailsHistoryPhotosBtn = document.getElementById('directDetailsHistoryPhotosBtn');

  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (msgInput) msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  if (msgInput) {
    msgInput.addEventListener('input', () => {
      setLocalTypingHint(!!msgInput.value.trim());
      if (appState.localTypingTimer) clearTimeout(appState.localTypingTimer);
      appState.localTypingTimer = setTimeout(() => setLocalTypingHint(false), 1400);
      const conv = findConversationById(appState.activeConversationId);
      if (!conv || conv.type !== 'group') {
        hideMentionSuggestions();
        return;
      }
      const caretPos = msgInput.selectionStart ?? msgInput.value.length;
      const found = extractMentionKeyword(msgInput.value, caretPos);
      if (!found) {
        hideMentionSuggestions();
        return;
      }
      renderMentionSuggestions(conv, found.keyword || '');
    });
    msgInput.addEventListener('blur', () => {
      if (appState.localTypingTimer) clearTimeout(appState.localTypingTimer);
      setLocalTypingHint(false);
      setTimeout(() => hideMentionSuggestions(), 120);
    });
  }
  document.addEventListener('click', (e) => {
    const box = document.getElementById('mentionSuggestBox');
    const input = document.getElementById('messageInput');
    if (!box || box.classList.contains('d-none')) return;
    if (box.contains(e.target) || e.target === input) return;
    hideMentionSuggestions();
  });
  if (msgInput) msgInput.addEventListener('focus', () => {
    setTimeout(() => scrollMessagesToBottom({ force: false }), 120);
  });
  if (saveEditBtn) saveEditBtn.addEventListener('click', saveEditedMessage);
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreMessages);
  if (uploadImageBtn && imageInput) {
    uploadImageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', handleImageUpload);
  }
  if (clearReplyBtn) clearReplyBtn.addEventListener('click', () => clearReplyAndEditState({ resetInput: true }));
  if (actionReplyBtn) actionReplyBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    startReplyMessage(appState.actionTargetMessage);
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
  });
  if (actionEditBtn) actionEditBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    startEditOwnMessage(appState.actionTargetMessage);
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
  });
  if (actionRecallBtn) actionRecallBtn.addEventListener('click', async () => {
    const msg = appState.actionTargetMessage;
    if (!msg) return;
    const actionModal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (actionModal) actionModal.hide();
    if (!canRecallMessage(msg)) {
      alert('该消息不可撤回');
      return;
    }
    try {
      const updated = await apiRecallMessage(msg.id);
      const conv = findConversationById(updated.room_id);
      if (conv) {
        const target = conv.messages.find((m) => Number(m.id) === Number(updated.id));
        if (target) {
          target.text = updated.content;
          target.updatedAt = updated.updated_at ? new Date(updated.updated_at).getTime() : target.updatedAt;
        }
      }
      renderMessages({ autoScroll: false });
      scheduleConversationListRender();
    } catch (err) {
      alert(`撤回失败：${err.message}`);
    }
  });
  if (actionForwardBtn) actionForwardBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    const msg = appState.actionTargetMessage;
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
    openForwardModal(msg);
  });
  if (actionDeleteBtn) actionDeleteBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    const conv = findConversationById(appState.activeConversationId);
    const allowSuperDelete = !!(conv && isDmConversation(conv) && canUseSuperDelete());
    if (deleteForPeerCheck) {
      deleteForPeerCheck.checked = false;
      deleteForPeerCheck.disabled = !allowSuperDelete;
    }
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
    const deleteModal = new bootstrap.Modal(document.getElementById('deleteMessageModal'));
    deleteModal.show();
  });
  if (actionMultiBtn) actionMultiBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
    enterMultiSelectMode(appState.actionTargetMessage.id);
  });
  if (multiSelectToggleBtn) {
    multiSelectToggleBtn.addEventListener('click', () => {
      if (!appState.activeConversationId) return;
      if (appState.multiSelectMode) exitMultiSelectMode();
      else enterMultiSelectMode();
    });
  }
  if (multiSelectCancelBtn) multiSelectCancelBtn.addEventListener('click', exitMultiSelectMode);
  if (multiForwardBtn) {
    multiForwardBtn.addEventListener('click', () => {
      if (!appState.multiSelectMode || appState.multiSelectedMessageIds.size === 0) {
        alert('请先选择要转发的消息');
        return;
      }
      const conv = findConversationById(appState.activeConversationId);
      if (!conv) return;
      const selected = conv.messages.filter((m) => appState.multiSelectedMessageIds.has(Number(m.id)));
      if (!selected.length) {
        alert('未找到可转发消息');
        return;
      }
      openForwardModal(selected);
    });
  }
  if (confirmDeleteMessageBtn) {
    confirmDeleteMessageBtn.addEventListener('click', async () => {
      const msg = appState.actionTargetMessage;
      if (!msg) return;
      const conv = findConversationById(appState.activeConversationId);
      if (!conv) return;
      const deleteForPeer = !!(deleteForPeerCheck && deleteForPeerCheck.checked);
      const deleteModal = bootstrap.Modal.getInstance(document.getElementById('deleteMessageModal'));
      try {
        if (deleteForPeer) {
          await apiSuperDeleteMessage(msg.id);
          conv.messages = conv.messages.filter((m) => Number(m.id) !== Number(msg.id));
        } else {
          conv.messages = conv.messages.filter((m) => Number(m.id) !== Number(msg.id));
        }
        renderMessages({ autoScroll: false });
        scheduleConversationListRender();
        if (deleteModal) deleteModal.hide();
      } catch (err) {
        alert(`删除失败：${err.message}`);
      }
    });
  }
  if (multiSelectSelectAllBtn) {
    multiSelectSelectAllBtn.addEventListener('click', () => {
      if (!appState.multiSelectMode) return;
      const conv = findConversationById(appState.activeConversationId);
      if (!conv) return;
      const visible = getRenderableMessages(conv);
      visible.forEach((m) => appState.multiSelectedMessageIds.add(Number(m.id)));
      updateMultiSelectBar();
      renderMessages({ autoScroll: false });
    });
  }
  if (multiSelectClearBtn) {
    multiSelectClearBtn.addEventListener('click', () => {
      if (!appState.multiSelectMode) return;
      appState.multiSelectedMessageIds = new Set();
      updateMultiSelectBar();
      renderMessages({ autoScroll: false });
    });
  }
  if (forwardTargetSearchInput) {
    forwardTargetSearchInput.addEventListener('input', () => {
      appState.forwardTargetKeyword = forwardTargetSearchInput.value || '';
      renderForwardTargetList();
    });
  }
  if (mobileBackBtn) mobileBackBtn.addEventListener('click', () => {
    appState.activeConversationId = null;
    appState.multiSelectMode = false;
    appState.multiSelectedMessageIds = new Set();
    clearReplyAndEditState({ resetInput: true });
    stopRoomPolling();
    renderConversationList();
    renderMessages({ autoScroll: false });
  });
  if (voiceCallBtn) voiceCallBtn.addEventListener('click', () => startCall('audio'));
  if (videoCallBtn) videoCallBtn.addEventListener('click', () => startCall('video'));
  if (incomingAcceptBtn) incomingAcceptBtn.addEventListener('click', acceptIncomingCall);
  if (incomingRejectBtn) incomingRejectBtn.addEventListener('click', rejectIncomingCall);
  if (callHangupBtn) callHangupBtn.addEventListener('click', () => endActiveCall({ localOnly: false, reason: 'manual_hangup' }));
  if (callMuteBtn) callMuteBtn.addEventListener('click', toggleCallMute);
  if (callSpeakerBtn) callSpeakerBtn.addEventListener('click', () => {
    toggleSpeakerMode().catch((err) => console.warn('扩音切换失败:', err.message));
  });
  if (callToggleCameraBtn) callToggleCameraBtn.addEventListener('click', toggleCallCamera);
  if (confirmForwardBtn) confirmForwardBtn.addEventListener('click', () => {
    forwardMessageToSelectedTargets().catch((err) => alert(`转发失败：${err.message}`));
  });
  if (historySearchBtn) historySearchBtn.addEventListener('click', openHistorySearchModal);
  if (historySearchDoBtn) historySearchDoBtn.addEventListener('click', () => {
    doHistorySearch().catch((err) => console.warn('历史搜索失败', err.message));
  });
  if (historySearchInput) {
    historySearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doHistorySearch().catch((err) => console.warn('历史搜索失败', err.message));
      }
    });
  }
  if (historyPhotosBtn) historyPhotosBtn.addEventListener('click', openHistoryPhotosModal);
  if (directDetailsHistorySearchBtn) directDetailsHistorySearchBtn.addEventListener('click', () => {
    const modal = bootstrap.Modal.getInstance(document.getElementById('directDetailsModal'));
    if (modal) modal.hide();
    openHistorySearchModal();
  });
  if (directDetailsHistoryPhotosBtn) directDetailsHistoryPhotosBtn.addEventListener('click', () => {
    const modal = bootstrap.Modal.getInstance(document.getElementById('directDetailsModal'));
    if (modal) modal.hide();
    openHistoryPhotosModal();
  });

  const openChatDetailsPanel = () => {
    const conv = findConversationById(appState.activeConversationId);
    if (!conv) return;
    if (conv.type === 'group') {
      openGroupManageModal(conv.id).catch((err) => alert(`打开群资料失败：${err.message}`));
      return;
    }
    const avatarEl = document.getElementById('directDetailsAvatar');
    const nameEl = document.getElementById('directDetailsName');
    const statusEl = document.getElementById('directDetailsStatus');
    const other = getOtherUserInPrivateConversation(conv);
    if (avatarEl) avatarEl.src = getConversationAvatar(conv);
    if (nameEl) nameEl.textContent = getConversationTitle(conv);
    if (statusEl) statusEl.textContent = other?.online ? '在线' : '离线';
    const modal = new bootstrap.Modal(document.getElementById('directDetailsModal'));
    modal.show();
  };
  if (chatDetailsBtn) chatDetailsBtn.addEventListener('click', openChatDetailsPanel);
  if (chatHeaderMain) {
    chatHeaderMain.addEventListener('click', () => {
      const conv = findConversationById(appState.activeConversationId);
      if (!conv) return;
      openChatDetailsPanel();
    });
  }

  if (emojiToggleBtn) {
    emojiToggleBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleEmojiPanel();
    });
  }

  // 上滑到顶部自动触发历史加载
  if (msgList) msgList.addEventListener('scroll', () => {
    const listEl = getMessageScrollContainer();
    if (!listEl) return;
    appState.userNearBottom = isNearBottom(listEl, 220);
    if (listEl.scrollTop <= 10) {
      loadMoreMessages();
    }
  });

  window.addEventListener('resize', () => {
    if (appState.currentView === 'messagesView' && appState.activeConversationId) {
      scrollMessagesToBottom({ force: false });
    }
    const conv = findConversationById(appState.activeConversationId);
    setChatPaneVisible(!!conv);
    updateMultiSelectBar();
    updateCallButtonsState();
  });

  const emojiBar = document.getElementById('emojiBar');
  if (emojiBar) {
    EMOJIS.forEach((emoji) => {
      const b = document.createElement('button');
      b.className = 'btn btn-light btn-sm';
      b.textContent = emoji;
      b.addEventListener('click', () => {
        const input = document.getElementById('messageInput');
        input.value += emoji;
        input.focus();
        toggleEmojiPanel(false);
      });
      emojiBar.appendChild(b);
    });
  }

  document.addEventListener('click', (e) => {
    const bar = document.getElementById('emojiBar');
    const toggleBtn = document.getElementById('emojiToggleBtn');
    if (!bar || bar.classList.contains('d-none')) return;
    if (bar.contains(e.target)) return;
    if (toggleBtn && toggleBtn.contains(e.target)) return;
    toggleEmojiPanel(false);
  });
}

async function handleImageUpload(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    alert('请先选择一个会话');
    return;
  }
  if (appState.editingOwnMessageId) {
    alert('编辑状态下不支持发送图片，请先完成或取消编辑');
    return;
  }
  if (conv.type === 'group' && appState.roomMuteStateByRoom[conv.id]) {
    alert('你已被群主禁言，暂时不能发送消息');
    return;
  }
  if (conv.type === 'group') {
    const meta = appState.roomMyMemberMetaByRoom[conv.id];
    const bypassGlobalMute = !!(meta && (meta.role === 'owner' || meta.canKick || meta.canMute));
    if (conv.globalMute && !bypassGlobalMute) {
      alert('该群已开启全员禁言');
      return;
    }
  }
  const localRateState = checkLocalGroupRateLimit(conv);
  if (localRateState.blocked) {
    alert(localRateState.message);
    return;
  }

  try {
    const uploaded = await apiUploadImage(file);
    if (!uploaded || !uploaded.url) throw new Error('上传返回无效');
    const sent = await apiSendMessage(conv.id, `![img](${uploaded.url})`, {
      replyToMessageId: appState.replyingToMessage?.id || null
    });
    appState.lastSentAtByRoom[conv.id] = Date.now();
    if (sent.via === 'http' && sent.message) {
      const msg = normalizeMessage(sent.message);
      const exists = conv.messages.some((m) => m.id === msg.id);
      if (!exists) conv.messages.push(msg);
      appendMessagesToView(conv, [msg], { autoScroll: true });
      scheduleConversationListRender();
      updateUnreadBadges();
      await markCurrentRoomRead();
    }
    clearReplyAndEditState();
    toggleEmojiPanel(false);
  } catch (err) {
    if ((err.message || '').includes('Not Found')) {
      alert('上传接口未部署/路径不一致，请检查后端 /api/uploads/images');
      return;
    }
    alert(`上传失败(${err.status || 'ERR'}): ${err.message}`);
  }
}

async function loadMoreMessages() {
  if (appState.loadingMore) return;
  const conv = findConversationById(appState.activeConversationId);
  if (!conv || !conv.messages.length) return;

  const listEl = getMessageScrollContainer();
  if (!listEl) return;
  const beforeHeight = listEl.scrollHeight;
  const btn = document.getElementById('loadMoreBtn');

  appState.loadingMore = true;
  btn.disabled = true;
  btn.textContent = '加载中...';

  try {
    const hiddenCount = getHiddenMessageCount(conv);
    if (hiddenCount > 0) {
      setMessageRenderLimit(conv.id, getMessageRenderLimit(conv.id) + MESSAGE_RENDER_STEP);
      renderMessages({ autoScroll: false });
      const afterHeight = listEl.scrollHeight;
      listEl.scrollTop = afterHeight - beforeHeight;
      return;
    }
    if (conv.hasMore === false) {
      btn.textContent = '没有更多';
      return;
    }
    const oldest = conv.messages[0];
    if (!oldest) return;
    const batch = await apiGetRoomMessagesBefore(conv.id, oldest.id, 50);
    if (!batch.length) {
      conv.hasMore = false;
      btn.textContent = '没有更多';
      return;
    }

    const normalized = batch.map(normalizeMessage).reverse();
    const exists = new Set(conv.messages.map((m) => m.id));
    const toPrepend = normalized.filter((m) => !exists.has(m.id));
    conv.messages = [...toPrepend, ...conv.messages];
    conv.hasMore = batch.length === 50;
    setMessageRenderLimit(conv.id, getMessageRenderLimit(conv.id) + Math.max(MESSAGE_RENDER_STEP, toPrepend.length));

    renderMessages({ autoScroll: false });
    const afterHeight = listEl.scrollHeight;
    listEl.scrollTop = afterHeight - beforeHeight;
  } catch (err) {
    console.error('加载历史消息失败', err);
  } finally {
    appState.loadingMore = false;
    btn.disabled = false;
    const hiddenLeft = getHiddenMessageCount(conv);
    btn.textContent = hiddenLeft > 0
      ? `加载更早消息(${hiddenLeft})`
      : (conv.hasMore === false ? '没有更多' : '加载更多');
  }
}

function openEditMessageModal(msg) {
  if (!appState.currentUser?.canUseEditFeature) return;
  appState.editingMessageId = msg.id;
  document.getElementById('editMessageId').value = String(msg.id);
  document.getElementById('editMessageText').value = msg.text;
  const modal = new bootstrap.Modal(document.getElementById('editMessageModal'));
  modal.show();
}

async function saveEditedMessage() {
  if (!appState.currentUser?.canUseEditFeature) return;
  const messageId = appState.editingMessageId;
  const text = document.getElementById('editMessageText').value.trim();
  if (!messageId || !text) return;

  try {
    const updated = await apiEditMessage(messageId, text);
    const conv = findConversationById(updated.room_id);
    if (conv) {
      const m = conv.messages.find((x) => x.id === updated.id);
      if (m) {
        m.text = updated.content;
        m.updatedAt = updated.updated_at ? new Date(updated.updated_at).getTime() : null;
        m.editedAt = m.updatedAt;
        m.editedByAdmin = !!updated.edited_by_admin;
      }
    }

    renderMessages();
    renderConversationList();

    const modal = bootstrap.Modal.getInstance(document.getElementById('editMessageModal'));
    if (modal) modal.hide();
  } catch (err) {
    alert(`编辑失败：${err.message}`);
  }
}

function renderConversationList() {
  const box = document.getElementById('conversationList');
  box.innerHTML = '';

  const list = getVisibleConversations().sort((a, b) => {
    const ap = isConversationPinned(a);
    const bp = isConversationPinned(b);
    if (ap !== bp) return bp ? 1 : -1;
    if (ap && bp) return getPinnedIndex(a.id) - getPinnedIndex(b.id);
    const ta = a.messages.length ? a.messages[a.messages.length - 1].createdAt : 0;
    const tb = b.messages.length ? b.messages[b.messages.length - 1].createdAt : 0;
    return tb - ta;
  });

  if (!list.length) {
    box.innerHTML = '<div class="p-3 text-secondary">暂无会话，去好友页添加好友开始聊天</div>';
    renderMessages();
    return;
  }

  list.forEach((conv) => {
    const lastMsg = (conv.messages || []).reduce((latest, curr) => {
      if (!latest) return curr;
      const lt = Number(latest.createdAt || 0);
      const ct = Number(curr.createdAt || 0);
      return ct >= lt ? curr : latest;
    }, null);
    const lastPreview = lastMsg
      ? (/^!\[img\]\(([^)]+)\)$/.test(lastMsg.text) ? '[图片]' : lastMsg.text.slice(0, 18))
      : '';
    const lastTime = lastMsg ? formatConversationTime(lastMsg.createdAt) : '';
    const avatar = getConversationAvatar(conv);
    const isPinned = isConversationPinned(conv);
    const btn = document.createElement('button');
    btn.className = `list-group-item list-group-item-action conversation-item-btn ${appState.activeConversationId === conv.id ? 'active' : ''} ${isPinned ? 'tg-pinned' : ''}`;

    const badge = conv.unreadCount > 0 ? `<span class="unread-dot">${conv.unreadCount > 99 ? '99+' : conv.unreadCount}</span>` : '';
    const onlineText = conv.type === 'group'
      ? `${conv.memberCount || conv.members.length}人群聊`
      : (() => {
        const other = getOtherUserInPrivateConversation(conv);
        const on = !!other?.online;
        return `<span class="online-dot ${on ? 'on' : 'off'}"></span>${on ? '在线' : '离线'}`;
      })();
    btn.innerHTML = `
      <div class="conversation-item">
        <img src="${avatar}" class="conversation-avatar" alt="avatar" />
        <div class="conversation-main text-start">
          <div class="conversation-top">
            <div class="conversation-name">${getConversationTitle(conv)}</div>
            <div class="conversation-time ${appState.activeConversationId === conv.id ? 'text-light' : 'text-secondary'}">${lastTime}</div>
          </div>
          <div class="conversation-bottom">
            <div class="conversation-preview ${appState.activeConversationId === conv.id ? 'text-light' : 'text-secondary'}">
              ${onlineText}${lastPreview ? ` · ${lastPreview}` : ''}
            </div>
            <div class="d-flex align-items-center gap-2">
              ${isPinned ? '<span class="pin-badge" title="已置顶">置顶</span>' : ''}
              ${badge}
            </div>
          </div>
        </div>
      </div>
    `;

    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      toggleConversationPin(conv.id);
    });
    let pinLongPressTimer = null;
    btn.addEventListener('touchstart', () => {
      pinLongPressTimer = setTimeout(() => toggleConversationPin(conv.id), 600);
    }, { passive: true });
    ['touchend', 'touchcancel', 'touchmove'].forEach((ev) => {
      btn.addEventListener(ev, () => {
        if (pinLongPressTimer) clearTimeout(pinLongPressTimer);
        pinLongPressTimer = null;
      }, { passive: true });
    });

    btn.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
      appState.multiSelectMode = false;
      appState.multiSelectedMessageIds = new Set();
      conv.unreadCount = 0;
      clearReplyAndEditState();
      refreshCurrentUserMuteState(conv.id)
        .then(() => {
          renderConversationList();
          renderMessages({ autoScroll: true, forceBottom: true });
          startRoomPolling(conv.id);
          updateUnreadBadges();
          markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
        })
        .catch((err) => {
          console.warn('刷新禁言状态失败', err.message);
          renderConversationList();
          renderMessages({ autoScroll: true, forceBottom: true });
          startRoomPolling(conv.id);
        });
    });

    box.appendChild(btn);
  });

  updateUnreadBadges();
}

function setLocalTypingHint(active) {
  const subEl = document.getElementById('chatSubTitle');
  if (!subEl) return;
  appState.localTypingActive = !!active;
  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    subEl.classList.remove('typing-active');
    return;
  }
  if (active) {
    subEl.textContent = '正在输入...';
    subEl.classList.add('typing-active');
    return;
  }
  subEl.classList.remove('typing-active');
  if (conv.type === 'group') {
    const onlineCount = (conv.members || []).filter((id) => appState.onlineUserIds.has(Number(id))).length;
    subEl.textContent = `${conv.members.length} 人 · 在线 ${onlineCount}`;
  } else {
    const other = getOtherUserInPrivateConversation(conv);
    subEl.textContent = other?.online ? '在线' : '离线';
  }
}

function setChatPaneVisible(visible) {
  const messagesView = document.getElementById('messagesView');
  const conversationPane = document.querySelector('.conversation-pane');
  const chatPane = document.querySelector('.chat-pane');
  const mobileBackBtn = document.getElementById('mobileBackToListBtn');
  if (!messagesView || !conversationPane || !chatPane) return;
  const isMobile = window.matchMedia('(max-width: 991.98px)').matches;

  if (isMobile) {
    if (visible) {
      messagesView.classList.add('mobile-chat-active');
      conversationPane.style.setProperty('display', 'none', 'important');
      chatPane.style.setProperty('display', 'flex', 'important');
      if (mobileBackBtn) mobileBackBtn.classList.remove('d-none');
    } else {
      messagesView.classList.remove('mobile-chat-active');
      conversationPane.style.setProperty('display', 'block', 'important');
      chatPane.style.setProperty('display', 'none', 'important');
      if (mobileBackBtn) mobileBackBtn.classList.add('d-none');
    }
    return;
  }

  conversationPane.style.removeProperty('display');
  chatPane.style.removeProperty('display');
  messagesView.classList.remove('mobile-chat-active');
  if (visible) {
    chatPane.classList.remove('d-none');
    conversationPane.classList.remove('d-none');
    chatPane.classList.remove('col-12');
    conversationPane.classList.remove('col-lg-12');
    if (!conversationPane.classList.contains('col-lg-4')) {
      conversationPane.classList.add('col-lg-4');
    }
    if (mobileBackBtn) mobileBackBtn.classList.add('d-none');
    return;
  }

  chatPane.classList.add('d-none');
  conversationPane.classList.remove('d-none');
  chatPane.classList.remove('col-12');
  conversationPane.classList.remove('col-lg-4');
  if (!conversationPane.classList.contains('col-lg-12')) {
    conversationPane.classList.add('col-lg-12');
  }
  if (mobileBackBtn) mobileBackBtn.classList.add('d-none');
}

function scheduleConversationListRender() {
  if (appState.conversationRenderQueued) return;
  appState.conversationRenderQueued = true;
  requestAnimationFrame(() => {
    appState.conversationRenderQueued = false;
    renderConversationList();
  });
}

function buildMessageRow(msg, conv) {
  const me = msg.senderId === appState.currentUser.id;
  const sender = appState.userMap[msg.senderId];
  const isSystem = String(msg.text || '').startsWith('[system]');
  const row = document.createElement('div');
  row.className = `msg-row ${me ? 'me' : 'other'} ${isSystem ? 'system' : ''}`;
  row.dataset.messageId = String(msg.id);
  if (appState.multiSelectMode && appState.multiSelectedMessageIds.has(Number(msg.id))) {
    row.classList.add('selected');
  }
  if (isSystem) {
    row.classList.remove('me', 'other');
    row.classList.add('system');
  }
  if (!me) {
    const avatar = document.createElement('img');
    avatar.className = 'conversation-avatar me-2';
    avatar.style.width = '28px';
    avatar.style.height = '28px';
    avatar.src = getUserAvatarById(msg.senderId);
    avatar.alt = 'avatar';
    row.appendChild(avatar);
  }

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${appState.multiSelectMode ? 'selecting' : ''} ${msg.localPending ? 'pending' : ''} ${msg.localFailed ? 'failed' : ''}`;

  const senderName = !me && conv.type === 'group'
    ? `<div class="small fw-bold mb-1">${escapeHtml(getGroupPublicDisplayNameByUserId(msg.senderId))}</div>`
    : '';
  const messageContent = renderMessageContent(msg.text);
  const replySenderName = msg.replyToSenderId ? getDisplayNameByUserId(msg.replyToSenderId) : '';
  const replyText = msg.replyToContent ? summarizeMessageText(msg.replyToContent) : '';
  const replyBlock = msg.replyToMessageId
    ? `<div class="msg-reply-preview" data-reply-to-id="${msg.replyToMessageId}"><div class="fw-semibold">${escapeHtml(replySenderName || '消息')}</div><div>${escapeHtml(replyText || '引用消息')}</div></div>`
    : '';

  const stateText = msg.localFailed ? '发送失败' : (msg.localPending ? '发送中...' : '');
  bubble.innerHTML = `
    ${appState.multiSelectMode ? '<input class="form-check-input msg-select-check me-2" type="checkbox" />' : ''}
    ${senderName}
    ${replyBlock}
    <div>${messageContent}</div>
    <div class="msg-meta">${formatTime(msg.createdAt)} ${stateText ? ` · ${stateText}` : ''}</div>
  `;
  const replyPreviewEl = bubble.querySelector('.msg-reply-preview');
  if (replyPreviewEl && msg.replyToMessageId) {
    replyPreviewEl.addEventListener('click', (e) => {
      e.stopPropagation();
      revealAndJumpToMessage(msg.replyToMessageId).catch((err) => {
        console.warn('定位引用消息失败', err.message);
      });
    });
  }
  if (appState.multiSelectMode) {
    const check = bubble.querySelector('.msg-select-check');
    if (check) {
      check.checked = appState.multiSelectedMessageIds.has(Number(msg.id));
      check.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMultiSelectMessage(msg.id);
      });
    }
    bubble.addEventListener('click', (e) => {
      toggleMultiSelectMessage(msg.id);
    });
  }

  bubble.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMessageActionMenu(msg);
  });
  let longPressTimer = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let longPressTriggered = false;
  bubble.addEventListener('touchstart', (e) => {
    const t = e.touches && e.touches[0];
    if (!t) return;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
    longPressTriggered = false;
    longPressTimer = setTimeout(() => {
      longPressTriggered = true;
      openMessageActionMenu(msg);
    }, 550);
  }, { passive: true });
  bubble.addEventListener('touchmove', (e) => {
    const t = e.touches && e.touches[0];
    if (!t || !longPressTimer) return;
    const dx = Math.abs(t.clientX - touchStartX);
    const dy = Math.abs(t.clientY - touchStartY);
    // 允许轻微手抖，避免滚动时误触发
    if (dx > 14 || dy > 14) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { passive: true });
  ['touchend', 'touchcancel'].forEach((ev) => {
    bubble.addEventListener(ev, (e) => {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      if (longPressTriggered) {
        e.preventDefault();
        e.stopPropagation();
      }
      longPressTriggered = false;
    });
  });

  row.appendChild(bubble);
  return row;
}

function appendMessagesToView(conv, messages, options = {}) {
  const { autoScroll = true, stickToBottom = null } = options;
  const listEl = getMessageScrollContainer();
  if (!listEl || !messages.length) return;
  const prevScrollTop = listEl.scrollTop;
  const wasNearBottom = isNearBottom(listEl, 220);
  const shouldStick = typeof stickToBottom === 'boolean' ? stickToBottom : wasNearBottom;

  const frag = document.createDocumentFragment();
  messages.forEach((msg) => frag.appendChild(safeBuildMessageRow(msg, conv)));
  listEl.appendChild(frag);
  trimMessageDomIfNeeded(listEl);

  if (autoScroll) scrollMessagesToBottom({ force: false, stickToBottom: shouldStick, reason: 'append' });
  else if (listEl.scrollTop !== prevScrollTop) listEl.scrollTop = prevScrollTop;
}

function trimMessageDomIfNeeded(listEl) {
  if (!listEl) return;
  const children = listEl.children;
  const over = children.length - MESSAGE_DOM_HARD_LIMIT;
  if (over <= 0) return;
  const wasNearBottom = isNearBottom(listEl, 220);

  let removedHeight = 0;
  for (let i = 0; i < over; i += 1) {
    const node = children[0];
    if (!node) break;
    removedHeight += node.offsetHeight || 0;
    listEl.removeChild(node);
  }

  if (removedHeight > 0) {
    if (wasNearBottom) {
      listEl.scrollTop = listEl.scrollHeight;
    } else {
      listEl.scrollTop = Math.max(0, listEl.scrollTop - removedHeight);
    }
  }
}

async function markCurrentRoomRead() {
  const conv = findConversationById(appState.activeConversationId);
  if (!conv) return;
  const last = conv.messages[conv.messages.length - 1];
  await apiMarkRoomRead(conv.id, last?.id || null);
  conv.unreadCount = 0;
  scheduleConversationListRender();
  updateUnreadBadges();
}

function scheduleMarkCurrentRoomRead() {
  if (appState.readAckTimer) clearTimeout(appState.readAckTimer);
  appState.readAckTimer = setTimeout(() => {
    markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
  }, 180);
}

function renderMessages(options = {}) {
  const { autoScroll = true, forceBottom = false } = options;
  const listEl = getMessageScrollContainer() || document.getElementById('messageList');
  const titleEl = document.getElementById('chatTitle');
  const subEl = document.getElementById('chatSubTitle');
  const avatarEl = document.getElementById('chatAvatar');
  const emptyStateEl = document.getElementById('chatEmptyState');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const groupMembersBtn = document.getElementById('groupMembersBtn');
  const composer = document.getElementById('chatComposer');
  const chatHeader = document.getElementById('chatHeader');
  const chatDetailsBtn = document.getElementById('chatDetailsBtn');
  if (!listEl || !titleEl || !subEl || !loadMoreBtn || !composer) return;
  handleConversationContextSwitch();

  listEl.innerHTML = '';

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    appState.multiSelectMode = false;
    appState.multiSelectedMessageIds = new Set();
    updateMultiSelectBar();
    const isMobile = window.matchMedia('(max-width: 991.98px)').matches;
    setChatPaneVisible(!isMobile);
    titleEl.textContent = '即时聊天';
    subEl.textContent = '请选择会话';
    if (avatarEl) avatarEl.src = DEFAULT_AVATAR;
    if (chatHeader) chatHeader.classList.add('d-none');
    if (emptyStateEl) emptyStateEl.classList.remove('d-none');
    listEl.classList.add('d-none');
    if (chatDetailsBtn) chatDetailsBtn.disabled = true;
    loadMoreBtn.classList.add('d-none');
    if (groupMembersBtn) groupMembersBtn.classList.add('d-none');
    composer.classList.add('d-none');
    applyMuteComposerState(null);
    listEl.innerHTML = '';
    clearReplyAndEditState();
    toggleEmojiPanel(false);
    hideMentionSuggestions();
    updateCallButtonsState();
    setLocalTypingHint(false);
    return;
  }
  setChatPaneVisible(true);
  if (chatHeader) chatHeader.classList.remove('d-none');
  if (emptyStateEl) emptyStateEl.classList.add('d-none');
  listEl.classList.remove('d-none');
  updateMultiSelectBar();
  if (chatDetailsBtn) chatDetailsBtn.disabled = false;
  loadMoreBtn.classList.remove('d-none');
  composer.classList.remove('d-none');
  applyMuteComposerState(conv);
  const hiddenCount = getHiddenMessageCount(conv);
  const canLoadServerMore = conv.hasMore !== false;
  loadMoreBtn.disabled = conv.messages.length === 0 || (!hiddenCount && !canLoadServerMore);
  loadMoreBtn.textContent = conv.messages.length === 0
    ? '暂无历史'
    : (hiddenCount > 0
      ? `加载更早消息(${hiddenCount})`
      : (canLoadServerMore ? '加载更多' : '没有更多'));

  titleEl.textContent = getConversationTitle(conv);
  if (avatarEl) avatarEl.src = getConversationAvatar(conv);
  if (conv.type === 'group') {
    const onlineCount = (conv.members || []).filter((id) => appState.onlineUserIds.has(Number(id))).length;
    subEl.textContent = `${conv.members.length} 人 · 在线 ${onlineCount}`;
    if (groupMembersBtn) groupMembersBtn.classList.remove('d-none');
  } else {
    const other = getOtherUserInPrivateConversation(conv);
    subEl.textContent = other?.online ? '在线' : '离线';
    if (groupMembersBtn) groupMembersBtn.classList.add('d-none');
    hideMentionSuggestions();
  }
  if (appState.localTypingActive) setLocalTypingHint(true);

  appendMessagesToView(conv, getRenderableMessages(conv), { autoScroll });
  if (forceBottom) {
    appState.userNearBottom = true;
    scrollMessagesToBottom({ force: true });
  }
  renderComposerState();
  const renderRoomId = conv.id;
  refreshCurrentUserMuteState(conv.id)
    .then(() => {
      if (appState.activeConversationId !== renderRoomId) return;
      applyMuteComposerState(conv);
    })
    .catch((err) => console.warn('刷新禁言状态失败', err.message));
  updateCallButtonsState();
  cleanupStuckUiOverlay();
}

function safeBuildMessageRow(msg, conv) {
  try {
    return buildMessageRow(msg, conv);
  } catch (err) {
    console.warn('消息渲染异常，已降级显示', err);
    const row = document.createElement('div');
    row.className = 'msg-row system';
    row.dataset.messageId = String(msg?.id || `invalid-${Date.now()}`);
    row.innerHTML = `<div class="msg-bubble"><div class="msg-text text-warning">消息格式异常，已跳过显示</div></div>`;
    return row;
  }
}

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text) return;

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    alert('请先选择一个会话');
    return;
  }
  if (conv.type === 'group' && appState.roomMuteStateByRoom[conv.id]) {
    alert('你已被群主禁言，暂时不能发送消息');
    return;
  }
  if (conv.type === 'group') {
    const meta = appState.roomMyMemberMetaByRoom[conv.id];
    const bypassGlobalMute = !!(meta && (meta.role === 'owner' || meta.canKick || meta.canMute));
    if (conv.globalMute && !bypassGlobalMute) {
      alert('该群已开启全员禁言');
      return;
    }
  }

  // TODO: 后端 WebSocket 发送消息
  // ws.send({ action: 'send_message', room_id, content })
  try {
    if (appState.editingOwnMessageId) {
      const updated = await apiEditMessage(appState.editingOwnMessageId, text);
      const m = conv.messages.find((x) => x.id === updated.id);
      if (m) {
        m.text = updated.content;
        m.updatedAt = updated.updated_at ? new Date(updated.updated_at).getTime() : null;
        m.editedAt = m.updatedAt;
      }
      renderMessages({ autoScroll: false });
      scheduleConversationListRender();
    } else {
      const optimistic = makeLocalPendingMessage(
        conv.id,
        text,
        appState.currentUser.id,
        appState.replyingToMessage
      );
      conv.messages.push(optimistic);
      appendMessagesToView(conv, [optimistic], { autoScroll: true });
      scheduleConversationListRender();

      const sent = await apiSendMessage(conv.id, text, {
        replyToMessageId: appState.replyingToMessage?.id || null
      });
      appState.lastSentAtByRoom[conv.id] = Date.now();
      if (sent.via === 'http' && sent.message) {
        const msg = normalizeMessage(sent.message);
        const replaced = reconcilePendingMessage(conv, msg);
        if (replaced) {
          replaceMessageRowInView(conv, replaced, msg);
        } else {
          const exists = conv.messages.some((m) => m.id === msg.id);
          if (!exists) {
            conv.messages.push(msg);
            appendMessagesToView(conv, [msg], { autoScroll: true });
          }
        }
        scheduleConversationListRender();
        updateUnreadBadges();
        await markCurrentRoomRead();
      }
    }
  } catch (err) {
    if (!appState.editingOwnMessageId) {
      const latestPending = [...conv.messages].reverse().find((m) => m.localPending && !m.localFailed && m.senderId === appState.currentUser.id && m.text === text);
      if (latestPending) {
        latestPending.localPending = false;
        latestPending.localFailed = true;
        renderMessages({ autoScroll: false });
      }
    }
    alert(`发送失败(${err.status || 'ERR'}): ${err.message}`);
    return;
  }

  input.value = '';
  if (appState.localTypingTimer) clearTimeout(appState.localTypingTimer);
  setLocalTypingHint(false);
  clearReplyAndEditState();
  toggleEmojiPanel(false);
  hideMentionSuggestions();
  input.focus();
}

// ============================
// 通知
// ============================
function updateUnreadBadges() {
  const total = getUnreadTotal();
  document.getElementById('totalUnreadDesktop').textContent = total;
  document.getElementById('totalUnreadMobile').textContent = total;
  document.getElementById('totalUnreadText').textContent = total;
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
}

function notifyMessage(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

function ensureAudioContext() {
  if (appState.audioCtx) return appState.audioCtx;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  appState.audioCtx = new AudioCtx();
  return appState.audioCtx;
}

function playIncomingSound() {
  const now = Date.now();
  if (now - appState.lastSoundAt < 1200) return;
  appState.lastSoundAt = now;

  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => null);
  }
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 860;
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.16);
  } catch (_) {
    // ignore audio failures
  }
}

// ============================
// 启动流程
// ============================
async function bootstrapAfterLogin(userFromAuth = null) {
  const me = userFromAuth || await apiGetMe();

  appState.currentUser = {
    id: me.id,
    username: me.username,
    email: me.email,
    nickname: me.nickname || me.username,
    signature: me.signature || '',
    avatar: me.avatar_base64 || DEFAULT_AVATAR,
    role: me.role || 'member',
    online: !!me.is_online,
    canKickMembers: !!me.can_kick_members,
    canMuteMembers: !!me.can_mute_members,
    canUseEditFeature: !!me.can_use_edit_feature
  };

  mergeUserToMap(me);
  loadPinnedRoomOrder();
  enterApp({ skipDataRefresh: true });
  connectWebSocket();
  setAuthLoading(true, '正在同步数据...');

  await Promise.all([
    refreshFriends(),
    refreshFriendRequests(),
    refreshFriendRemarks(),
    refreshPresenceOnlineList(),
    refreshRoomsAndMessages(),
    refreshUnreadCounts()
  ]);

  updateUserHeader();
  updateAdminNavVisibility();
  renderProfile();
  renderFriendList();
  renderFriendRequestLists();
  updateFriendRequestBadges();
  renderGroupList();
  renderConversationList();
  renderMessages();
  renderGroupMemberOptions();
  updateUnreadBadges();
  setAuthLoading(false);
}

function enterApp(options = {}) {
  const skipDataRefresh = !!options.skipDataRefresh;
  resetCallState();
  showMain();
  switchView('messagesView', { silentRefresh: skipDataRefresh });

  updateUserHeader();
  updateAdminNavVisibility();
  renderProfile();
  renderFriendList();
  renderFriendRequestLists();
  updateFriendRequestBadges();
  renderGroupList();
  renderConversationList();
  renderMessages();
  renderGroupMemberOptions();
  updateUnreadBadges();
  startUnreadPolling();

  requestNotificationPermission();
}

async function init() {
  getApiBase();
  renderApiBaseIndicator();
  await ensureReachableApiBase();
  renderApiBaseIndicator();
  registerServiceWorker();
  bindGlobalOverlayGuards();
  updateAppViewportHeight();
  window.addEventListener('resize', updateAppViewportHeight, { passive: true });
  window.visualViewport?.addEventListener('resize', updateAppViewportHeight, { passive: true });

  // 向后兼容：旧版本 token key 为 "token"
  const legacyToken = localStorage.getItem('token');
  if (legacyToken && !localStorage.getItem(STORAGE_KEYS.token)) {
    localStorage.setItem(STORAGE_KEYS.token, legacyToken);
  }

  const theme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
  setTheme(theme);

  bindAuthEvents();
  bindNavigationEvents();
  bindProfileEvents();
  bindFriendEvents();
  bindGroupEvents();
  bindChatEvents();
  document.addEventListener('click', () => ensureAudioContext(), { once: true });
  document.addEventListener('touchstart', () => ensureAudioContext(), { once: true, passive: true });

  const token = getToken();
  if (!token) {
    setAuthLoading(false);
    showAuth();
    switchAuthPage('login');
    return;
  }

  try {
    setAuthLoading(true, '正在恢复登录...');
    await bootstrapAfterLogin();
  } catch (err) {
    if (err.status === 401) {
      console.warn('token 失效，回到登录页：', err.message);
      clearToken();
    }
    setAuthLoading(false);
    showAuth();
    switchAuthPage('login');
  }

  localStorage.removeItem('token');
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((err) => {
    console.error(err);
    alert(`初始化失败：${err.message}`);
  });
});

window.__api = {
  apiFetch,
  apiLogin,
  apiRegister,
  apiGetMe,
  apiSearchUsers,
  apiGetFriends,
  apiAddFriend,
  apiRemoveFriend,
  apiSendFriendRequest,
  apiGetIncomingFriendRequests,
  apiGetOutgoingFriendRequests,
  apiAcceptFriendRequest,
  apiRejectFriendRequest,
  apiGetFriendRemarks,
  apiSetFriendRemark,
  apiGetRooms,
  apiCreateRoom,
  apiUpdateRoom,
  apiGetRoomMembers,
  apiAddRoomMember,
  apiRemoveRoomMember,
  apiMuteRoomMember,
  apiUnmuteRoomMember,
  apiGetRoomMuteList,
  apiSetRoomMemberPermissions,
  apiSetRoomRateLimit,
  apiDeleteRoomMemberMessages,
  apiGetRoomMessages,
  apiGetUnreadCounts,
  apiMarkRoomRead,
  apiEditMessage,
  apiRecallMessage,
  apiSuperDeleteMessage,
  apiSendMessage,
  apiUploadImage,
  apiAdminListUsers,
  apiAdminResetPassword
};

window.__env = {
  async checkAuthEndpoints() {
    const base = getApiBase();
    try {
      const res = await fetch(`${base}/openapi.json`);
      if (!res.ok) {
        console.error(`[env] openapi fetch failed: status=${res.status}`);
        return { ok: false, status: res.status };
      }
      const data = await res.json();
      const paths = data?.paths || {};
      const hasRegister = !!paths['/api/auth/register'];
      const hasLogin = !!paths['/api/auth/login'];
      if (!hasRegister || !hasLogin) {
        console.error('[env] 后端未提供 /api/auth/register 或 /api/auth/login，或你连错后端');
        return { ok: false, hasRegister, hasLogin };
      }
      console.log(`[env] ok base=${base}`);
      return { ok: true, base, hasRegister, hasLogin };
    } catch (err) {
      console.error(`[env] openapi error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
};
