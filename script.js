// ============================
// 真实后端对接版（FastAPI + WebSocket）
// ============================

const STORAGE_KEYS = {
  token: 'chatwave_token',
  theme: 'chatwave_theme'
};
const DEFAULT_API_BASE = 'https://web-production-f9619e.up.railway.app';
const LEGACY_API_BASES = ['https://web-production-afb64.up.railway.app'];

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
  conversations: [],
  activeConversationId: null,
  currentView: 'messagesView',
  editingMessageId: null,
  ws: null,
  wsReconnectTimer: null,
  wsReconnectTried: false,
  pendingAvatarBase64: null,
  loadingMore: false,
  roomPollTimer: null,
  roomPollInFlight: false
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
  return (localStorage.getItem('chat_api_base') || DEFAULT_API_BASE).replace(/\/$/, '');
}

function ensureApiBase() {
  const current = (localStorage.getItem('chat_api_base') || '').replace(/\/$/, '');
  if (!current) {
    localStorage.setItem('chat_api_base', DEFAULT_API_BASE);
    return;
  }
  if (current !== DEFAULT_API_BASE || LEGACY_API_BASES.includes(current)) {
    localStorage.setItem('chat_api_base', DEFAULT_API_BASE);
    console.info('API base updated');
  }
}

function showLoginBy401(reason) {
  console.warn('鉴权失败，返回登录页:', reason);
  clearToken();
  showAuth();
  switchAuthPage('login');
}

function normalizePhone(input) {
  return (input || '').replace(/[^\d]/g, '');
}

function phoneToCompatEmail(phone) {
  return `${phone}@phone.local`;
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

function getUnreadTotal() {
  return appState.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}

function normalizeMessage(raw) {
  return {
    id: raw.id,
    senderId: raw.sender_id,
    text: raw.content,
    createdAt: new Date(raw.created_at).getTime(),
    updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : null,
    editedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : null,
    editedByAdmin: !!raw.edited_by_admin
  };
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

function switchView(viewId) {
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
    renderMessages();
    startRoomPolling(appState.activeConversationId);
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

  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers
  });

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

    if (res.status === 401) {
      showLoginBy401(detail);
    }
    throw new Error(detail);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

async function apiLogin(phone, password) {
  const normalizedPhone = normalizePhone(phone);
  // 兼容当前后端：phone -> username
  return apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: normalizedPhone, password })
  });
}

async function apiRegister(phone, password) {
  const normalizedPhone = normalizePhone(phone);
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
  return apiFetch(`/api/users/search?q=${encodeURIComponent(keyword)}`);
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

function apiSendMessage(roomId, content) {
  sendWsMessage({
    action: 'send_message',
    room_id: roomId,
    content
  });
  return Promise.resolve({ ok: true });
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
    avatar: appState.userMap[f.id]?.avatar || DEFAULT_AVATAR
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

function getDmConversationWithFriend(friendId) {
  return appState.conversations.find(
    (c) => isDmConversation(c) && c.members.includes(friendId) && c.members.includes(appState.currentUser.id)
  );
}

function stopRoomPolling() {
  if (appState.roomPollTimer) {
    clearInterval(appState.roomPollTimer);
    appState.roomPollTimer = null;
  }
  appState.roomPollInFlight = false;
}

async function pollActiveRoomMessages() {
  if (appState.roomPollInFlight) return;
  const conv = findConversationById(appState.activeConversationId);
  if (!conv) return;

  appState.roomPollInFlight = true;
  try {
    const batch = await apiGetRoomMessages(conv.id, 20);
    const normalized = batch.map(normalizeMessage).reverse();
    const existing = new Set(conv.messages.map((m) => m.id));
    let hasNew = false;

    normalized.forEach((msg) => {
      if (!existing.has(msg.id)) {
        conv.messages.push(msg);
        hasNew = true;
      }
    });

    if (hasNew) {
      renderConversationList();
      if (appState.currentView === 'messagesView' && appState.activeConversationId === conv.id) {
        renderMessages();
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
  appState.roomPollTimer = setInterval(() => {
    pollActiveRoomMessages();
  }, 2000);
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

  if (evt.type === 'read_receipt') {
    // 可选事件：当前版本不展示“谁已读到哪里”，保留入口以便后续扩展
    return;
  }

  if (evt.type === 'new_message') {
    const msg = normalizeMessage(evt.payload);
    const conv = findConversationById(msg.room_id);
    if (!conv) return;

    const exists = conv.messages.some((m) => m.id === msg.id);
    if (!exists) conv.messages.push(msg);

    const isCurrent = appState.activeConversationId === conv.id && appState.currentView === 'messagesView';
    const isFromOther = msg.senderId !== appState.currentUser.id;

    if (!isCurrent && isFromOther) {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
      const sender = appState.userMap[msg.senderId];
      notifyMessage(sender?.nickname || sender?.username || '新消息', msg.text);
    }

    renderConversationList();
    if (appState.activeConversationId === conv.id) renderMessages();
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

    renderConversationList();
    if (appState.activeConversationId === conv.id) renderMessages();
    return;
  }

  if (evt.type === 'error') {
    console.warn('[WS] server error:', evt.payload?.message);
  }
}

function sendWsMessage(payload) {
  if (!appState.ws || appState.ws.readyState !== WebSocket.OPEN) {
    alert('实时连接未建立，请稍后重试');
    return;
  }
  appState.ws.send(JSON.stringify(payload));
}

// ============================
// 登录/注册
// ============================
function bindAuthEvents() {
  document.getElementById('toRegisterBtn').addEventListener('click', () => switchAuthPage('register'));
  document.getElementById('toLoginBtn').addEventListener('click', () => switchAuthPage('login'));

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('loginPhone').value.trim();
    const password = document.getElementById('loginPassword').value.trim();

    try {
      const data = await apiLogin(phone, password);
      setToken(data.token);
      await bootstrapAfterLogin(data.user);
    } catch (err) {
      alert(`登录失败：${err.message}`);
    }
  });

  document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value.trim();

    try {
      const data = await apiRegister(phone, password);
      setToken(data.token);
      await bootstrapAfterLogin(data.user);
    } catch (err) {
      alert(`注册失败：${err.message}`);
    }
  });
}

function logout() {
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

  document.getElementById('saveProfileBtn').addEventListener('click', async () => {
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

  document.getElementById('toggleThemeBtn').addEventListener('click', () => {
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
  document.getElementById('friendSearchBtn').addEventListener('click', handleFriendSearch);
}

async function handleFriendSearch() {
  const keyword = document.getElementById('friendSearchInput').value.trim();
  const box = document.getElementById('friendSearchResults');
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
      mergeUserToMap({
        id: item.id,
        username: item.username,
        nickname: item.nickname,
        email: '',
        avatar_base64: appState.userMap[item.id]?.avatar || DEFAULT_AVATAR,
        is_online: item.is_online,
        role: 'member'
      });

      const row = document.createElement('div');
      row.className = 'list-group-item d-flex justify-content-between align-items-center';
      row.innerHTML = `
        <div>
          <div class="fw-semibold">${item.nickname || item.username}</div>
          <small class="text-secondary">@${item.username}</small>
        </div>
        <button class="btn btn-sm btn-outline-primary">申请</button>
      `;
      row.querySelector('button').addEventListener('click', () => addFriendById(item.id));
      box.appendChild(row);
    });
  } catch (err) {
    box.innerHTML = `<div class="text-danger small">搜索失败：${err.message}</div>`;
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
    box.innerHTML = '<div class="text-secondary">还没有好友，去搜索添加吧。</div>';
    return;
  }

  appState.friends.forEach((f) => {
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
  switchView('messagesView');
  renderConversationList();
  renderMessages();
  startRoomPolling(conv.id);
  pollActiveRoomMessages().catch((err) => console.warn('首次轮询失败', err.message));
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
    item.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <div class="fw-semibold">${g.name}</div>
          <small class="text-secondary">成员：${names}</small>
        </div>
        <span class="badge text-bg-info">${g.members.length}人</span>
      </div>
    `;

    item.addEventListener('click', () => {
      appState.activeConversationId = g.id;
      g.unreadCount = 0;
      switchView('messagesView');
      renderConversationList();
      renderMessages();
      startRoomPolling(g.id);
      pollActiveRoomMessages().catch((err) => console.warn('首次轮询失败', err.message));
      updateUnreadBadges();
      markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
    });

    box.appendChild(item);
  });
}

// ============================
// 聊天渲染 + 发送 + 编辑
// ============================
function bindChatEvents() {
  const sendBtn = document.getElementById('sendMessageBtn');
  const msgInput = document.getElementById('messageInput');
  const saveEditBtn = document.getElementById('saveEditMessageBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const msgList = document.getElementById('messageList');
  const uploadImageBtn = document.getElementById('uploadImageBtn');
  const imageInput = document.getElementById('imageInput');

  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (msgInput) msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  if (saveEditBtn) saveEditBtn.addEventListener('click', saveEditedMessage);
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMoreMessages);
  if (uploadImageBtn && imageInput) {
    uploadImageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', handleImageUpload);
  }

  // 上滑到顶部自动触发历史加载
  if (msgList) msgList.addEventListener('scroll', () => {
    const listEl = document.getElementById('messageList');
    if (listEl.scrollTop <= 10) {
      loadMoreMessages();
    }
  });

  const emojiBar = document.getElementById('emojiBar');
  EMOJIS.forEach((emoji) => {
    const b = document.createElement('button');
    b.className = 'btn btn-light btn-sm';
    b.textContent = emoji;
    b.addEventListener('click', () => {
      const input = document.getElementById('messageInput');
      input.value += emoji;
      input.focus();
    });
    emojiBar.appendChild(b);
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

  try {
    const uploaded = await apiUploadImage(file);
    if (!uploaded || !uploaded.url) throw new Error('上传返回无效');
    sendWsMessage({
      action: 'send_message',
      room_id: conv.id,
      content: `![img](${uploaded.url})`
    });
  } catch (err) {
    if ((err.message || '').includes('Not Found')) {
      alert('上传接口未部署/路径不一致，请检查后端 /api/uploads/images');
      return;
    }
    alert(`图片发送失败：${err.message}`);
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
    box.innerHTML = '<div class="p-3 text-secondary">暂无会话，请先添加好友或创建群组。</div>';
    renderMessages();
    return;
  }

  list.forEach((conv) => {
    const lastMsg = conv.messages[conv.messages.length - 1];
    const lastPreview = lastMsg
      ? (/^!\[img\]\(([^)]+)\)$/.test(lastMsg.text) ? '[图片]' : lastMsg.text.slice(0, 18))
      : '';
    const btn = document.createElement('button');
    btn.className = `list-group-item list-group-item-action ${appState.activeConversationId === conv.id ? 'active' : ''}`;

    const badge = conv.unreadCount > 0 ? `<span class="badge rounded-pill text-bg-danger">${conv.unreadCount}</span>` : '';
    btn.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div class="text-start">
          <div class="fw-semibold">${conv.type === 'group' ? '群' : '私'} · ${getConversationTitle(conv)}</div>
          <small class="${appState.activeConversationId === conv.id ? 'text-light' : 'text-secondary'}">
            ${conv.type === 'group' ? `${conv.memberCount || conv.members.length}人群聊` : '单聊'}${lastPreview ? ` · ${lastPreview}` : ''}
          </small>
        </div>
        ${badge}
      </div>
    `;

    btn.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
      conv.unreadCount = 0;
      renderConversationList();
      renderMessages();
      startRoomPolling(conv.id);
      pollActiveRoomMessages().catch((err) => console.warn('首次轮询失败', err.message));
      updateUnreadBadges();
      markCurrentRoomRead().catch((err) => console.warn('标记已读失败', err.message));
    });

    box.appendChild(btn);
  });

  updateUnreadBadges();
}

async function markCurrentRoomRead() {
  const conv = findConversationById(appState.activeConversationId);
  if (!conv) return;
  const last = conv.messages[conv.messages.length - 1];
  await apiMarkRoomRead(conv.id, last?.id || null);
  conv.unreadCount = 0;
  renderConversationList();
  updateUnreadBadges();
}

function renderMessages(options = {}) {
  const { autoScroll = true } = options;
  const listEl = document.getElementById('messageList');
  const titleEl = document.getElementById('chatTitle');
  const subEl = document.getElementById('chatSubTitle');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const composer = document.getElementById('chatComposer');
  if (!listEl || !titleEl || !subEl || !loadMoreBtn || !composer) return;

  listEl.innerHTML = '';

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    titleEl.textContent = '未选择会话';
    subEl.textContent = '请选择好友开始聊天';
    loadMoreBtn.classList.add('d-none');
    composer.classList.add('d-none');
    listEl.innerHTML = '<div class="h-100 d-flex align-items-center justify-content-center text-secondary">请选择好友开始聊天</div>';
    return;
  }
  loadMoreBtn.classList.remove('d-none');
  composer.classList.remove('d-none');
  loadMoreBtn.disabled = conv.messages.length === 0;
  loadMoreBtn.textContent = conv.messages.length === 0
    ? '暂无历史'
    : (conv.hasMore === false ? '没有更多' : '加载更多');

  titleEl.textContent = getConversationTitle(conv);
  if (conv.type === 'group') {
    subEl.textContent = `群成员：${conv.members.length} 人`;
  } else {
    const other = getOtherUserInPrivateConversation(conv);
    subEl.textContent = other?.online ? '在线' : '离线';
  }

  conv.messages.forEach((msg) => {
    const me = msg.senderId === appState.currentUser.id;
    const sender = appState.userMap[msg.senderId];

    const row = document.createElement('div');
    row.className = `msg-row ${me ? 'me' : 'other'}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const senderName = !me && conv.type === 'group'
      ? `<div class="small fw-bold mb-1">${sender?.nickname || sender?.username || '用户'}</div>`
      : '';
    const isEdited = !!(msg.updatedAt && msg.updatedAt > msg.createdAt);
    const editedMark = isEdited ? `（已编辑 ${formatTime(msg.updatedAt)}）` : '';
    const messageContent = renderMessageContent(msg.text);

    bubble.innerHTML = `
      ${senderName}
      <div>${messageContent}</div>
      <div class="msg-meta">${formatTime(msg.createdAt)} ${editedMark}</div>
    `;

    // 管理员可编辑“自己历史消息”：点击自己的消息触发 Bootstrap 弹窗
    if (me && appState.currentUser.role === 'admin') {
      bubble.title = '管理员可点击编辑消息';
      bubble.style.cursor = 'pointer';
      bubble.addEventListener('click', () => openEditMessageModal(msg));
    }

    row.appendChild(bubble);
    listEl.appendChild(row);
  });

  if (autoScroll) {
    listEl.scrollTop = listEl.scrollHeight;
  }
}

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text) return;

  const conv = findConversationById(appState.activeConversationId);
  if (!conv) {
    alert('请先选择一个会话');
    return;
  }

  // TODO: 后端 WebSocket 发送消息
  // ws.send({ action: 'send_message', room_id, content })
  sendWsMessage({
    action: 'send_message',
    room_id: conv.id,
    content: text
  });

  input.value = '';
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
  await refreshFriends();
  await refreshFriendRequests();
  await refreshFriendRemarks();
  await refreshPresenceOnlineList();
  await refreshRoomsAndMessages();
  await refreshUnreadCounts();

  connectWebSocket();
  enterApp();
}

function enterApp() {
  showMain();
  switchView('messagesView');

  updateUserHeader();
  renderProfile();
  renderFriendList();
  renderFriendRequestLists();
  renderGroupList();
  renderConversationList();
  renderMessages();
  renderGroupMemberOptions();
  updateUnreadBadges();

  requestNotificationPermission();
}

async function init() {
  ensureApiBase();

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

  const token = getToken();
  if (!token) {
    showAuth();
    switchAuthPage('login');
    return;
  }

  try {
    await bootstrapAfterLogin();
  } catch (err) {
    console.warn('token 失效，回到登录页：', err.message);
    clearToken();
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
  apiGetRoomMessages,
  apiGetUnreadCounts,
  apiMarkRoomRead,
  apiEditMessage,
  apiSendMessage,
  apiUploadImage
};
