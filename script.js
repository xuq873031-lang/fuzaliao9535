// ============================
// 全局状态与常量
// ============================
const STORAGE_KEYS = {
  users: 'mock_users',
  token: 'token',
  currentUserId: 'mock_current_user_id',
  conversations: 'mock_conversations',
  theme: 'mock_theme'
};

const DEFAULT_AVATAR =
  'data:image/svg+xml;base64,' +
  btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="100%" height="100%" fill="#229ed9"/><text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-size="28">U</text></svg>`);

const EMOJIS = ['😀', '😁', '😂', '😊', '😍', '😎', '🤔', '😭', '👍', '🎉', '❤️', '🔥'];

const MOCK_SEARCH_POOL = [
  { username: 'alice', email: 'alice@example.com' },
  { username: 'bob', email: 'bob@example.com' },
  { username: 'charlie', email: 'charlie@example.com' },
  { username: 'david', email: 'david@example.com' },
  { username: 'eva', email: 'eva@example.com' }
];

let appState = {
  currentUser: null,
  users: [],
  conversations: [],
  activeConversationId: null,
  currentView: 'messagesView',
  messageInterval: null,
  editingMessageId: null
};

// ============================
// 工具函数（本地存储 + 时间格式化）
// ============================
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function createId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
}

function saveUsers() {
  writeJSON(STORAGE_KEYS.users, appState.users);
}

function saveConversations() {
  writeJSON(STORAGE_KEYS.conversations, appState.conversations);
}

function persistAuth(user) {
  // TODO: 后端登录/注册
  // fetch('http://localhost:8000/api/login', { method: 'POST', body: JSON.stringify(data) })
  // 现在用 mock: localStorage 存 token + 当前用户 ID
  localStorage.setItem(STORAGE_KEYS.token, `fake-token-${user.id}`);
  localStorage.setItem(STORAGE_KEYS.currentUserId, user.id);
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEYS.token);
  localStorage.removeItem(STORAGE_KEYS.currentUserId);
}

function getToken() {
  return localStorage.getItem(STORAGE_KEYS.token);
}

function getCurrentUserId() {
  return localStorage.getItem(STORAGE_KEYS.currentUserId);
}

function getOtherUserInPrivateConversation(conv) {
  const uid = appState.currentUser.id;
  return appState.users.find((u) => conv.members.includes(u.id) && u.id !== uid) || null;
}

function getUnreadTotal() {
  return appState.conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
}

// ============================
// 初始化 mock 数据
// ============================
function ensureMockData() {
  const users = readJSON(STORAGE_KEYS.users, []);
  const conversations = readJSON(STORAGE_KEYS.conversations, []);

  if (!users.length) {
    const seedUsers = [
      {
        id: 'u_demo',
        username: 'demo',
        email: 'demo@example.com',
        password: '123456',
        role: 'admin',
        nickname: '演示用户',
        signature: '欢迎来到 Mock Chat',
        avatar: DEFAULT_AVATAR,
        friends: ['u_alice', 'u_bob']
      },
      {
        id: 'u_alice',
        username: 'alice',
        email: 'alice@example.com',
        password: '123456',
        role: 'member',
        nickname: 'Alice',
        signature: '保持热爱',
        avatar: DEFAULT_AVATAR,
        friends: ['u_demo'],
        online: true
      },
      {
        id: 'u_bob',
        username: 'bob',
        email: 'bob@example.com',
        password: '123456',
        role: 'member',
        nickname: 'Bob',
        signature: '代码改变世界',
        avatar: DEFAULT_AVATAR,
        friends: ['u_demo'],
        online: false
      }
    ];

    writeJSON(STORAGE_KEYS.users, seedUsers);
  }

  if (!conversations.length) {
    const now = Date.now();
    const seedConversations = [
      {
        id: 'c_demo_alice',
        type: 'private',
        name: '',
        members: ['u_demo', 'u_alice'],
        unreadCount: 1,
        messages: [
          { id: createId('m'), senderId: 'u_alice', text: 'Hi demo，今天写前端吗？', createdAt: now - 1000 * 60 * 45 },
          { id: createId('m'), senderId: 'u_demo', text: '在写，先做个纯前端聊天。', createdAt: now - 1000 * 60 * 41 },
          { id: createId('m'), senderId: 'u_alice', text: '不错，记得做响应式。', createdAt: now - 1000 * 60 * 38 }
        ]
      },
      {
        id: 'c_group_1',
        type: 'group',
        name: '前端交流群',
        members: ['u_demo', 'u_alice', 'u_bob'],
        unreadCount: 0,
        messages: [
          { id: createId('m'), senderId: 'u_bob', text: '大家晚上好！', createdAt: now - 1000 * 60 * 30 },
          { id: createId('m'), senderId: 'u_demo', text: '晚上好，来讨论 Bootstrap 5。', createdAt: now - 1000 * 60 * 28 }
        ]
      }
    ];

    writeJSON(STORAGE_KEYS.conversations, seedConversations);
  }
}

function loadStateFromStorage() {
  appState.users = readJSON(STORAGE_KEYS.users, []);
  appState.users = appState.users.map((u) => ({ role: 'member', ...u }));
  appState.conversations = readJSON(STORAGE_KEYS.conversations, []);

  const uid = getCurrentUserId();
  appState.currentUser = appState.users.find((u) => u.id === uid) || null;

  if (appState.currentUser) {
    const theme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
    setTheme(theme);
  }
}

// ============================
// 视图切换（登录页 / 主界面）
// ============================
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
}

// ============================
// 登录 / 注册逻辑（纯前端 mock）
// ============================
function bindAuthEvents() {
  document.getElementById('toRegisterBtn').addEventListener('click', () => switchAuthPage('register'));
  document.getElementById('toLoginBtn').addEventListener('click', () => switchAuthPage('login'));

  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();

    // TODO: 后端登录接口
    // fetch('http://localhost:8000/api/login', { method: 'POST', body: JSON.stringify({ username, password }) })

    const user = appState.users.find((u) => u.username === username && u.password === password);
    if (!user) {
      alert('用户名或密码错误');
      return;
    }

    persistAuth(user);
    loadStateFromStorage();
    enterApp();
  });

  document.getElementById('registerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value.trim();
    const confirm = document.getElementById('regConfirmPassword').value.trim();

    if (password !== confirm) {
      alert('两次密码不一致');
      return;
    }

    if (appState.users.some((u) => u.username === username)) {
      alert('用户名已存在');
      return;
    }

    const newUser = {
      id: createId('u'),
      username,
      email,
      password,
      role: 'member',
      nickname: username,
      signature: '这个人很懒，还没有签名',
      avatar: DEFAULT_AVATAR,
      friends: [],
      online: true
    };

    // TODO: 后端注册接口
    // fetch('http://localhost:8000/api/register', { method: 'POST', body: JSON.stringify({ username, email, password }) })

    appState.users.push(newUser);
    saveUsers();

    persistAuth(newUser);
    loadStateFromStorage();
    enterApp();
  });
}

function logout() {
  clearAuth();
  appState.currentUser = null;
  if (appState.messageInterval) clearInterval(appState.messageInterval);
  showAuth();
  switchAuthPage('login');
}

// ============================
// 导航、个人资料、主题
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

function setTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
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
      profileAvatar.src = base64;
      appState.currentUser.avatar = base64;

      const idx = appState.users.findIndex((u) => u.id === appState.currentUser.id);
      if (idx >= 0) {
        appState.users[idx].avatar = base64;
        saveUsers();
      }

      renderFriendList();
      renderConversationList();
      renderMessages();
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('saveProfileBtn').addEventListener('click', () => {
    const nickname = document.getElementById('nicknameInput').value.trim();
    const signature = document.getElementById('signatureInput').value.trim();

    appState.currentUser.nickname = nickname || appState.currentUser.username;
    appState.currentUser.signature = signature || '这个人很懒，还没有签名';

    const idx = appState.users.findIndex((u) => u.id === appState.currentUser.id);
    if (idx >= 0) appState.users[idx] = { ...appState.currentUser };
    saveUsers();

    updateUserHeader();
    alert('资料已保存（本地）');
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
// 好友系统（搜索 + 添加 + 列表）
// ============================
function bindFriendEvents() {
  document.getElementById('friendSearchBtn').addEventListener('click', handleFriendSearch);
}

function handleFriendSearch() {
  const keyword = document.getElementById('friendSearchInput').value.trim().toLowerCase();
  const box = document.getElementById('friendSearchResults');
  box.innerHTML = '';

  if (!keyword) {
    box.innerHTML = '<div class="text-secondary small">请输入关键词</div>';
    return;
  }

  // TODO: 后端好友搜索接口
  // fetch('http://localhost:8000/api/friends/search?q=' + keyword)
  // 当前使用 mock 搜索池 + 本地用户
  const localPool = appState.users.map((u) => ({ username: u.username, email: u.email }));
  const pool = [...MOCK_SEARCH_POOL, ...localPool];
  const unique = Array.from(new Map(pool.map((p) => [p.username, p])).values());

  const results = unique.filter((u) =>
    u.username.toLowerCase().includes(keyword) &&
    u.username !== appState.currentUser.username
  );

  if (!results.length) {
    box.innerHTML = '<div class="text-secondary small">无匹配结果</div>';
    return;
  }

  results.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'list-group-item d-flex justify-content-between align-items-center';
    row.innerHTML = `
      <div>
        <div class="fw-semibold">${item.username}</div>
        <small class="text-secondary">${item.email}</small>
      </div>
      <button class="btn btn-sm btn-outline-primary">添加</button>
    `;

    row.querySelector('button').addEventListener('click', () => addFriendByUsername(item.username));
    box.appendChild(row);
  });
}

function addFriendByUsername(username) {
  let friend = appState.users.find((u) => u.username === username);

  if (!friend) {
    friend = {
      id: createId('u'),
      username,
      email: `${username}@example.com`,
      password: '123456',
      nickname: username,
      signature: '你好，很高兴认识你',
      avatar: DEFAULT_AVATAR,
      friends: [appState.currentUser.id],
      online: Math.random() > 0.5
    };
    appState.users.push(friend);
  }

  if (!appState.currentUser.friends.includes(friend.id)) {
    appState.currentUser.friends.push(friend.id);
  }
  if (!friend.friends.includes(appState.currentUser.id)) {
    friend.friends.push(appState.currentUser.id);
  }

  // 确保存在单聊会话
  const existing = appState.conversations.find(
    (c) => c.type === 'private' && c.members.includes(friend.id) && c.members.includes(appState.currentUser.id)
  );

  if (!existing) {
    appState.conversations.unshift({
      id: createId('c'),
      type: 'private',
      name: '',
      members: [appState.currentUser.id, friend.id],
      unreadCount: 0,
      messages: []
    });
  }

  const meIdx = appState.users.findIndex((u) => u.id === appState.currentUser.id);
  const friendIdx = appState.users.findIndex((u) => u.id === friend.id);
  appState.users[meIdx] = { ...appState.currentUser };
  appState.users[friendIdx] = { ...friend };

  saveUsers();
  saveConversations();
  renderFriendList();
  renderConversationList();
  renderGroupMemberOptions();

  alert(`已添加 ${username} 为好友（mock）`);
}

function renderFriendList() {
  const box = document.getElementById('friendList');
  box.innerHTML = '';

  const friends = appState.currentUser.friends
    .map((fid) => appState.users.find((u) => u.id === fid))
    .filter(Boolean);

  if (!friends.length) {
    box.innerHTML = '<div class="text-secondary">还没有好友，去搜索添加吧。</div>';
    return;
  }

  friends.forEach((f) => {
    const item = document.createElement('button');
    item.className = 'list-group-item list-group-item-action d-flex justify-content-between align-items-center';
    item.innerHTML = `
      <div class="d-flex align-items-center gap-2">
        <img src="${f.avatar || DEFAULT_AVATAR}" width="32" height="32" class="rounded-circle" alt="avatar" />
        <div>
          <div class="fw-semibold">${f.nickname || f.username}</div>
          <small class="text-secondary">@${f.username}</small>
        </div>
      </div>
      <span class="badge ${f.online ? 'text-bg-success' : 'text-bg-secondary'}">${f.online ? '在线' : '离线'}</span>
    `;

    item.addEventListener('click', () => openPrivateChatWith(f.id));
    box.appendChild(item);
  });
}

function openPrivateChatWith(friendId) {
  const conv = appState.conversations.find(
    (c) => c.type === 'private' && c.members.includes(friendId) && c.members.includes(appState.currentUser.id)
  );

  if (!conv) return;

  appState.activeConversationId = conv.id;
  conv.unreadCount = 0;
  saveConversations();
  switchView('messagesView');
  renderConversationList();
  renderMessages();
  updateUnreadBadges();
}

// ============================
// 群组系统（创建群 + 列表 + 进入群聊）
// ============================
function bindGroupEvents() {
  document.getElementById('createGroupBtn').addEventListener('click', () => {
    const name = document.getElementById('groupNameInput').value.trim();
    if (!name) {
      alert('请输入群名称');
      return;
    }

    const checkedIds = [...document.querySelectorAll('.group-member-check:checked')].map((i) => i.value);
    const members = Array.from(new Set([appState.currentUser.id, ...checkedIds]));

    const conv = {
      id: createId('g'),
      type: 'group',
      name,
      members,
      unreadCount: 0,
      messages: [
        {
          id: createId('m'),
          senderId: appState.currentUser.id,
          text: `大家好，欢迎加入 ${name}！`,
          createdAt: Date.now()
        }
      ]
    };

    // TODO: 后端创建群聊接口
    // fetch('http://localhost:8000/api/groups', { method: 'POST', body: JSON.stringify({ name, members }) })

    appState.conversations.unshift(conv);
    saveConversations();
    renderGroupList();
    renderConversationList();

    document.getElementById('groupNameInput').value = '';
    document.querySelectorAll('.group-member-check').forEach((i) => (i.checked = false));

    const modal = bootstrap.Modal.getInstance(document.getElementById('createGroupModal'));
    modal.hide();
  });

  document.getElementById('createGroupModal').addEventListener('show.bs.modal', renderGroupMemberOptions);
}

function renderGroupMemberOptions() {
  const box = document.getElementById('groupMemberOptions');
  box.innerHTML = '';

  const friends = appState.currentUser.friends
    .map((fid) => appState.users.find((u) => u.id === fid))
    .filter(Boolean);

  if (!friends.length) {
    box.innerHTML = '<div class="text-secondary small">暂无好友可选</div>';
    return;
  }

  friends.forEach((f) => {
    const wrap = document.createElement('label');
    wrap.className = 'd-flex align-items-center gap-2 mb-2';
    wrap.innerHTML = `
      <input class="form-check-input group-member-check" type="checkbox" value="${f.id}" />
      <img src="${f.avatar || DEFAULT_AVATAR}" width="28" height="28" class="rounded-circle" alt="avatar" />
      <span>${f.nickname || f.username}</span>
    `;
    box.appendChild(wrap);
  });
}

function renderGroupList() {
  const box = document.getElementById('groupList');
  box.innerHTML = '';

  const groups = appState.conversations.filter(
    (c) => c.type === 'group' && c.members.includes(appState.currentUser.id)
  );

  if (!groups.length) {
    box.innerHTML = '<div class="text-secondary">还没有群组，先创建一个吧。</div>';
    return;
  }

  groups.forEach((g) => {
    const names = g.members
      .map((id) => appState.users.find((u) => u.id === id)?.nickname || '未知用户')
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
      saveConversations();
      switchView('messagesView');
      renderConversationList();
      renderMessages();
      updateUnreadBadges();
    });

    box.appendChild(item);
  });
}

// ============================
// 会话与聊天消息渲染
// ============================
function bindChatEvents() {
  document.getElementById('sendMessageBtn').addEventListener('click', sendMessage);
  document.getElementById('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
  document.getElementById('saveEditMessageBtn').addEventListener('click', saveEditedMessage);

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

function openEditMessageModal(msg) {
  if (appState.currentUser.role !== 'admin') return;
  appState.editingMessageId = msg.id;
  document.getElementById('editMessageId').value = msg.id;
  document.getElementById('editMessageText').value = msg.text;
  const modal = new bootstrap.Modal(document.getElementById('editMessageModal'));
  modal.show();
}

function saveEditedMessage() {
  if (appState.currentUser.role !== 'admin') return;
  const messageId = appState.editingMessageId;
  const text = document.getElementById('editMessageText').value.trim();
  if (!messageId || !text) return;

  const conv = getVisibleConversations().find((c) => c.id === appState.activeConversationId);
  if (!conv) return;
  const msg = conv.messages.find((m) => m.id === messageId);
  if (!msg) return;

  msg.text = text;
  msg.editedAt = Date.now();
  saveConversations();
  renderMessages();
  renderConversationList();

  const modal = bootstrap.Modal.getInstance(document.getElementById('editMessageModal'));
  if (modal) modal.hide();
}

function getVisibleConversations() {
  return appState.conversations.filter((c) => c.members.includes(appState.currentUser.id));
}

function getConversationTitle(conv) {
  if (conv.type === 'group') return conv.name;
  const other = getOtherUserInPrivateConversation(conv);
  return other ? (other.nickname || other.username) : '私聊';
}

function renderConversationList() {
  const box = document.getElementById('conversationList');
  box.innerHTML = '';

  const list = getVisibleConversations().sort((a, b) => {
    const ta = a.messages.length ? a.messages[a.messages.length - 1].createdAt : 0;
    const tb = b.messages.length ? b.messages[b.messages.length - 1].createdAt : 0;
    return tb - ta;
  });

  if (!appState.activeConversationId && list.length) appState.activeConversationId = list[0].id;

  if (!list.length) {
    box.innerHTML = '<div class="p-3 text-secondary">暂无会话，请先添加好友或创建群组。</div>';
    renderMessages();
    return;
  }

  list.forEach((conv) => {
    const lastMsg = conv.messages[conv.messages.length - 1];
    const btn = document.createElement('button');
    btn.className = `list-group-item list-group-item-action ${appState.activeConversationId === conv.id ? 'active' : ''}`;

    const badge = conv.unreadCount > 0 ? `<span class="badge rounded-pill text-bg-danger">${conv.unreadCount}</span>` : '';
    btn.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div class="text-start">
          <div class="fw-semibold">${getConversationTitle(conv)}</div>
          <small class="${appState.activeConversationId === conv.id ? 'text-light' : 'text-secondary'}">
            ${lastMsg ? lastMsg.text.slice(0, 22) : '暂无消息'}
          </small>
        </div>
        ${badge}
      </div>
    `;

    btn.addEventListener('click', () => {
      appState.activeConversationId = conv.id;
      conv.unreadCount = 0;
      saveConversations();
      renderConversationList();
      renderMessages();
      updateUnreadBadges();
    });

    box.appendChild(btn);
  });

  updateUnreadBadges();
}

function renderMessages() {
  const listEl = document.getElementById('messageList');
  const titleEl = document.getElementById('chatTitle');
  const subEl = document.getElementById('chatSubTitle');

  listEl.innerHTML = '';

  const conv = getVisibleConversations().find((c) => c.id === appState.activeConversationId);
  if (!conv) {
    titleEl.textContent = '请选择会话';
    subEl.textContent = '支持单聊和群聊';
    return;
  }

  titleEl.textContent = getConversationTitle(conv);
  if (conv.type === 'group') {
    subEl.textContent = `群成员：${conv.members.length} 人`;
  } else {
    const other = getOtherUserInPrivateConversation(conv);
    subEl.textContent = other?.online ? '在线' : '离线';
  }

  conv.messages.forEach((msg) => {
    const me = msg.senderId === appState.currentUser.id;
    const sender = appState.users.find((u) => u.id === msg.senderId);

    const row = document.createElement('div');
    row.className = `msg-row ${me ? 'me' : 'other'}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const senderName = !me && conv.type === 'group' ? `<div class="small fw-bold mb-1">${sender?.nickname || sender?.username || '用户'}</div>` : '';
    const editedMark = msg.editedAt ? '（已编辑）' : '';

    bubble.innerHTML = `
      ${senderName}
      <div>${msg.text}</div>
      <div class="msg-meta">${formatTime(msg.createdAt)} ${editedMark}</div>
    `;

    // 编辑自己消息：升级为 Bootstrap 弹窗，且仅管理员可见/可操作
    if (me && appState.currentUser.role === 'admin') {
      bubble.title = '管理员可点击编辑消息';
      bubble.style.cursor = 'pointer';
      bubble.addEventListener('click', () => openEditMessageModal(msg));
    }

    row.appendChild(bubble);
    listEl.appendChild(row);
  });

  // 聊天滚动自动到底部
  listEl.scrollTop = listEl.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text) return;

  const conv = getVisibleConversations().find((c) => c.id === appState.activeConversationId);
  if (!conv) {
    alert('请先选择一个会话');
    return;
  }

  conv.messages.push({
    id: createId('m'),
    senderId: appState.currentUser.id,
    text,
    createdAt: Date.now()
  });

  // TODO: 后端发送消息接口
  // fetch('http://localhost:8000/api/messages', { method: 'POST', body: JSON.stringify({ conversationId: conv.id, text }) })

  input.value = '';
  saveConversations();
  renderConversationList();
  renderMessages();
}

// ============================
// 通知与未读数
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
// 模拟实时新消息（setInterval）
// ============================
function startMockRealtime() {
  if (appState.messageInterval) clearInterval(appState.messageInterval);

  appState.messageInterval = setInterval(() => {
    const list = getVisibleConversations();
    if (!list.length) return;

    const conv = list[Math.floor(Math.random() * list.length)];

    // 选择一个“非当前用户”的发送者
    const candidates = conv.members.filter((id) => id !== appState.currentUser.id);
    if (!candidates.length) return;

    const senderId = candidates[Math.floor(Math.random() * candidates.length)];
    const fakeTexts = ['收到', '好的', '稍后给你', '这个想法不错', '等会语音聊', '我在看文档'];
    const text = fakeTexts[Math.floor(Math.random() * fakeTexts.length)];

    conv.messages.push({
      id: createId('m'),
      senderId,
      text,
      createdAt: Date.now()
    });

    // 如果不是当前打开会话，累计未读
    if (appState.activeConversationId !== conv.id || appState.currentView !== 'messagesView') {
      conv.unreadCount = (conv.unreadCount || 0) + 1;
    }

    saveConversations();
    renderConversationList();
    if (appState.activeConversationId === conv.id) renderMessages();
    updateUnreadBadges();

    const sender = appState.users.find((u) => u.id === senderId);
    notifyMessage(sender?.nickname || sender?.username || '新消息', text);
  }, 5000);
}

// ============================
// 进入主应用流程
// ============================
function enterApp() {
  showMain();
  switchView('messagesView');

  updateUserHeader();
  renderProfile();
  renderFriendList();
  renderGroupList();
  renderConversationList();
  renderMessages();
  renderGroupMemberOptions();
  updateUnreadBadges();

  requestNotificationPermission();
  startMockRealtime();
}

// ============================
// 页面启动
// ============================
function init() {
  ensureMockData();
  loadStateFromStorage();

  bindAuthEvents();
  bindNavigationEvents();
  bindProfileEvents();
  bindFriendEvents();
  bindGroupEvents();
  bindChatEvents();

  if (getToken() && appState.currentUser) {
    enterApp();
  } else {
    showAuth();
    switchAuthPage('login');
  }
}

document.addEventListener('DOMContentLoaded', init);
