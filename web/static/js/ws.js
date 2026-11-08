// Realtime websocket client: ticket auth, auto-reconnect, op handling.
import { api } from './api.js';
import { store, emit, upsertNode, removeNodes, setNodes, markSeen } from './store.js';

let ws = null;
let boardId = null;
let reconnectDelay = 500;
let closedByUs = false;
let resyncTimer = null;

export async function connectBoard(id) {
  await disconnect();
  boardId = id;
  closedByUs = false;
  await open();
}

export async function disconnect() {
  closedByUs = true;
  boardId = null;
  clearTimeout(resyncTimer);
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  store.presence.clear();
  store.selections.clear();
  emit('presence');
}

async function open() {
  const target = boardId;
  let ticket;
  try { ticket = await api.wsTicket(); }
  catch { return scheduleReconnect(); }
  if (target !== boardId) return; // switched boards meanwhile

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/api/ws?board_id=${target}&ticket=${ticket}`);

  ws.onopen = () => {
    reconnectDelay = 500;
    store.online = true;
    emit('presence');
  };

  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };

  ws.onclose = () => {
    if (closedByUs || target !== boardId) return;
    store.online = false;
    emit('presence');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    if (boardId != null && !closedByUs) open().catch(() => {});
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
}

function handle(msg) {
  const mine = msg.actor === api.clientId;
  // Any change event carries the board's new updatedAt — mark it seen so the
  // currently-open board (whether the change is ours or someone else's) never
  // shows a "changed" dot in the sidebar.
  if (msg.updatedAt != null) markSeen(boardId, msg.updatedAt);
  switch (msg.type) {
    case 'hello': {
      store.presence.clear();
      for (const u of msg.users || []) store.presence.set(u.userId, u);
      emit('presence');
      break;
    }
    case 'presence_join':
      if (msg.user) store.presence.set(msg.user.userId, msg.user);
      emit('presence');
      break;
    case 'presence_leave':
      store.presence.delete(msg.userId);
      store.selections.delete(msg.userId);
      emit('presence');
      break;
    case 'node_created':
      if (!mine) upsertNode(msg.node);
      break;
    case 'node_updated':
      if (!mine) upsertNode(msg.node);
      break;
    case 'nodes_deleted':
      if (!mine) removeNodes(msg.ids || []);
      break;
    case 'nodes_restored':
      if (!mine) resync();
      break;
    case 'field_created':
      if (!mine) applyField(msg.field);
      break;
    case 'field_updated':
      if (!mine) applyField(msg.field);
      break;
    case 'field_deleted':
      if (!mine) dropField(msg.nodeId, msg.id);
      break;
    case 'board_renamed':
      if (store.board?.board?.id === msg.id) {
        store.board.board.name = msg.name;
        emit('board');
      }
      break;
    case 'members_changed':
      refreshBoard(msg.id);
      break;
    case 'select': {
      if (msg.userId === api.user?.id) break;
      const nodeId = msg.nodeId == null ? null : Number(msg.nodeId);
      if (nodeId == null) store.selections.delete(msg.userId);
      else store.selections.set(msg.userId, nodeId);
      emit('selection');
      break;
    }
  }
}

function applyField(field) {
  const node = store.nodes.get(field.nodeId);
  if (!node) return;
  const idx = node.fields.findIndex(f => f.id === field.id);
  if (idx >= 0) node.fields[idx] = field;
  else node.fields.push(field);
  emit('nodes', 'update:' + field.nodeId);
}

function dropField(nodeId, fieldId) {
  const node = store.nodes.get(nodeId);
  if (!node) return;
  node.fields = node.fields.filter(f => f.id !== fieldId);
  emit('nodes', 'update:' + nodeId);
}

async function refreshBoard(id) {
  if (store.board?.board?.id !== id) return;
  try {
    store.board = await api.get(`/api/boards/${id}`);
    emit('board');
  } catch {}
}

/** Full resync after reconnect: refetch nodes to catch missed ops. */
export async function resync() {
  if (boardId == null) return;
  try {
    const nodes = await api.get(`/api/boards/${boardId}/nodes`);
    setNodes(nodes);
  } catch {}
}

/** Tell others which node I selected. */
export function sendSelect(nodeId) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'select', nodeId }));
  }
}
