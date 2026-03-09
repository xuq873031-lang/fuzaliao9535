// ============================
// 真实后端对接版（FastAPI + WebSocket）
// ============================

const STORAGE_KEYS = {
  token: 'chatwave_token',
  theme: 'chatwave_theme'
};
const DEFAULT_API_BASE = 'https://web-production-be9f.up.railway.app';
const APP_BUILD = '20260308_1';
const SHOW_DEBUG_BADGE = false;

const DEFAULT_AVATAR =
  'data:image/svg+xml;base64,' +
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" fill="#229ed9"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-size="28">U</text></svg>`);

const EMOJIS = ['😀', '😁', '😂', '😊', '😍', '😎', '🤔', '😭', '👍', '🎉', '❤️', '🔥'];

let appState = {
  currentUser: null,
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
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
  ws: null,
  wsReconnectTimer: null,
  wsReconnectTried: false,
  pendingAvatarBase64: null,
  loadingMore: false,
  roomPollTimer: null,
  roomPollInFlight: false,
  roomPollRoomId: null,
  lastMessageIdByRoom: {},
  unreadPollTimer: null,
  baseCorrectedLogged: false,
  conversationRenderQueued: false,
  userNearBottom: true,
  lastSoundAt: 0,
  audioCtx: null,
  readAckTimer: null,
  roomMuteStateByRoom: {},
  emojiPanelOpen: false,
  managingGroupId: null,
  pendingMessageSeq: 0,
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
  const stored = String(localStorage.getItem('chat_api_base') || '').trim().replace(/\/$/, '');
  if (!stored) {
    localStorage.setItem('chat_api_base', DEFAULT_API_BASE);
    return DEFAULT_API_BASE;
  }
  if (stored !== DEFAULT_API_BASE) {
    localStorage.setItem('chat_api_base', DEFAULT_API_BASE);
    localStorage.removeItem(STORAGE_KEYS.token);
    if (!appState.baseCorrectedLogged) {
      console.info('API base updated');
      appState.baseCorrectedLogged = true;
    }
  }
  return DEFAULT_API_BASE;
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
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"><img src="${safeUrl}" class="msg-image" alt="image" /></a>`;
  }
  return escapeHtml(raw).replaceAll('\n', '<br>');
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
  if (msg.senderId !== appState.currentUser?.id) return false;
  if (isImageMessageText(msg.text)) return false;
  return true;
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
    conv.messages[idx] = { ...serverMsg, localPending: false, localFailed: false, localTempId: null };
    return true;
  }
  return false;
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

function showAuth() {
  document.getElementById('authContainer').classList.remove('d-none');
  document.getElementById('mainContainer').classList.add('d-none');
}

function showMain() {
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

function switchView(viewId, options = {}) {
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
    Promise.all([refreshFriends(), refreshFriendRequests(), refreshFriendRemarks()])
      .then(() => {
        renderFriendList();
        renderFriendRequestLists();
      })
      .catch((err) => console.warn('刷新好友数据失败', err.message));
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
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, request);

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
    const data = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    console.log(`[search] base=${base} q=${q} status=200`);
    return Array.isArray(data) ? data : [];
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

async function apiRemoveFriend(friendId) {
  return apiFetch(`/api/friends/${friendId}`, { method: 'DELETE' });
}

async function apiSendFriendRequest(toUserId) {
  return apiFetch('/api/friend-requests', {
    method: 'POST',
    body: JSON.stringify({ to_user_id: toUserId })
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
  const [incoming, outgoing] = await Promise.all([
    apiGetIncomingFriendRequests('pending'),
    apiGetOutgoingFriendRequests('pending')
  ]);
  appState.incomingRequests = incoming || [];
  appState.outgoingRequests = outgoing || [];
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
  return appState.conversations;
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

function applyMuteComposerState(conv) {
  const muted = !!(conv && conv.type === 'group' && appState.roomMuteStateByRoom[conv.id] === true);
  const hintBar = document.getElementById('muteHintBar');
  const input = document.getElementById('messageInput');
  const sendBtn = document.getElementById('sendMessageBtn');
  const uploadBtn = document.getElementById('uploadImageBtn');
  const emojiBar = document.getElementById('emojiBar');
  if (hintBar) hintBar.classList.toggle('d-none', !muted);
  if (input) {
    input.disabled = muted;
    input.placeholder = muted ? '你已被群主禁言' : '输入消息...';
  }
  if (sendBtn) sendBtn.disabled = muted;
  if (uploadBtn) uploadBtn.disabled = muted;
  if (emojiBar) {
    emojiBar.querySelectorAll('button').forEach((btn) => {
      btn.disabled = muted;
    });
  }
}

async function refreshCurrentUserMuteState(roomId) {
  const conv = findConversationById(roomId);
  if (!conv || conv.type !== 'group') {
    if (roomId) appState.roomMuteStateByRoom[roomId] = false;
    return false;
  }
  try {
    const members = await apiGetRoomMembers(roomId);
    const me = (members || []).find((m) => Number(m.user_id) === Number(appState.currentUser?.id));
    const muted = !!me?.muted;
    appState.roomMuteStateByRoom[roomId] = muted;
    return muted;
  } catch (err) {
    console.warn('刷新禁言状态失败:', err.message);
    return !!appState.roomMuteStateByRoom[roomId];
  }
}

function getDmConversationWithFriend(friendId) {
  return appState.conversations.find(
    (c) => isDmConversation(c) && c.members.includes(friendId) && c.members.includes(appState.currentUser.id)
  );
}

function isNearBottom(el, threshold = 80) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

function scrollMessagesToBottom(options = {}) {
  const { force = false } = options;
  const listEl = document.getElementById('messageList');
  if (!listEl) return;
  if (!force && !isNearBottom(listEl, 120)) return;

  requestAnimationFrame(() => {
    listEl.scrollTop = listEl.scrollHeight;
  });

  const pendingImages = Array.from(listEl.querySelectorAll('img')).filter((img) => !img.complete);
  pendingImages.forEach((img) => {
    img.addEventListener('load', () => {
      if (force || isNearBottom(listEl, 160)) {
        listEl.scrollTop = listEl.scrollHeight;
      }
    }, { once: true });
  });
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
    const listEl = document.getElementById('messageList');
    const nearBottom = isNearBottom(listEl);
    const newlyAdded = [];

    normalized.forEach((msg) => {
      if (!existing.has(msg.id)) {
        conv.messages.push(msg);
        newlyAdded.push(msg);
      }
    });

    if (newlyAdded.length) {
      updateLastMessageId(roomId, conv.messages);
      scheduleConversationListRender();
      if (appState.currentView === 'messagesView' && appState.activeConversationId === roomId) {
        appendMessagesToView(conv, newlyAdded, { autoScroll: nearBottom });
      }
      updateUnreadBadges();
      await markCurrentRoomRead();
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

  const apiBase = getApiBase();
  const wsBase = apiBase.replace('http://', 'ws://').replace('https://', 'wss://');
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

  if (evt.type === 'presence') {
    const uid = Number(evt.user_id);
    if (!Number.isNaN(uid)) {
      if (evt.online) appState.onlineUserIds.add(uid);
      else appState.onlineUserIds.delete(uid);
      if (appState.userMap[uid]) appState.userMap[uid].online = !!evt.online;
      appState.friends = appState.friends.map((f) => (f.id === uid ? { ...f, online: !!evt.online } : f));
      renderFriendList();
      renderMessages();
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

  if (evt.type === 'room_removed') {
    const roomId = Number(evt.room_id);
    appState.conversations = appState.conversations.filter((c) => c.id !== roomId);
    if (appState.activeConversationId === roomId) {
      appState.activeConversationId = null;
      stopRoomPolling();
      renderMessages({ autoScroll: false });
      alert('你已被移出该群');
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
    const msg = normalizeMessage(evt.payload);
    const conv = findConversationById(msg.room_id);
    if (!conv) return;

    const replacedPending = reconcilePendingMessage(conv, msg);
    const exists = conv.messages.some((m) => m.id === msg.id);
    if (!exists && !replacedPending) conv.messages.push(msg);

    const isCurrent = appState.activeConversationId === conv.id && appState.currentView === 'messagesView';
    const isFromOther = msg.senderId !== appState.currentUser.id;

    if (!isCurrent && isFromOther) {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
      const sender = appState.userMap[msg.senderId];
      notifyMessage(sender?.nickname || sender?.username || '新消息', msg.text);
      playIncomingSound();
    }

    renderConversationList();
    if (appState.activeConversationId === conv.id) {
      if (replacedPending || exists) {
        renderMessages({ autoScroll: appState.userNearBottom });
      } else {
        appendMessagesToView(conv, [msg], { autoScroll: appState.userNearBottom });
      }
      if (isFromOther) scheduleMarkCurrentRoomRead();
    }
    updateUnreadBadges();
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
      const conv = findConversationById(appState.activeConversationId);
      applyMuteComposerState(conv);
      alert('你已被群主禁言，暂时不能发送消息');
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
    const agreed = document.getElementById('registerAgree').checked;
    if (!agreed) {
      alert('请先勾选“我已阅读并同意相关协议”');
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

  showAuth();
  switchAuthPage('login');
}

async function removeFriend(friendId) {
  if (!confirm('确定删除该好友吗？')) return;
  try {
    const current = findConversationById(appState.activeConversationId);
    const shouldResetCurrent = !!(current && isDmConversation(current) && current.members.includes(friendId));

    await apiRemoveFriend(friendId);
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
  document.getElementById('profileAvatar').src = appState.currentUser.avatar || DEFAULT_AVATAR;
  document.getElementById('nicknameInput').value = appState.currentUser.nickname || '';
  document.getElementById('signatureInput').value = appState.currentUser.signature || '';
}

function updateUserHeader() {
  document.getElementById('sidebarUsername').textContent = appState.currentUser.nickname || appState.currentUser.username;
}

// ============================
// 好友系统
// ============================
function bindFriendEvents() {
  const searchBtn = document.getElementById('friendSearchBtn');
  const searchInput = document.getElementById('friendSearchInput');
  const toggleToolsBtn = document.getElementById('toggleFriendToolsBtn');
  const toolsPanel = document.getElementById('friendToolsPanel');
  const friendList = document.getElementById('friendList');

  if (toolsPanel && !toggleToolsBtn) {
    toolsPanel.classList.remove('d-none');
  }

  const openTools = () => {
    if (!toolsPanel) return;
    toolsPanel.classList.remove('d-none');
    if (toggleToolsBtn) toggleToolsBtn.textContent = '收起';
    setTimeout(() => {
      toolsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 20);
  };

  const closeTools = () => {
    if (!toolsPanel) return;
    toolsPanel.classList.add('d-none');
    if (toggleToolsBtn) toggleToolsBtn.textContent = '添加好友';
  };

  if (searchBtn) searchBtn.addEventListener('click', handleFriendSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleFriendSearch();
    });
  }
  if (toggleToolsBtn && toolsPanel) {
    toggleToolsBtn.addEventListener('click', () => {
      if (toolsPanel.classList.contains('d-none')) openTools();
      else closeTools();
    });
  }

  // 没有好友时，默认展开添加好友区域，避免误解为“功能消失”
  if (friendList && toolsPanel) {
    const observer = new MutationObserver(() => {
      const hasFriends = !!friendList.querySelector('.list-group-item');
      if (!hasFriends) openTools();
    });
    observer.observe(friendList, { childList: true });
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

  try {
    const results = await apiSearchUsers(keyword);
    if (!results.length) {
      box.innerHTML = '<div class="text-secondary small">无匹配结果</div>';
      return;
    }

    results.forEach((item) => {
      const isAdded = appState.friends.some((f) => f.id === item.id);
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
      row.innerHTML = `
        <div class="d-flex align-items-center gap-2">
          <img src="${item.avatar_base64 || DEFAULT_AVATAR}" width="32" height="32" class="rounded-circle" alt="avatar" />
          <div>
            <div class="fw-semibold">${displayName}</div>
            <small class="text-secondary">@${item.username}</small>
          </div>
        </div>
        <button class="btn btn-sm btn-outline-primary" ${isAdded ? 'disabled' : ''}>${isAdded ? '已添加' : '添加好友'}</button>
      `;
      if (!isAdded) {
        row.querySelector('button').addEventListener('click', () => addFriendById(item.id));
      }
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<div class="text-danger small">搜索失败: ${err.status || 'ERR'} ${err.message}</div>`;
  }
}

async function addFriendById(friendId) {
  try {
    await apiSendFriendRequest(friendId);
    await refreshFriendRequests();
    renderFriendRequestLists();
    alert('已发送好友申请，等待对方通过');
  } catch (err) {
    alert(`添加失败：${err.message}`);
  }
}

function renderFriendList() {
  const box = document.getElementById('friendList');
  box.innerHTML = '';

  if (!appState.friends.length) {
    box.innerHTML = '<div class="text-secondary">还没有好友，点击上方“添加好友”开始添加。</div>';
    return;
  }

  const sortedFriends = sortFriendsAtoZ(appState.friends);
  sortedFriends.forEach((f) => {
    const avatar = appState.userMap[f.id]?.avatar || DEFAULT_AVATAR;
    const displayName = getDisplayNameByUserId(f.id);
    const item = document.createElement('button');
    item.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
    item.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <img src="${avatar}" width="32" height="32" class="rounded-circle" alt="avatar" />
        <div>
          <div class="fw-semibold">${displayName}</div>
          <small class="text-secondary">@${f.username}</small>
        </div>
      </div>
      <div class="d-flex align-items-center gap-2">
        <span class="badge ${f.online ? 'text-bg-success' : 'text-bg-secondary'}">${f.online ? '在线' : '离线'}</span>
        <button class="btn btn-sm btn-outline-secondary friend-remark-btn" data-fid="${f.id}" type="button">备注</button>
        <button class="btn btn-sm btn-outline-danger friend-remove-btn" data-fid="${f.id}" type="button">删除</button>
      </div>
    `;

    item.addEventListener('click', async (e) => {
      if (e.target && (e.target.classList.contains('friend-remove-btn') || e.target.classList.contains('friend-remark-btn'))) return;
      await openPrivateChatWith(f.id);
    });
    item.querySelector('.friend-remark-btn').addEventListener('click', () => editFriendRemark(f.id));
    item.querySelector('.friend-remove-btn').addEventListener('click', () => removeFriend(f.id));
    box.appendChild(item);
  });
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

function renderFriendRequestLists() {
  const incomingBox = document.getElementById('incomingRequestList');
  const outgoingBox = document.getElementById('outgoingRequestList');
  if (!incomingBox || !outgoingBox) return;

  incomingBox.innerHTML = '';
  outgoingBox.innerHTML = '';

  if (!appState.incomingRequests.length) {
    incomingBox.innerHTML = '<div class="text-secondary small">暂无待处理申请</div>';
  } else {
    appState.incomingRequests.forEach((req) => {
      const fromName = getDisplayNameByUserId(req.from_user_id);
      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center';
      row.innerHTML = `
        <div>
          <div class="fw-semibold">${fromName}</div>
          <small class="text-secondary">用户ID: ${req.from_user_id}</small>
        </div>
        <div class="d-flex gap-2">
          <button class="btn btn-sm btn-success req-accept-btn">通过</button>
          <button class="btn btn-sm btn-outline-secondary req-reject-btn">拒绝</button>
        </div>
      `;
      row.querySelector('.req-accept-btn').addEventListener('click', () => handleAcceptRequest(req.id));
      row.querySelector('.req-reject-btn').addEventListener('click', () => handleRejectRequest(req.id));
      incomingBox.appendChild(row);
    });
  }

  if (!appState.outgoingRequests.length) {
    outgoingBox.innerHTML = '<div class="text-secondary small">暂无发出的申请</div>';
  } else {
    appState.outgoingRequests.forEach((req) => {
      const toName = getDisplayNameByUserId(req.to_user_id);
      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center';
      row.innerHTML = `
        <div>
          <div class="fw-semibold">${toName}</div>
          <small class="text-secondary">等待对方通过</small>
        </div>
        <span class="badge text-bg-warning">待处理</span>
      `;
      outgoingBox.appendChild(row);
    });
  }
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
  const addBtn = document.getElementById('groupAddMemberBtn');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const groupId = appState.managingGroupId;
      if (!groupId) return;
      const select = document.getElementById('groupAddMemberSelect');
      const userId = Number(select?.value || 0);
      if (!userId) return;
      try {
        await apiAddRoomMember(groupId, userId);
        await refreshRoomsAndMessages();
        await refreshGroupManageModal(groupId);
        renderGroupList();
        renderConversationList();
      } catch (err) {
        alert(`拉人失败：${err.message}`);
      }
    });
  }
  const manageModalEl = document.getElementById('groupManageModal');
  if (manageModalEl) {
    manageModalEl.addEventListener('hidden.bs.modal', () => {
      appState.managingGroupId = null;
    });
  }
  const forwardModalEl = document.getElementById('forwardMessageModal');
  if (forwardModalEl) {
    forwardModalEl.addEventListener('hidden.bs.modal', () => {
      appState.forwardingMessage = null;
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
      <span>${f.nickname || f.username}</span>
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
      .map((id) => appState.userMap[id]?.nickname || appState.userMap[id]?.username || `用户${id}`)
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
  const titleEl = document.getElementById('groupManageTitle');
  if (titleEl) titleEl.textContent = `群管理 · ${conv.title || conv.name}`;
  const avatarEl = document.getElementById('groupManageAvatar');
  if (avatarEl) avatarEl.src = getConversationAvatar(conv);
  const nameEl = document.getElementById('groupManageName');
  if (nameEl) nameEl.textContent = conv.title || conv.name || '群聊';
  const noticeEl = document.getElementById('groupManageNotice');
  if (noticeEl) noticeEl.textContent = `群公告：${conv.notice || '暂无公告'}`;
  await refreshGroupManageModal(groupId);
  const modal = new bootstrap.Modal(document.getElementById('groupManageModal'));
  modal.show();
}

async function refreshGroupManageModal(groupId) {
  const [members, _friends] = await Promise.all([apiGetRoomMembers(groupId), refreshFriends()]);
  const me = (members || []).find((m) => Number(m.user_id) === Number(appState.currentUser?.id));
  const actor = {
    isOwner: me?.role === 'owner',
    canKick: !!(me?.role === 'owner' || me?.can_kick),
    canMute: !!(me?.role === 'owner' || me?.can_mute)
  };
  renderGroupManageMembers(members || [], actor);
  renderGroupAddMemberOptions(groupId, members || [], actor.isOwner);
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
    .map((u) => `<option value="${u.id}">${escapeHtml(u.nickname || u.username)}</option>`)
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
  members.forEach((m) => {
    const isSelf = Number(m.user_id) === Number(appState.currentUser?.id);
    const roleBadge = m.role === 'owner' ? '<span class="badge text-bg-warning ms-1">群主</span>' : '';
    const delegatedBadge = m.role !== 'owner' && (m.can_kick || m.can_mute)
      ? `<span class="badge text-bg-info ms-1">${m.can_kick && m.can_mute ? '管理员' : (m.can_kick ? '可踢人' : '可禁言')}</span>`
      : '';
    const isOnline = appState.onlineUserIds.has(Number(m.user_id)) || !!appState.userMap[m.user_id]?.online;
    const dotClass = isOnline ? 'on' : 'off';
    const onlineText = isOnline ? '在线' : '离线';
    const muteBtn = actor.canMute && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-secondary member-mute-btn">${m.muted ? '取消禁言' : '禁言'}</button>`
      : '';
    const removeBtn = actor.canKick && !isSelf && m.role !== 'owner'
      ? '<button class="btn btn-sm btn-outline-danger member-remove-btn">踢出</button>'
      : '';
    const grantKickBtn = actor.isOwner && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-primary member-grant-kick-btn">${m.can_kick ? '取消踢人权' : '赋予踢人权'}</button>`
      : '';
    const grantMuteBtn = actor.isOwner && !isSelf && m.role !== 'owner'
      ? `<button class="btn btn-sm btn-outline-primary member-grant-mute-btn">${m.can_mute ? '取消禁言权' : '赋予禁言权'}</button>`
      : '';

    const row = document.createElement('div');
    row.className = 'list-group-item d-flex justify-content-between align-items-center';
    row.innerHTML = `
      <div>
        <div class="fw-semibold"><span class="online-dot ${dotClass}"></span>${escapeHtml(m.nickname || m.username)} ${roleBadge} ${delegatedBadge}</div>
        <small class="text-secondary">ID: ${m.user_id} · ${onlineText} ${m.muted ? '· 已禁言' : ''}</small>
      </div>
      <div class="d-flex gap-2">
        ${grantKickBtn}
        ${grantMuteBtn}
        ${muteBtn}
        ${removeBtn}
      </div>
    `;
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
  if (editBtn) editBtn.classList.toggle('d-none', !canEditOwnMessage(msg));
  const modal = new bootstrap.Modal(document.getElementById('messageActionModal'));
  modal.show();
}

function openForwardModal(msg) {
  appState.forwardingMessage = msg;
  const preview = document.getElementById('forwardPreviewText');
  if (preview) {
    preview.textContent = isImageMessageText(msg.text)
      ? '将转发一条图片消息'
      : `将转发：${summarizeMessageText(msg.text)}`;
  }
  renderForwardTargetList();
  const modal = new bootstrap.Modal(document.getElementById('forwardMessageModal'));
  modal.show();
}

function renderForwardTargetList() {
  const box = document.getElementById('forwardTargetList');
  if (!box) return;
  box.innerHTML = '';
  const list = (appState.conversations || []).slice().sort((a, b) => {
    const ta = a.messages.length ? a.messages[a.messages.length - 1].createdAt : 0;
    const tb = b.messages.length ? b.messages[b.messages.length - 1].createdAt : 0;
    return tb - ta;
  });
  if (!list.length) {
    box.innerHTML = '<div class="text-secondary small">暂无可转发会话</div>';
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
    box.appendChild(row);
  });
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
  const msg = appState.forwardingMessage;
  if (!msg) return;
  const checks = [...document.querySelectorAll('.forward-target-check:checked')];
  if (!checks.length) {
    alert('请至少选择一个目标会话');
    return;
  }

  const btn = document.getElementById('confirmForwardBtn');
  setButtonLoading(btn, true, '转发中...', '一键转发');

  const targets = checks.map((c) => Number(c.value)).filter(Boolean);
  const success = [];
  const failed = [];

  for (const roomId of targets) {
    const conv = findConversationById(roomId);
    try {
      const sent = await apiSendMessageDirect(roomId, msg.text);
      success.push(conv?.title || conv?.name || `会话${roomId}`);
      const normalized = normalizeMessage(sent);
      if (conv) {
        const exists = conv.messages.some((m) => m.id === normalized.id);
        if (!exists) conv.messages.push(normalized);
      }
      if (appState.activeConversationId === roomId && conv) {
        appendMessagesToView(conv, [normalized], { autoScroll: true });
        await markCurrentRoomRead();
      }
    } catch (err) {
      failed.push(`${conv?.title || conv?.name || roomId}: ${err.message}`);
    }
  }

  setButtonLoading(btn, false, '转发中...', '一键转发');
  const modal = bootstrap.Modal.getInstance(document.getElementById('forwardMessageModal'));
  if (modal) modal.hide();
  appState.forwardingMessage = null;
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
  const msgList = document.getElementById('messageList');
  const uploadImageBtn = document.getElementById('uploadImageBtn');
  const imageInput = document.getElementById('imageInput');
  const clearReplyBtn = document.getElementById('clearReplyBtn');
  const actionReplyBtn = document.getElementById('msgActionReplyBtn');
  const actionEditBtn = document.getElementById('msgActionEditBtn');
  const actionForwardBtn = document.getElementById('msgActionForwardBtn');
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
  const chatHeaderMain = document.getElementById('chatHeaderMain');
  const emojiToggleBtn = document.getElementById('emojiToggleBtn');
  const directDetailsHistorySearchBtn = document.getElementById('directDetailsHistorySearchBtn');
  const directDetailsHistoryPhotosBtn = document.getElementById('directDetailsHistoryPhotosBtn');

  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (msgInput) msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
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
  if (actionForwardBtn) actionForwardBtn.addEventListener('click', () => {
    if (!appState.actionTargetMessage) return;
    const msg = appState.actionTargetMessage;
    const modal = bootstrap.Modal.getInstance(document.getElementById('messageActionModal'));
    if (modal) modal.hide();
    openForwardModal(msg);
  });
  if (mobileBackBtn) mobileBackBtn.addEventListener('click', () => {
    appState.activeConversationId = null;
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
    const listEl = document.getElementById('messageList');
    appState.userNearBottom = isNearBottom(listEl, 90);
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

  try {
    const uploaded = await apiUploadImage(file);
    if (!uploaded || !uploaded.url) throw new Error('上传返回无效');
    const sent = await apiSendMessage(conv.id, `![img](${uploaded.url})`, {
      replyToMessageId: appState.replyingToMessage?.id || null
    });
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
  if (!conv || !conv.messages.length || conv.hasMore === false) return;

  const oldest = conv.messages[0];
  if (!oldest) return;

  const listEl = document.getElementById('messageList');
  const beforeHeight = listEl.scrollHeight;
  const btn = document.getElementById('loadMoreBtn');

  appState.loadingMore = true;
  btn.disabled = true;
  btn.textContent = '加载中...';

  try {
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

    renderMessages({ autoScroll: false });
    const afterHeight = listEl.scrollHeight;
    listEl.scrollTop = afterHeight - beforeHeight;
  } catch (err) {
    console.error('加载历史消息失败', err);
  } finally {
    appState.loadingMore = false;
    btn.disabled = false;
    btn.textContent = conv.hasMore === false ? '没有更多' : '加载更多';
  }
}

function openEditMessageModal(msg) {
  if (appState.currentUser.role !== 'admin') return;
  appState.editingMessageId = msg.id;
  document.getElementById('editMessageId').value = String(msg.id);
  document.getElementById('editMessageText').value = msg.text;
  const modal = new bootstrap.Modal(document.getElementById('editMessageModal'));
  modal.show();
}

async function saveEditedMessage() {
  if (appState.currentUser.role !== 'admin') return;
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
    const lastMsg = conv.messages[conv.messages.length - 1];
    const lastPreview = lastMsg
      ? (/^!\[img\]\(([^)]+)\)$/.test(lastMsg.text) ? '[图片]' : lastMsg.text.slice(0, 18))
      : '';
    const lastTime = lastMsg ? formatConversationTime(lastMsg.createdAt) : '';
    const avatar = getConversationAvatar(conv);
    const btn = document.createElement('button');
    btn.className = `list-group-item list-group-item-action ${appState.activeConversationId === conv.id ? 'active' : ''}`;

    const badge = conv.unreadCount > 0 ? `<span class="badge rounded-pill text-bg-danger">${conv.unreadCount}</span>` : '';
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
              ${conv.type === 'group' ? `${conv.memberCount || conv.members.length}人群聊` : '单聊'}${lastPreview ? ` · ${lastPreview}` : ''}
            </div>
            ${badge}
          </div>
        </div>
      </div>
    `;

    btn.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
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
  bubble.className = `msg-bubble ${msg.localPending ? 'pending' : ''} ${msg.localFailed ? 'failed' : ''}`;

  const senderName = !me && conv.type === 'group'
    ? `<div class="small fw-bold mb-1">${sender?.nickname || sender?.username || '用户'}</div>`
    : '';
  const messageContent = renderMessageContent(msg.text);
  const replySenderName = msg.replyToSenderId ? getDisplayNameByUserId(msg.replyToSenderId) : '';
  const replyText = msg.replyToContent ? summarizeMessageText(msg.replyToContent) : '';
  const replyBlock = msg.replyToMessageId
    ? `<div class="msg-reply-preview"><div class="fw-semibold">${escapeHtml(replySenderName || '消息')}</div><div>${escapeHtml(replyText || '引用消息')}</div></div>`
    : '';

  const stateText = msg.localFailed ? '发送失败' : (msg.localPending ? '发送中...' : '');
  bubble.innerHTML = `
    <button class="msg-action-btn" type="button" aria-label="消息操作">⋮</button>
    ${senderName}
    ${replyBlock}
    <div>${messageContent}</div>
    <div class="msg-meta">${formatTime(msg.createdAt)} ${stateText ? ` · ${stateText}` : ''}</div>
  `;

  const actionBtn = bubble.querySelector('.msg-action-btn');
  if (actionBtn) actionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMessageActionMenu(msg);
  });

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
  const { autoScroll = true } = options;
  const listEl = document.getElementById('messageList');
  if (!listEl || !messages.length) return;

  const frag = document.createDocumentFragment();
  messages.forEach((msg) => frag.appendChild(buildMessageRow(msg, conv)));
  listEl.appendChild(frag);

  if (autoScroll) scrollMessagesToBottom({ force: false });
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
  const listEl = document.getElementById('messageList');
  const titleEl = document.getElementById('chatTitle');
  const subEl = document.getElementById('chatSubTitle');
  const avatarEl = document.getElementById('chatAvatar');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const groupMembersBtn = document.getElementById('groupMembersBtn');
  const composer = document.getElementById('chatComposer');
  const chatDetailsBtn = document.getElementById('chatDetailsBtn');
  if (!listEl || !titleEl || !subEl || !loadMoreBtn || !composer) return;

  listEl.innerHTML = '';

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    setChatPaneVisible(false);
    titleEl.textContent = '未选择会话';
    subEl.textContent = '请选择会话';
    if (avatarEl) avatarEl.src = DEFAULT_AVATAR;
    if (chatDetailsBtn) chatDetailsBtn.disabled = true;
    loadMoreBtn.classList.add('d-none');
    if (groupMembersBtn) groupMembersBtn.classList.add('d-none');
    composer.classList.add('d-none');
    applyMuteComposerState(null);
    listEl.innerHTML = '';
    clearReplyAndEditState();
    toggleEmojiPanel(false);
    updateCallButtonsState();
    return;
  }
  setChatPaneVisible(true);
  if (chatDetailsBtn) chatDetailsBtn.disabled = false;
  loadMoreBtn.classList.remove('d-none');
  composer.classList.remove('d-none');
  applyMuteComposerState(conv);
  loadMoreBtn.disabled = conv.messages.length === 0;
  loadMoreBtn.textContent = conv.messages.length === 0
    ? '暂无历史'
    : (conv.hasMore === false ? '没有更多' : '加载更多');

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
  }

  appendMessagesToView(conv, conv.messages, { autoScroll });
  if (forceBottom) {
    appState.userNearBottom = true;
    scrollMessagesToBottom({ force: true });
  }
  renderComposerState();
  refreshCurrentUserMuteState(conv.id).then(() => applyMuteComposerState(conv));
  updateCallButtonsState();
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
      if (sent.via === 'http' && sent.message) {
        const msg = normalizeMessage(sent.message);
        const replaced = reconcilePendingMessage(conv, msg);
        if (!replaced) {
          const exists = conv.messages.some((m) => m.id === msg.id);
          if (!exists) conv.messages.push(msg);
        }
        renderMessages({ autoScroll: true });
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
  clearReplyAndEditState();
  toggleEmojiPanel(false);
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
    online: !!me.is_online
  };

  mergeUserToMap(me);
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
  registerServiceWorker();

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
  apiGetRoomMembers,
  apiAddRoomMember,
  apiRemoveRoomMember,
  apiMuteRoomMember,
  apiUnmuteRoomMember,
  apiSetRoomMemberPermissions,
  apiGetRoomMessages,
  apiGetUnreadCounts,
  apiMarkRoomRead,
  apiEditMessage,
  apiSendMessage,
  apiUploadImage
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
